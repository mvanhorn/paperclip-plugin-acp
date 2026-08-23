import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginHealthDiagnostics,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { getAgent, parseEnabledAgents } from "./agents.js";
import {
  createSession,
  getSession,
  closeSession,
  resolveBinding,
  updateSession,
  addSessionToThread,
  getThreadSessions,
  updateThreadSessionEntry,
} from "./session-manager.js";
import {
  spawnAgent,
  sendPrompt,
  cancelSession,
  killSession,
  getActiveSessionIds,
} from "./acp-spawn.js";
import {
  METRIC_NAMES,
  CHAT_PLATFORM_PLUGINS,
  OUTBOUND_EVENTS,
  ATTACHMENT_DEFAULTS,
  ATTACHMENT_METRIC_NAMES,
  WEBHOOK_EVENTS,
  DEFAULT_CONFIG,
} from "./constants.js";
import { computeReapReason, reapSessionIfDue } from "./reaper.js";
import {
  createAttachment,
  listAttachments,
} from "./attachment-manager.js";
import type {
  AcpConfig,
  AcpOutputEvent,
  AcpSessionMode,
  AcpSpawnEvent,
  AcpMessageCrossEvent,
  AcpCancelEvent,
  AcpCloseEvent,
  AcpSessionEntry,
  IssueStatusChangeEvent,
  SessionCompleteEvent,
  ApprovalRequiredEvent,
} from "./types.js";
import {
  applyCompanyConfig,
  getConfig,
  getConfigSequence,
  getRuntimeConfigState,
  isBootstrapped,
  recordBootstrapError,
  recordCompanyListingError,
  type ConfigSource,
} from "./runtime-config.js";
import {
  onIssueStatusChange,
  onSessionComplete,
  onApprovalRequired,
  closeWritePool,
  getCircuitBreakerStates,
  resetCircuitBreakers,
  resetActiveIssueSessions,
  getPoolStatus,
  resetRateLimitCooldown,
} from "./webhook-hooks.js";

/**
 * The context handed to `setup()`. `onConfigChanged` and `onHealth` receive no
 * context of their own, so the worker keeps this reference to reach the host
 * from those hooks.
 */
let workerCtx: PluginContext | null = null;

/** The agents enabled by the *current* configuration. */
function currentEnabledAgents(): ReturnType<typeof parseEnabledAgents> {
  return parseEnabledAgents(getConfig().enabledAgents ?? DEFAULT_CONFIG.enabledAgents);
}

/**
 * Adopt a company configuration and re-apply anything that was started with the
 * previous values. Idempotent, and safe to call from any hook.
 */
function adoptConfig(
  ctx: PluginContext,
  raw: unknown,
  opts: {
    companyId: string | null;
    source: ConfigSource;
    /** Sequence captured before an awaited host read; see `applyCompanyConfig`. */
    expectedSequence?: number;
  },
): boolean {
  const result = applyCompanyConfig(raw, opts);

  if (!result.applied) {
    if (result.skippedReason === "stale-snapshot") {
      // A newer configuration landed while our read was in flight. Dropping the
      // older snapshot keeps the most recent save authoritative.
      ctx.logger.info("Discarding a configuration read that resolved after a newer save", {
        companyId: opts.companyId,
        source: opts.source,
      });
    } else {
      ctx.logger.warn(
        "Ignoring config for a second company — this plugin runs a single company runtime",
        {
          runningCompanyId: result.companyId,
          ignoredCompanyId: opts.companyId,
          source: opts.source,
        },
      );
    }
    return false;
  }

  if (result.legacyUnscopedReplace) {
    // Hosts before v2026.817.0 call onConfigChanged with no company context, so
    // a second company's save is indistinguishable from a refresh of the running
    // one. Surface it rather than swapping the running company's settings mutely.
    ctx.logger.warn(
      "Applied a configuration delivered without a company scope over a company-owned config — " +
        "this host cannot identify the saving company, so it is treated as a single-tenant refresh",
      {
        runningCompanyId: result.companyId,
        source: opts.source,
      },
    );
  }

  const config = getConfig();
  ctx.logger.info("ACP configuration adopted", {
    companyId: result.companyId,
    source: opts.source,
    enabledAgents: config.enabledAgents,
    defaultAgent: config.defaultAgent,
    peakHourEnabled: config.peakHourEnabled,
    sharedPoolSize: config.sharedPoolSize,
  });

  if (result.reaperIntervalChanged) startReaper(ctx);
  return true;
}

