export const PLUGIN_ID = "paperclip-plugin-acp";
export const PLUGIN_VERSION = "0.3.0";

export const DEFAULT_CONFIG = {
  enabledAgents: "claude,codex,gemini,opencode",
  defaultAgent: "claude",
  defaultMode: "persistent" as const,
  defaultCwd: "/workspace",
  sessionIdleTimeoutMs: 30 * 60 * 1000, // 30 minutes
  sessionMaxAgeMs: 8 * 60 * 60 * 1000, // 8 hours
  maxSessionsPerThread: 5,
  // How often the idle/max-age reaper scans active sessions.
  reaperIntervalMs: 60 * 1000, // 1 minute
  // TTL for orphaned plugin_state rows for sessions that no longer have an
  // in-process entry (e.g. after a worker restart). Scaffolded for a future
  // SDK state.list-driven cross-restart purge — no consumer yet.
  sessionRowTtlDays: 30,
};

export const METRIC_NAMES = {
  sessionsSpawned: "acp.sessions.spawned",
  sessionsActive: "acp.sessions.active",
  sessionsClosed: "acp.sessions.closed",
  sessionsReaped: "acp.sessions.reaped",
  promptsSent: "acp.prompts.sent",
  outputsReceived: "acp.outputs.received",
  spawnErrors: "acp.spawn.errors",
};

/** Chat platform plugin IDs that emit acp-* events */
export const CHAT_PLATFORM_PLUGINS = [
  "paperclip-plugin-telegram",
  "paperclip-plugin-slack",
  "paperclip-plugin-discord",
] as const;

/** Event names emitted by chat plugins that the ACP plugin listens to */
export const INBOUND_EVENT_SUFFIXES = [
  "acp-spawn",
  "acp-message",
  "acp-cancel",
  "acp-close",
] as const;

/** Event names emitted by the ACP plugin */
export const OUTBOUND_EVENTS = {
  output: "output",
} as const;

// --- Attachment constants ---

export const ATTACHMENT_DEFAULTS = {
  storageDir: "/tmp/paperclip-attachments",
  maxFileSizeBytes: 25 * 1024 * 1024, // 25 MB
  maxAttachmentsPerIssue: 50,
} as const;

export const ATTACHMENT_STATE_PREFIX = "acp-attachment:";
export const ATTACHMENT_INDEX_PREFIX = "acp-attachments-index:";

export const ATTACHMENT_METRIC_NAMES = {
  attachmentsCreated: "acp.attachments.created",
  attachmentsListed: "acp.attachments.listed",
  attachmentErrors: "acp.attachments.errors",
} as const;

// --- Webhook hook constants ---

/** Inbound webhook event names that the ACP plugin listens to */
export const WEBHOOK_EVENTS = {
  issueStatusChange: "webhook.issue_status_change",
  sessionComplete: "webhook.session_complete",
  approvalRequired: "webhook.approval_required",
} as const;

/** Outbound event names emitted by webhook hooks */
export const WEBHOOK_OUTBOUND_EVENTS = {
  /** Emitted when an approval request is surfaced to Cockpit */
  approvalRequest: "cockpit.approval_request",
  /** Emitted when a performance record is written */
  performanceRecorded: "performance.recorded",
} as const;

/** Metric names for webhook hook operations */
export const WEBHOOK_METRIC_NAMES = {
  issueStatusChangeReceived: "acp.webhook.issue_status_change.received",
  issueStatusChangeSpawned: "acp.webhook.issue_status_change.spawned",
  issueStatusChangeErrors: "acp.webhook.issue_status_change.errors",
  issueStatusChangeDeduplicated: "acp.webhook.issue_status_change.deduplicated",
  issueStatusChangeCircuitOpen: "acp.webhook.issue_status_change.circuit_open",
  sessionCompleteReceived: "acp.webhook.session_complete.received",
  sessionCompleteRecorded: "acp.webhook.session_complete.recorded",
  sessionCompleteErrors: "acp.webhook.session_complete.errors",
  approvalRequiredReceived: "acp.webhook.approval_required.received",
  approvalRequiredSurfaced: "acp.webhook.approval_required.surfaced",
  approvalRequiredErrors: "acp.webhook.approval_required.errors",
} as const;

/**
 * Paperclip API base URL (same convention as cockpit).
 * The plugin reads this from env or falls back to the local default.
 */
export const PAPERCLIP_API_BASE =
  process.env.PAPERCLIP_API_BASE ?? "http://127.0.0.1:3100/api";

/**
 * PostgreSQL connection string for writing performance records.
 * The plugin needs WRITE access (unlike cockpit's read-only pool).
 */
export const NEXUS_METRICS_DB =
  process.env.NEXUS_METRICS_DB ?? "postgresql://localhost:5432/nexus_metrics";

/** Statuses that trigger a session spawn when transitioned to.
 * v2: "todo" is the primary trigger (webhook fires immediately on status change).
 * "in_progress" is kept for backward compatibility with manual transitions. */
export const SPAWN_TRIGGER_STATUSES = ["todo", "in_progress"] as const;

// --- Webhook v2 constants ---

/** Maximum consecutive spawn failures per company before the circuit breaker trips. */
export const WEBHOOK_CIRCUIT_BREAKER_THRESHOLD = 3;

/** Cooldown period (ms) after circuit breaker trips before retrying spawns for a company. */
export const WEBHOOK_CIRCUIT_BREAKER_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// --- Phase 2: Orchestration migration defaults ---

export const ORCHESTRATION_DEFAULTS = {
  /** Peak-hour scheduling */
  peakHourEnabled: true,
  peakHourStart: 14,
  peakHourEnd: 20,
  peakHourTimezone: "Europe/Amsterdam",
  peakHourWeekdaysOnly: true,
  peakSessionsMax: 2,
  peakPriorityThreshold: "high" as const,

  /** Session pool / cap */
  sharedPoolSize: 18,
  maxBudgetUsd: 5.0,

  /** Rate-limit cooldown (ms) — halt spawns after rate-limit detection */
  rateLimitCooldownMs: 300_000, // 5 minutes
} as const;

/** Priority levels ordered from highest to lowest. */
export const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Metric names for Phase 2 orchestration guards. */
export const ORCHESTRATION_METRIC_NAMES = {
  sessionCapChecked: "acp.orchestration.session_cap.checked",
  sessionCapRejected: "acp.orchestration.session_cap.rejected",
  peakHourChecked: "acp.orchestration.peak_hour.checked",
  peakHourDeferred: "acp.orchestration.peak_hour.deferred",
  rateLimitDetected: "acp.orchestration.rate_limit.detected",
  rateLimitCooldownActive: "acp.orchestration.rate_limit.cooldown_active",
} as const;

/** Regex patterns for detecting rate-limit errors in session output (ported from Python). */
export const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[_\-\s]?limit/i,
  /\b429\b/,
  /too\s+many\s+requests/i,
  /overloaded/i,
  /rate[_\-\s]?exceeded/i,
  /throttl(?:ed|ing)/i,
  /capacity[_\-\s]?exceeded/i,
  /resource[_\-\s]?exhausted/i,
  /retry[_\-\s]?after/i,
];

/** JSON keys that signal rate-limiting in Claude Code JSON output. */
export const RATE_LIMIT_JSON_KEYS = ["rate_limit", "rate_limited", "is_rate_limited"] as const;
export const RATE_LIMIT_ERROR_TYPES = ["rate_limit_error", "overloaded_error"] as const;
