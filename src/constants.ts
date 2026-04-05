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
};

export const METRIC_NAMES = {
  sessionsSpawned: "acp.sessions.spawned",
  sessionsActive: "acp.sessions.active",
  sessionsClosed: "acp.sessions.closed",
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

/** Statuses that trigger a session spawn when transitioned to. */
export const SPAWN_TRIGGER_STATUSES = ["in_progress"] as const;