/**
 * Adopt config from the first company-scoped invocation that reaches us, for
 * hosts that never deliver `onConfigChanged` before traffic starts. Best-effort
 * and never throws — a denied read leaves the worker on defaults.
 */
async function bootstrapFromInvocation(
  ctx: PluginContext,
  companyId: string | null | undefined,
): Promise<void> {
  if (!companyId || isBootstrapped()) return;
  // Captured before the await: if a save lands while this read is in flight the
  // sequence moves on and the stale snapshot is dropped rather than applied.
  const expectedSequence = getConfigSequence();
  try {
    const raw = await ctx.config.get(companyId);
    adoptConfig(ctx, raw, { companyId, source: "invocation", expectedSequence });
  } catch (err) {
    const message = recordBootstrapError(err);
    ctx.logger.debug("Company-scoped config read failed during invocation", {
      companyId,
      error: message,
    });
  }
}

/**
 * Hard ceiling on companies considered for ownership selection. Past this the
 * walk gives up selecting an owner entirely rather than guessing from a partial
 * set — the host still delivers configuration through `onConfigChanged`.
 */
const MAX_WALK_COMPANIES = 1000;

/**
 * How many companies the walk will probe with `config.get`, in globally sorted
 * order. Capping the probes cannot pick the wrong owner: the walk stops at the
 * first company whose config is readable, so with a true prefix of the globally
 * sorted set that company is exactly the one the host's replay would bind to.
 * Exhausting the cap simply means no owner is chosen here and the delivery path
 * takes over — a missed early bootstrap, never a divergent one.
 */
const MAX_WALK_PROBES = 25;

/**
 * Enumerate the COMPLETE set of company ids visible to the plugin, in one
 * request.
 *
 * Returns null when the set cannot be established — a listing error, or more
 * rows than the ceiling. A partial set is never returned: ownership must not be
 * chosen from an arbitrary subset (see `runStartupConfigWalk`).
 *
 * Deliberately NOT paginated. The host answers every `companies.list` call by
 * re-running an unordered query and slicing the fresh result
 * (`applyWindow(await companies.list(), params)`, over a query with no
 * `ORDER BY`), so two calls can order the rows differently: consecutive offset
 * windows may overlap, silently omit a company, and still end in a short page
 * that looks like the end of the data. Offset paging therefore cannot prove
 * completeness on this API. One request bounded at `MAX_WALK_COMPANIES + 1`
 * can: a full-size response means the ceiling was exceeded, and anything
 * smaller is the whole set as of that single query.
 */
async function listAllCompanyIds(ctx: PluginContext): Promise<string[] | null> {
  let rows: Array<{ id: string }>;
  try {
    rows = (await ctx.companies.list({
      limit: MAX_WALK_COMPANIES + 1,
      offset: 0,
    })) as Array<{ id: string }>;
  } catch (err) {
    // Recorded apart from config errors: a denied listing is not the host
    // refusing our configuration, and must not degrade health.
    const message = recordCompanyListingError(err);
    ctx.logger.info("Startup config walk could not list companies", { error: message });
    return null;
  }

  if (rows.length > MAX_WALK_COMPANIES) {
    ctx.logger.warn(
      "Too many companies to establish a startup configuration owner — skipping the walk; " +
        "the runtime starts when the host delivers configuration",
      { companiesSeen: rows.length, maxCompanies: MAX_WALK_COMPANIES },
    );
    return null;
  }

  const ids = new Set<string>();
  for (const company of rows) {
    if (typeof company?.id === "string" && company.id.length > 0) ids.add(company.id);
  }
  return [...ids];
}

