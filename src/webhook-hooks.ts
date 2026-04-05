/**
 * ACP Webhook Hooks — event-driven bridges from Paperclip state to Claude Code execution.
 *
 * Three hooks replace polling in the heartbeat loop:
 *
 * 1. on_issue_status_change  → Spawn a Claude Code session when a ticket moves to a trigger
 *                              status (`todo` in v2, with `in_progress` kept for compat).
 *                              Auto-transitions issue to `in_progress` after spawn to prevent
 *                              double-pickup by the cron fallback.
 * 2. on_session_complete     → Write a performance record to PostgreSQL and update Paperclip issue status.
 * 3. on_approval_required    → Surface a Chairman approval request to the Cockpit via event emission.
 *
 * v2 additions (PLA-14):
 * - Dedup guard: prevents re-spawning if a session is already active for the same issue.
 * - Auto-transition: moves issue from `todo` → `in_progress` immediately after spawn.
 * - Circuit breaker: tracks consecutive failures per company; trips after 3, with 10-min cooldown.
 *
 * Each hook validates its payload, performs side effects, writes metrics, and emits follow-up events.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  createSession,
  updateSession,
} from "./session-manager.js";
import { spawnAgent, getActiveSessionIds } from "./acp-spawn.js";
import { getAgent, parseEnabledAgents } from "./agents.js";
import {
  WEBHOOK_METRIC_NAMES,
  WEBHOOK_OUTBOUND_EVENTS,
  PAPERCLIP_API_BASE,
  NEXUS_METRICS_DB,
  SPAWN_TRIGGER_STATUSES,
  METRIC_NAMES,
  WEBHOOK_CIRCUIT_BREAKER_THRESHOLD,
  WEBHOOK_CIRCUIT_BREAKER_COOLDOWN_MS,
} from "./constants.js";
import type {
  IssueStatusChangeEvent,
  SessionCompleteEvent,
  ApprovalRequiredEvent,
  PerformanceRecord,
  AcpOutputEvent,
  AcpSessionMode,
  PaperclipIssueStatus,
  WebhookCircuitBreakerState,
} from "./types.js";

// ── Shared config type (mirrors worker's AcpConfig) ────────────────────────

type WebhookHookConfig = {
  defaultAgent: string;
  defaultMode: AcpSessionMode;
  defaultCwd: string;
  enabledAgents: string;
};

// ── Database helper (lazy connection) ──────────────────────────────────────

let _pgPool: import("pg").Pool | null = null;

async function getWritePool(): Promise<import("pg").Pool> {
  if (_pgPool) return _pgPool;

  // Dynamic import so pg is only loaded when actually needed
  const { Pool } = await import("pg");
  _pgPool = new Pool({
    connectionString: NEXUS_METRICS_DB,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  _pgPool.on("error", (err) => {
    console.error("[webhook-hooks] Pool error:", err.message);
  });

  return _pgPool;
}

/**
 * Gracefully close the write pool (called on plugin shutdown).
 */
export async function closeWritePool(): Promise<void> {
  if (_pgPool) {
    await _pgPool.end();
    _pgPool = null;
  }
}

// ── Paperclip API helper ───────────────────────────────────────────────────

async function paperclipPatch(
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const url = `${PAPERCLIP_API_BASE}${path}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Paperclip PATCH ${res.status}: ${text.slice(0, 300)}`);
  }
}

async function paperclipPost(
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const url = `${PAPERCLIP_API_BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Paperclip POST ${res.status}: ${text.slice(0, 300)}`);
  }
}

// ── Circuit breaker (per-company) ─────────────────────────────────────────

/**
 * In-memory circuit breaker state keyed by companyId.
 * Tracks consecutive spawn failures to prevent runaway retries.
 */
const _circuitBreakers = new Map<string, WebhookCircuitBreakerState>();

/**
 * Get (or initialise) circuit breaker state for a company.
 */
export function getCircuitBreaker(companyId: string): WebhookCircuitBreakerState {
  let cb = _circuitBreakers.get(companyId);
  if (!cb) {
    cb = { consecutiveFailures: 0, trippedAt: null, isOpen: false };
    _circuitBreakers.set(companyId, cb);
  }
  return cb;
}