/**
 * Best-effort startup walk: find the company whose configuration this worker
 * should adopt, and adopt it.
 *
 * The company must be the one the host would pick, because the SDK keeps its own
 * single-tenant guard: it binds to the first company the host replays, and the
 * host replays stored configs sorted by `companyId`
 * (`orderBy(asc(pluginConfig.companyId))` in its plugin-registry). If this
 * plugin bound to a different company, the SDK would reject our company's saves
 * before they reached the hook while the saves that did arrive would be ignored
 * as a second company's — the runtime would then be unreachable from both sides.
 *
 * `companies.list()` has no ordering contract, so no page of it can establish
 * that owner — the globally lowest configured company can sit anywhere, and the
 * host re-queries unordered on every call, which makes offset paging unable to
 * prove it saw everything. The walk therefore takes ONE bounded snapshot of the
 * whole company set, sorts it by id in byte order (matching the host's sort —
 * not `localeCompare`, whose collation would diverge), and only then probes for
 * a readable config. If the complete set cannot be established, no owner is
 * chosen at all.
 *
 * On hosts >= v2026.817.0 the host seeds proactive company scopes from stored
 * config rows, so this succeeds at worker boot. On v2026.720.0 / v2026.722.0
 * every read is denied and the worker stays on defaults until the host delivers
 * config through `onConfigChanged`. On hosts that do not grant `companies.read`
 * the listing itself fails. All three paths are non-fatal by construction.
 */
export async function runStartupConfigWalk(ctx: PluginContext): Promise<boolean> {
  if (isBootstrapped()) return true;

  const companyIds = await listAllCompanyIds(ctx);
  if (companyIds === null) return false;

  const ordered = companyIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const probes = ordered.slice(0, MAX_WALK_PROBES);

  for (const companyId of probes) {
    const expectedSequence = getConfigSequence();
    try {
      const raw = await ctx.config.get(companyId);
      if (
        adoptConfig(ctx, raw, {
          companyId,
          source: "startup-walk",
          expectedSequence,
        })
      ) {
        return true;
      }
      // A delivery beat us to it while this read was in flight: that config wins.
      if (isBootstrapped()) return true;
    } catch (err) {
      const message = recordBootstrapError(err);
      ctx.logger.debug("Startup config walk: config read denied", {
        companyId,
        error: message,
      });
    }
  }

  ctx.logger.info(
    "Startup config walk found no readable company config — running on defaults until the host delivers one",
    { companiesSeen: ordered.length, companiesProbed: probes.length },
  );
  return false;
}

// --- Session idle/max-age reaper --------------------------------------------
// The manifest advertises sessionIdleTimeoutMs and sessionMaxAgeMs, but without
// this loop neither was enforced — long-running workers could accumulate
// orphaned sessions indefinitely. The reaper scans active sessions every
// reaperIntervalMs and terminates any that are past idle or max-age thresholds.
// Sessions already in a terminal state are skipped to avoid racing with the
// normal close path.
//
// Thresholds are read from the live configuration on every tick, so a config
// that lands after startup takes effect without a worker restart. Only the
// interval itself needs the timer to be recreated.

let reaperHandle: ReturnType<typeof setInterval> | null = null;

// In-flight guard: between killSession (in-memory SIGTERM) and closeSession
// (async state write) there's a window where a second reaper tick could observe
// the session as still non-terminal and issue duplicate teardown. This set gates
// that window within a single process.
const reapingInFlight = new Set<string>();

async function runReaperTick(ctx: PluginContext): Promise<void> {
  const config = getConfig();
  const idleTimeoutMs = config.sessionIdleTimeoutMs ?? DEFAULT_CONFIG.sessionIdleTimeoutMs;
  const maxAgeMs = config.sessionMaxAgeMs ?? DEFAULT_CONFIG.sessionMaxAgeMs;
  const now = Date.now();

  for (const id of getActiveSessionIds()) {
    if (reapingInFlight.has(id)) continue;
    reapingInFlight.add(id);
    try {
      const sess = await getSession(ctx, id);
      if (!sess) continue;
      const reason = computeReapReason(now, sess, idleTimeoutMs, maxAgeMs);
      if (!reason) continue;
      ctx.logger.info("Reaping ACP session", {
        sessionId: id,
        reason,
        idleMs: now - (sess.lastActivityAt ?? sess.createdAt ?? 0),
        ageMs: now - (sess.createdAt ?? 0),
      });
      await reapSessionIfDue(ctx, id, {
        killSession,
        now,
        idleTimeoutMs,
        maxAgeMs,
      });
    } catch (err) {
      ctx.logger.error("Reaper iteration failed", {
        sessionId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      reapingInFlight.delete(id);
    }
  }
}

/** (Re)start the reaper with the interval from the live configuration. */
export function startReaper(ctx: PluginContext): void {
  stopReaper();
  const config = getConfig();
  const reaperIntervalMs = config.reaperIntervalMs ?? DEFAULT_CONFIG.reaperIntervalMs;
  reaperHandle = setInterval(() => {
    void runReaperTick(ctx);
  }, reaperIntervalMs);
  // Don't keep the event loop alive just for the reaper.
  reaperHandle.unref?.();
  ctx.logger.info("ACP reaper started", {
    idleTimeoutMs: config.sessionIdleTimeoutMs,
    maxAgeMs: config.sessionMaxAgeMs,
    reaperIntervalMs,
  });
}

/** Stop the reaper if it is running. */
export function stopReaper(): void {
  if (reaperHandle) {
    clearInterval(reaperHandle);
    reaperHandle = null;
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    workerCtx = ctx;

    // No config read here. Since Paperclip v2026.720.0 `config.get` requires a
    // company scope, and `setup()` runs outside any invocation, so an unscoped
    // read throws and would take down the whole worker before a single handler
    // is registered. Registration runs first on safe defaults; configuration is
    // adopted afterwards (startup walk / onConfigChanged / first invocation) and
    // every handler below reads it at dispatch time via `getConfig()`.
    ctx.logger.info("ACP plugin loading on built-in defaults", {
      enabledAgents: getConfig().enabledAgents,
    });

    // --- Cross-plugin event listeners ---
    // Each chat platform plugin emits events namespaced as:
    //   plugin.<platform-plugin-id>.acp-spawn
    //   plugin.<platform-plugin-id>.acp-message
    //   plugin.<platform-plugin-id>.acp-cancel
    //   plugin.<platform-plugin-id>.acp-close
    // We register listeners for all three platforms.

    for (const platformPlugin of CHAT_PLATFORM_PLUGINS) {
      // acp-spawn: create a new subprocess session for a thread
      ctx.events.on(
        `plugin.${platformPlugin}.acp-spawn` as `plugin.${string}`,
        async (rawEvent) => {
          const event = rawEvent.payload as unknown as AcpSpawnEvent;
          await bootstrapFromInvocation(ctx, event.companyId);
          await handleSpawn(ctx, getConfig(), currentEnabledAgents(), event, platformPlugin);
        },
      );

      // acp-message: route text to a specific session's stdin
      ctx.events.on(
        `plugin.${platformPlugin}.acp-message` as `plugin.${string}`,
        async (rawEvent) => {
          const event = rawEvent.payload as unknown as AcpMessageCrossEvent;
          await handleMessage(ctx, event);
        },
      );

      // acp-cancel: SIGINT to a specific session
      ctx.events.on(
        `plugin.${platformPlugin}.acp-cancel` as `plugin.${string}`,
        async (rawEvent) => {
          const event = rawEvent.payload as unknown as AcpCancelEvent;
          handleCancel(event);
        },
      );

      // acp-close: SIGTERM and remove a specific session
      ctx.events.on(
        `plugin.${platformPlugin}.acp-close` as `plugin.${string}`,
        async (rawEvent) => {
          const event = rawEvent.payload as unknown as AcpCloseEvent;
          await handleClose(ctx, event);
        },
      );

      ctx.logger.debug("Registered cross-plugin listeners", {
        platform: platformPlugin,
      });
    }

    // --- Webhook hook listeners ---
    // These replace polling in the heartbeat loop with event-driven hooks.

    ctx.events.on(
      WEBHOOK_EVENTS.issueStatusChange as `plugin.${string}`,
      async (rawEvent) => {
        const event = rawEvent.payload as unknown as IssueStatusChangeEvent;
        try {
          await bootstrapFromInvocation(ctx, event.companyId);
          await onIssueStatusChange(ctx, getConfig(), event);
        } catch (err) {
          ctx.logger.error("Webhook hook on_issue_status_change failed", {
            issueId: event.issueId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    ctx.events.on(
      WEBHOOK_EVENTS.sessionComplete as `plugin.${string}`,
      async (rawEvent) => {
        const event = rawEvent.payload as unknown as SessionCompleteEvent;
        try {
          await bootstrapFromInvocation(ctx, event.companyId);
          await onSessionComplete(ctx, event, getConfig());
        } catch (err) {
          ctx.logger.error("Webhook hook on_session_complete failed", {
            sessionId: event.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    ctx.events.on(
      WEBHOOK_EVENTS.approvalRequired as `plugin.${string}`,
      async (rawEvent) => {
        const event = rawEvent.payload as unknown as ApprovalRequiredEvent;
        try {
          await bootstrapFromInvocation(ctx, event.companyId);
          await onApprovalRequired(ctx, event);
        } catch (err) {
          ctx.logger.error("Webhook hook on_approval_required failed", {
            issueId: event.issueId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    ctx.logger.info("Registered webhook hook listeners", {
      events: Object.values(WEBHOOK_EVENTS),
    });

    // --- Tool handlers ---

    ctx.tools.register(
      "acp_spawn",
      {
        displayName: "Spawn ACP Agent",
        description: "Start a new ACP coding agent session.",
        parametersSchema: {
          type: "object",
          properties: {
            agent: { type: "string" },
            mode: { type: "string" },
            cwd: { type: "string" },
            prompt: { type: "string" },
          },
        },
      },
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        await bootstrapFromInvocation(ctx, runCtx.companyId);
        const config = getConfig();
        const enabledAgents = currentEnabledAgents();
        const p = params as Record<string, unknown>;
        const agentId = (p.agent as string) || config.defaultAgent;
        const mode = (p.mode as AcpSessionMode) || config.defaultMode;
        const cwd = (p.cwd as string) || config.defaultCwd;
        const initialPrompt = p.prompt as string | undefined;

        const agent = getAgent(agentId);
        if (!agent) {
          return {
            error: `Unknown agent: ${agentId}. Available: ${enabledAgents.map((a) => a.id).join(", ")}`,
          };
        }

        const enabled = enabledAgents.find((a) => a.id === agentId);
        if (!enabled) {
          return {
            error: `Agent ${agentId} is not enabled. Enabled: ${enabledAgents.map((a) => a.id).join(", ")}`,
          };
        }

        const session = await createSession(ctx, { agentId, mode, cwd });

        const outputHandler = (event: AcpOutputEvent) => {
          ctx.events.emit(OUTBOUND_EVENTS.output, runCtx.companyId, {
            ...event,
            platform: session.binding?.platform,
            threadId: session.binding?.threadId,
          });
        };

        await spawnAgent(ctx, session, outputHandler, initialPrompt);

        // In one-shot mode, `spawnAgent` already wrote the prompt to stdin and
        // closed it. In persistent mode we still need to send via sendPrompt.
        if (initialPrompt && session.mode !== "oneshot") {
          await sendPrompt(ctx, session.sessionId, initialPrompt);
        }

        return {
          data: {
            success: true,
            sessionId: session.sessionId,
            agent: agent.displayName,
            mode,
            cwd,
          },
        };
      },
    );

    ctx.tools.register(
      "acp_status",
      {
        displayName: "ACP Session Status",
        description: "List active ACP sessions and their state.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const activeIds = getActiveSessionIds();
        const sessions = [];

        for (const id of activeIds) {
          const session = await getSession(ctx, id);
          if (session) {
            sessions.push({
              sessionId: session.sessionId,
              agent: session.agentId,
              mode: session.mode,
              state: session.state,
              cwd: session.cwd,
              uptime: Math.round((Date.now() - session.createdAt) / 1000),
              idleFor: Math.round((Date.now() - session.lastActivityAt) / 1000),
              binding: session.binding
                ? `${session.binding.platform}:${session.binding.threadId}`
                : null,
            });
          }
        }

        return { data: { activeSessions: sessions.length, sessions } };
      },
    );

    ctx.tools.register(
      "acp_send",
      {
        displayName: "Send to ACP Session",
        description: "Send a prompt to an active ACP session.",
        parametersSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            text: { type: "string" },
          },
          required: ["sessionId", "text"],
        },
      },
      async (params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const sessionId = p.sessionId as string;
        const text = p.text as string;

        if (!sessionId || !text) {
          return { error: "sessionId and text are required" };
        }

        const sent = await sendPrompt(ctx, sessionId, text);
        return { data: { success: sent } };
      },
    );

    ctx.tools.register(
      "acp_cancel",
      {
        displayName: "Cancel ACP Session",
        description: "Cancel the current turn in an ACP session.",
        parametersSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
          },
          required: ["sessionId"],
        },
      },
      async (params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const sessionId = p.sessionId as string;
        const cancelled = cancelSession(sessionId);
        return { data: { success: cancelled } };
      },
    );

    ctx.tools.register(
      "acp_close",
      {
        displayName: "Close ACP Session",
        description: "Close an ACP session and remove thread bindings.",
        parametersSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
          },
          required: ["sessionId"],
        },
      },
      async (params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const sessionId = p.sessionId as string;
        killSession(sessionId);
        await closeSession(ctx, sessionId);
        return { data: { success: true } };
      },
    );

    // Fetch the aggregated stdout and exit code of a one-shot session after
    // the child process has terminated. Returns the session state so callers
    // can detect still-running or missing sessions without polling acp_status.
    ctx.tools.register(
      "acp_result",
      {
        displayName: "Get ACP Session Result",
        description:
          "Retrieve the final stdout, exit code and state for a one-shot ACP session that has completed.",
        parametersSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
          },
          required: ["sessionId"],
        },
      },
      async (params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const sessionId = p.sessionId as string;
        if (!sessionId) return { error: "sessionId is required" };
        const session = await getSession(ctx, sessionId);
        if (!session) return { error: `Session not found: ${sessionId}` };
        return {
          data: {
            sessionId,
            state: session.state,
            mode: session.mode,
            exitCode: session.exitCode ?? null,
            output: session.finalOutput ?? null,
          },
        };
      },
    );

    // --- Attachment tool handlers ---

    ctx.tools.register(
      "acp_attach",
      {
        displayName: "Attach File to Issue",
        description:
          "Upload a file attachment to an issue. Content must be base64-encoded.",
        parametersSchema: {
          type: "object",
          properties: {
            issueId: { type: "string" },
            filename: { type: "string" },
            content: { type: "string" },
            mimeType: { type: "string" },
          },
          required: ["issueId", "filename", "content"],
        },
      },
      async (params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const issueId = p.issueId as string;
        const filename = p.filename as string;
        const content = p.content as string;
        const mimeType = p.mimeType as string | undefined;

        if (!issueId || !filename || !content) {
          return { error: "issueId, filename, and content are required" };
        }

        try {
          const result = await createAttachment(
            ctx,
            { issueId, filename, content, mimeType },
            ATTACHMENT_DEFAULTS.storageDir,
          );
          return { data: { success: true, attachment: result } };
        } catch (err) {
          ctx.logger.error("Failed to create attachment", {
            issueId,
            filename,
            error: String(err),
          });
          await ctx.metrics.write(ATTACHMENT_METRIC_NAMES.attachmentErrors, 1);
          return {
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    );

    ctx.tools.register(
      "acp_attachments",
      {
        displayName: "List Issue Attachments",
        description: "List all file attachments for a given issue.",
        parametersSchema: {
          type: "object",
          properties: {
            issueId: { type: "string" },
          },
          required: ["issueId"],
        },
      },
      async (params: unknown, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = params as Record<string, unknown>;
        const issueId = p.issueId as string;

        if (!issueId) {
          return { error: "issueId is required" };
        }

        try {
          const attachments = await listAttachments(ctx, issueId);
          return {
            data: {
              issueId,
              count: attachments.length,
              attachments,
            },
          };
        } catch (err) {
          ctx.logger.error("Failed to list attachments", {
            issueId,
            error: String(err),
          });
          await ctx.metrics.write(ATTACHMENT_METRIC_NAMES.attachmentErrors, 1);
          return {
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    );

    // --- Session idle/max-age reaper ---
    // Started on the current configuration; thresholds are re-read on every
    // tick and the timer is recreated if a later config changes the interval.
    startReaper(ctx);

    // --- Cleanup on plugin shutdown ---

    ctx.events.on("plugin.stopping" as `plugin.${string}`, async () => {
      stopReaper();
      const activeIds = getActiveSessionIds();
      for (const id of activeIds) {
        killSession(id);
        await closeSession(ctx, id);
      }
      await closeWritePool();
      resetCircuitBreakers();
      resetActiveIssueSessions();
      resetRateLimitCooldown();
      ctx.logger.info("ACP plugin stopped, cleaned up sessions", {
        count: activeIds.length,
      });
    });

    ctx.logger.info("ACP runtime plugin started", {
      agents: currentEnabledAgents().map((a) => a.id),
      listeningTo: CHAT_PLATFORM_PLUGINS as unknown as string[],
    });

    // Every handler is registered by this point, so the walk can only improve
    // the configuration — it can never prevent the plugin from activating.
    await runStartupConfigWalk(ctx);
  },

  /**
   * The host delivers stored configuration here at startup and on every save,
   * with the company scope attached. This is the path that bootstraps the
   * runtime on hosts (v2026.720.0 / v2026.722.0) where a worker-initiated
   * `config.get` is denied for every company.
   */
  async onConfigChanged(newConfig, context) {
    const ctx = workerCtx;
    if (!ctx) return;
    adoptConfig(ctx, newConfig, {
      companyId: context?.companyId ?? null,
      source: "config-changed",
    });
  },

  async onValidateConfig(config) {
    const c = config as Record<string, unknown>;
    if (c.defaultMode && c.defaultMode !== "persistent" && c.defaultMode !== "oneshot") {
      return {
        ok: false,
        errors: ["defaultMode must be 'persistent' or 'oneshot'"],
      };
    }
    if (c.maxSessionsPerThread != null) {
      const max = Number(c.maxSessionsPerThread);
      if (!Number.isFinite(max) || max < 1 || max > 20) {
        return {
          ok: false,
          errors: ["maxSessionsPerThread must be between 1 and 20"],
        };
      }
    }
    return { ok: true };
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const activeCount = getActiveSessionIds().length;
    const circuitBreakers = getCircuitBreakerStates();
    const anyCircuitOpen = Object.values(circuitBreakers).some((cb) => cb.isOpen);
    const runtime = getRuntimeConfigState();

    // Phase 2: Include pool status and peak-hour state. Uses the live
    // configuration, which is the built-in defaults until a company config has
    // been adopted.
    let poolStatus = null;
    try {
      poolStatus = await getPoolStatus(getConfig());
    } catch {
      // Non-fatal: pool status is best-effort
    }

    // The ACP runtime is functional on defaults — every config field is tuning,
    // there is no credential to resolve — so a worker without a company config
    // is reported as `ok` with its provenance, not as broken. It degrades only
    // when a company config was expected but the host refused to hand one over
    // (the v2026.720.0 / v2026.722.0 gate), so operators see the real host
    // message instead of silence, and when a circuit breaker is open.
    //
    // A failed `companies.list()` is NOT such a refusal: the listing is an
    // optional convenience for the startup walk, and the host delivers config
    // through `onConfigChanged` whether or not the plugin can enumerate
    // companies. It is reported in the details and never in the status.
    const configDenied = !runtime.bootstrapped && runtime.lastBootstrapError !== null;

    return {
      status: anyCircuitOpen || configDenied ? "degraded" : "ok",
      message: configDenied
        ? `Running on default configuration: ${runtime.lastBootstrapError}`
        : undefined,
      details: {
        activeSessions: activeCount,
        circuitBreakers,
        poolStatus,
        configSource: runtime.configSource,
        configCompanyId: runtime.companyId,
        configBootstrapped: runtime.bootstrapped,
        lastConfigError: runtime.lastBootstrapError,
        lastCompanyListingError: runtime.lastCompanyListingError,
      },
    };
  },
});

// --- Cross-plugin event handlers ---

async function handleSpawn(
  ctx: PluginContext,
  config: AcpConfig,
  enabledAgents: ReturnType<typeof parseEnabledAgents>,
  event: AcpSpawnEvent,
  sourcePlatform: string,
): Promise<void> {
  const agentId = event.agentName || config.defaultAgent;
  const mode = event.mode || config.defaultMode;
  const cwd = event.cwd || config.defaultCwd;
  const companyId = event.companyId;

  ctx.logger.info("Cross-plugin acp-spawn received", {
    agentId,
    chatId: event.chatId,
    threadId: event.threadId,
    source: sourcePlatform,
  });

  const agent = getAgent(agentId);
  if (!agent) {
    ctx.events.emit(OUTBOUND_EVENTS.output, companyId, {
      sessionId: null,
      type: "error",
      error: `Unknown agent: ${agentId}. Available: ${enabledAgents.map((a) => a.id).join(", ")}`,
    });
    return;
  }

  const enabled = enabledAgents.find((a) => a.id === agentId);
  if (!enabled) {
    ctx.events.emit(OUTBOUND_EVENTS.output, companyId, {
      sessionId: null,
      type: "error",
      error: `Agent ${agentId} is not enabled.`,
    });
    return;
  }

  // Create the session with a binding to the thread
  const binding = {
    platform: sourcePlatform.replace("paperclip-plugin-", ""),
    threadId: event.threadId,
    channelId: event.chatId,
    boundAt: Date.now(),
  };

  const session = await createSession(ctx, {
    sessionId: event.sessionId,
    agentId,
    mode,
    cwd,
    binding,
  });

  // Build the thread session entry
  const entry: AcpSessionEntry = {
    sessionId: session.sessionId,
    agentName: agentId,
    agentDisplayName: agent.displayName,
    spawnedAt: Date.now(),
    status: "spawning",
  };

  // Add to thread's 1:N sessions array (enforces cap)
  const result = await addSessionToThread(
    ctx,
    event.chatId,
    event.threadId,
    entry,
    config.maxSessionsPerThread,
  );

  if (!result.added) {
    await updateSession(ctx, session.sessionId, { state: "error" });
    ctx.events.emit(OUTBOUND_EVENTS.output, companyId, {
      sessionId: session.sessionId,
      type: "error",
      error: result.error,
    });
    return;
  }

  // Output handler emits namespaced events with companyId
  const outputHandler = (outputEvent: AcpOutputEvent) => {
    ctx.events.emit(OUTBOUND_EVENTS.output, companyId, {
      ...outputEvent,
      chatId: event.chatId,
      threadId: event.threadId,
    });

    // Keep thread session entry status in sync
    if (outputEvent.type === "done" || outputEvent.type === "error") {
      const newStatus = outputEvent.type === "done" ? "closed" : "error";
      updateThreadSessionEntry(
        ctx,
        event.chatId,
        event.threadId,
        session.sessionId,
        { status: newStatus as AcpSessionEntry["status"] },
      ).catch(() => {});
    }
  };

  await spawnAgent(ctx, session, outputHandler);

  // Update the thread entry with PID
  const refreshed = await getSession(ctx, session.sessionId);
  if (refreshed?.pid) {
    await updateThreadSessionEntry(
      ctx,
      event.chatId,
      event.threadId,
      session.sessionId,
      { status: "active", pid: refreshed.pid },
    );
  }
}

async function handleMessage(
  ctx: PluginContext,
  event: AcpMessageCrossEvent,
): Promise<void> {
  ctx.logger.info("Cross-plugin acp-message received", {
    sessionId: event.sessionId,
    textLength: event.text?.length,
  });

  const sent = await sendPrompt(ctx, event.sessionId, event.text);
  if (!sent) {
    ctx.logger.warn("Failed to route message to session", {
      sessionId: event.sessionId,
    });
  }
}

function handleCancel(event: AcpCancelEvent): void {
  cancelSession(event.sessionId);
}

async function handleClose(
  ctx: PluginContext,
  event: AcpCloseEvent,
): Promise<void> {
  ctx.logger.info("Cross-plugin acp-close received", {
    sessionId: event.sessionId,
  });

  killSession(event.sessionId);
  await closeSession(ctx, event.sessionId);
}

runWorker(plugin, import.meta.url);

export default plugin;