/**
 * Record a spawn success — resets the circuit breaker for the company.
 */
export function recordSpawnSuccess(companyId: string): void {
  _circuitBreakers.set(companyId, {
    consecutiveFailures: 0,
    trippedAt: null,
    isOpen: false,
  });
}

/**
 * Record a spawn failure — increments the failure counter and trips if threshold is met.
 */
export function recordSpawnFailure(companyId: string): WebhookCircuitBreakerState {
  const cb = getCircuitBreaker(companyId);
  cb.consecutiveFailures += 1;
  if (cb.consecutiveFailures >= WEBHOOK_CIRCUIT_BREAKER_THRESHOLD) {
    cb.isOpen = true;
    cb.trippedAt = Date.now();
  }
  _circuitBreakers.set(companyId, cb);
  return cb;
}

/**
 * Check whether the circuit is currently open for a company.
 * Auto-resets if the cooldown period has elapsed.
 */
export function isCircuitOpen(companyId: string): boolean {
  const cb = getCircuitBreaker(companyId);
  if (!cb.isOpen) return false;

  // Auto-reset after cooldown
  if (cb.trippedAt && Date.now() - cb.trippedAt >= WEBHOOK_CIRCUIT_BREAKER_COOLDOWN_MS) {
    cb.isOpen = false;
    cb.consecutiveFailures = 0;
    cb.trippedAt = null;
    _circuitBreakers.set(companyId, cb);
    return false;
  }

  return true;
}

/**
 * Return a snapshot of all circuit breaker states (for health diagnostics).
 */
export function getCircuitBreakerStates(): Record<string, WebhookCircuitBreakerState> {
  const result: Record<string, WebhookCircuitBreakerState> = {};
  for (const [k, v] of _circuitBreakers) {
    result[k] = { ...v };
  }
  return result;
}

/**
 * Reset all circuit breakers (used in tests / plugin restart).
 */
export function resetCircuitBreakers(): void {
  _circuitBreakers.clear();
}

// ── Dedup guard (per-issue active sessions) ───────────────────────────────

/**
 * In-memory set of issue IDs that currently have an active webhook-spawned session.
 * Prevents double-spawn when a webhook fires while a session is still running.
 */
const _activeIssueSessionIds = new Map<string, string>(); // issueId → sessionId

/**
 * Check whether an issue already has an active webhook-spawned session.
 */
export function hasActiveSession(issueId: string): boolean {
  const sessionId = _activeIssueSessionIds.get(issueId);
  if (!sessionId) return false;

  // Verify the session is still alive in the spawn process table
  const activeIds = getActiveSessionIds();
  if (activeIds.includes(sessionId)) return true;

  // Session is no longer active — clean up stale entry
  _activeIssueSessionIds.delete(issueId);
  return false;
}

/**
 * Track that an issue now has an active webhook-spawned session.
 */
export function trackIssueSession(issueId: string, sessionId: string): void {
  _activeIssueSessionIds.set(issueId, sessionId);
}

/**
 * Remove an issue from the active tracking (called on session complete).
 */
export function untrackIssueSession(issueId: string): void {
  _activeIssueSessionIds.delete(issueId);
}

/**
 * Reset all dedup tracking (used in tests / plugin restart).
 */
export function resetActiveIssueSessions(): void {
  _activeIssueSessionIds.clear();
}

// ── Hook 1: on_issue_status_change ─────────────────────────────────────────

/**
 * Handle an issue status change webhook.
 *
 * v2: When an issue transitions to `todo` (or `in_progress` for compat),
 * spawns a Claude Code session for that ticket and immediately transitions
 * the issue to `in_progress` to prevent double-pickup by the cron fallback.
 *
 * Guards:
 * - Dedup: skips if the issue already has an active session.
 * - Circuit breaker: skips if the company has tripped its failure threshold.
 * - No-op: skips if previousStatus === newStatus.
 *
 * Returns the spawned session ID, or null if no session was spawned.
 */
export async function onIssueStatusChange(
  ctx: PluginContext,
  config: WebhookHookConfig,
  event: IssueStatusChangeEvent,
): Promise<{ sessionId: string | null; spawned: boolean }> {
  ctx.logger.info("Webhook: issue status change", {
    issueId: event.issueId,
    from: event.previousStatus,
    to: event.newStatus,
  });

  await ctx.metrics.write(WEBHOOK_METRIC_NAMES.issueStatusChangeReceived, 1);

  // Only spawn when transitioning to a trigger status
  const shouldSpawn = (SPAWN_TRIGGER_STATUSES as readonly string[]).includes(
    event.newStatus,
  );
  if (!shouldSpawn) {
    ctx.logger.debug("Status change does not trigger spawn", {
      newStatus: event.newStatus,
    });
    return { sessionId: null, spawned: false };
  }

  // Prevent re-spawn if the status hasn't actually changed
  if (event.previousStatus === event.newStatus) {
    ctx.logger.debug("No-op: status unchanged", {
      status: event.newStatus,
    });
    return { sessionId: null, spawned: false };
  }

  // v2 dedup guard: skip if a session is already running for this issue
  if (hasActiveSession(event.issueId)) {
    ctx.logger.info("Webhook: dedup — session already active for issue", {
      issueId: event.issueId,
    });
    await ctx.metrics.write(WEBHOOK_METRIC_NAMES.issueStatusChangeDeduplicated, 1);
    return { sessionId: null, spawned: false };
  }

  // v2 circuit breaker: skip if the company's circuit is open
  if (isCircuitOpen(event.companyId)) {
    ctx.logger.warn("Webhook: circuit breaker open for company — skipping spawn", {
      companyId: event.companyId,
      circuitBreaker: getCircuitBreaker(event.companyId),
    });
    await ctx.metrics.write(WEBHOOK_METRIC_NAMES.issueStatusChangeCircuitOpen, 1);
    return { sessionId: null, spawned: false };
  }

  try {
    const agentId = config.defaultAgent;
    const enabledAgents = parseEnabledAgents(config.enabledAgents);
    const agent = getAgent(agentId);

    if (!agent) {
      throw new Error(
        `Default agent "${agentId}" not found. Available: ${enabledAgents.map((a) => a.id).join(", ")}`,
      );
    }

    const enabled = enabledAgents.find((a) => a.id === agentId);
    if (!enabled) {
      throw new Error(`Agent "${agentId}" is not enabled.`);
    }

    const cwd = event.cwd || config.defaultCwd;

    // Create a session bound to the issue (no chat thread binding)
    const session = await createSession(ctx, {
      agentId,
      mode: config.defaultMode,
      cwd,
    });

    // Build a prompt from the issue context
    const prompt = buildTicketPrompt(event);

    // Output handler logs events but doesn't route to a chat platform
    const outputHandler = (outputEvent: AcpOutputEvent) => {
      ctx.events.emit("webhook.session.output", event.companyId, {
        ...outputEvent,
        issueId: event.issueId,
      });
    };

    await spawnAgent(ctx, session, outputHandler);

    // Send the initial prompt to the spawned agent
    const { sendPrompt } = await import("./acp-spawn.js");
    await sendPrompt(ctx, session.sessionId, prompt);

    // v2: Track the issue→session mapping for dedup
    trackIssueSession(event.issueId, session.sessionId);

    // v2: Auto-transition issue from `todo` → `in_progress` so the cron
    // fallback doesn't double-pick this ticket.
    if (event.newStatus === "todo") {
      await paperclipPatch(`/issues/${event.issueId}`, { status: "in_progress" });
      ctx.logger.info("Webhook: auto-transitioned issue to in_progress", {
        issueId: event.issueId,
      });
    }

    // v2: Record success to reset circuit breaker
    recordSpawnSuccess(event.companyId);

    await ctx.metrics.write(WEBHOOK_METRIC_NAMES.issueStatusChangeSpawned, 1);

    ctx.logger.info("Webhook: spawned session for ticket", {
      issueId: event.issueId,
      sessionId: session.sessionId,
      agent: agentId,
    });

    return { sessionId: session.sessionId, spawned: true };
  } catch (err) {
    // v2: Record failure in circuit breaker
    const cbState = recordSpawnFailure(event.companyId);
    if (cbState.isOpen) {
      ctx.logger.error("Webhook: circuit breaker tripped for company", {
        companyId: event.companyId,
        consecutiveFailures: cbState.consecutiveFailures,
      });
    }

    await ctx.metrics.write(WEBHOOK_METRIC_NAMES.issueStatusChangeErrors, 1);
    ctx.logger.error("Webhook: failed to handle issue status change", {
      issueId: event.issueId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Build a prompt string from issue metadata for the spawned agent.
 */
function buildTicketPrompt(event: IssueStatusChangeEvent): string {
  const parts = [
    `# Ticket: ${event.title}`,
    "",
    `**Issue ID:** ${event.issueId}`,
    `**Priority:** ${event.priority}`,
  ];
  if (event.labels && event.labels.length > 0) {
    parts.push(`**Labels:** ${event.labels.join(", ")}`);
  }
  parts.push("", "## Description", "", event.description);
  return parts.join("\n");
}

// ── Hook 2: on_session_complete ────────────────────────────────────────────

/**
 * Handle a session completion webhook.
 *
 * 1. Write a performance record to the `performance_records` table in PostgreSQL.
 * 2. Update the Paperclip issue status to reflect completion.
 * 3. Emit a `performance.recorded` event for downstream consumers.
 */
export async function onSessionComplete(
  ctx: PluginContext,
  event: SessionCompleteEvent,
): Promise<{ recorded: boolean; statusUpdated: boolean }> {
  ctx.logger.info("Webhook: session complete", {
    sessionId: event.sessionId,
    issueId: event.issueId,
    success: event.success,
  });

  await ctx.metrics.write(WEBHOOK_METRIC_NAMES.sessionCompleteReceived, 1);

  let recorded = false;
  let statusUpdated = false;

  try {
    // 1. Write performance record to PostgreSQL
    const record = buildPerformanceRecord(event);
    await writePerformanceRecord(ctx, record);
    recorded = true;

    await ctx.metrics.write(WEBHOOK_METRIC_NAMES.sessionCompleteRecorded, 1);

    ctx.logger.info("Webhook: performance record written", {
      sessionId: event.sessionId,
      issueId: event.issueId,
    });

    // 2. Update the Paperclip issue status
    const targetStatus = event.targetStatus ?? (event.success ? "in_review" : "in_progress");
    await updateIssueStatus(ctx, event.issueId, targetStatus, event.summary);
    statusUpdated = true;

    ctx.logger.info("Webhook: issue status updated", {
      issueId: event.issueId,
      targetStatus,
    });

    // 3. Emit performance.recorded event
    ctx.events.emit(WEBHOOK_OUTBOUND_EVENTS.performanceRecorded, event.companyId, {
      sessionId: event.sessionId,
      issueId: event.issueId,
      success: event.success,
      durationMs: event.durationMs,
    });

    // 4. Update the internal session state
    await updateSession(ctx, event.sessionId, {
      state: event.success ? "closed" : "error",
    });

    // 5. v2: Remove issue from dedup tracking so future webhooks can spawn
    untrackIssueSession(event.issueId);

    return { recorded, statusUpdated };
  } catch (err) {
    await ctx.metrics.write(WEBHOOK_METRIC_NAMES.sessionCompleteErrors, 1);
    ctx.logger.error("Webhook: failed to handle session complete", {
      sessionId: event.sessionId,
      issueId: event.issueId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Build a PerformanceRecord from a SessionCompleteEvent.
 */
function buildPerformanceRecord(event: SessionCompleteEvent): PerformanceRecord {
  const now = new Date().toISOString();
  return {
    session_id: event.sessionId,
    issue_id: event.issueId,
    company_id: event.companyId,
    agent_id: event.agentId,
    exit_code: event.exitCode,
    duration_ms: event.durationMs,
    prompt_count: event.promptCount,
    tool_call_count: event.toolCallCount,
    success: event.success,
    summary: event.summary ?? null,
    completed_at: new Date(event.completedAt).toISOString(),
    recorded_at: now,
  };
}

/**
 * Insert a performance record into the PostgreSQL performance_records table.
 */
async function writePerformanceRecord(
  ctx: PluginContext,
  record: PerformanceRecord,
): Promise<void> {
  const pool = await getWritePool();
  const client = await pool.connect();

  try {
    await client.query(
      `INSERT INTO performance_records (
        session_id, issue_id, company_id, agent_id,
        exit_code, duration_ms, prompt_count, tool_call_count,
        success, summary, completed_at, recorded_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.session_id,
        record.issue_id,
        record.company_id,
        record.agent_id,
        record.exit_code,
        record.duration_ms,
        record.prompt_count,
        record.tool_call_count,
        record.success,
        record.summary,
        record.completed_at,
        record.recorded_at,
      ],
    );
  } finally {
    client.release();
  }
}

/**
 * Update a Paperclip issue status via the API, with an optional comment.
 */
async function updateIssueStatus(
  ctx: PluginContext,
  issueId: string,
  status: PaperclipIssueStatus,
  summary?: string,
): Promise<void> {
  await paperclipPatch(`/issues/${issueId}`, { status });

  if (summary) {
    await paperclipPost(`/issues/${issueId}/comments`, {
      body: `**Session Complete:** ${summary}`,
      author: "acp-plugin",
    });
  }
}

// ── Hook 3: on_approval_required ───────────────────────────────────────────

/**
 * Handle an approval required webhook.
 *
 * Surfaces the approval request to the Cockpit by:
 * 1. Setting the Paperclip issue status to `in_review` (AWAITING_CHAIRMAN).
 * 2. Posting a comment explaining the approval request.
 * 3. Emitting a `cockpit.approval_request` event for the WebSocket server to broadcast.
 */
export async function onApprovalRequired(
  ctx: PluginContext,
  event: ApprovalRequiredEvent,
): Promise<{ surfaced: boolean }> {
  ctx.logger.info("Webhook: approval required", {
    issueId: event.issueId,
    requestedBy: event.requestedBy,
  });

  await ctx.metrics.write(WEBHOOK_METRIC_NAMES.approvalRequiredReceived, 1);

  try {
    // 1. Update issue status to in_review (maps to AWAITING_CHAIRMAN in Cockpit)
    await paperclipPatch(`/issues/${event.issueId}`, {
      status: "in_review",
    });

    // 2. Post approval request comment
    const commentBody = buildApprovalComment(event);
    await paperclipPost(`/issues/${event.issueId}/comments`, {
      body: commentBody,
      author: event.requestedBy,
    });

    // 3. Emit event for Cockpit WebSocket broadcast
    ctx.events.emit(
      WEBHOOK_OUTBOUND_EVENTS.approvalRequest,
      event.companyId,
      {
        issueId: event.issueId,
        title: event.title,
        priority: event.priority,
        requestedBy: event.requestedBy,
        requestedAt: event.requestedAt,
        deliberationSummary: event.deliberationSummary ?? null,
      },
    );

    await ctx.metrics.write(WEBHOOK_METRIC_NAMES.approvalRequiredSurfaced, 1);

    ctx.logger.info("Webhook: approval request surfaced to Cockpit", {
      issueId: event.issueId,
    });

    return { surfaced: true };
  } catch (err) {
    await ctx.metrics.write(WEBHOOK_METRIC_NAMES.approvalRequiredErrors, 1);
    ctx.logger.error("Webhook: failed to surface approval request", {
      issueId: event.issueId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Build the comment body for an approval request.
 */
function buildApprovalComment(event: ApprovalRequiredEvent): string {
  const parts = [
    `**Approval Required** — Requested by ${event.requestedBy}`,
    "",
    `**Priority:** ${event.priority}`,
  ];

  if (event.deliberationSummary) {
    parts.push("", "**Deliberation Summary:**", event.deliberationSummary);
  }

  parts.push(
    "",
    "_This issue requires Chairman approval before proceeding. Please review in the Cockpit._",
  );

  return parts.join("\n");
}
