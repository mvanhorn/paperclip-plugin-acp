export type AcpAgentId = "claude" | "codex" | "gemini" | "opencode" | string;

export type AcpSessionMode = "persistent" | "oneshot";

export type AcpAgentConfig = {
  id: AcpAgentId;
  command: string;
  args: string[];
  displayName: string;
  description: string;
};

export type AcpSession = {
  sessionId: string;
  agentId: AcpAgentId;
  mode: AcpSessionMode;
  cwd: string;
  createdAt: number;
  lastActivityAt: number;
  state: "spawning" | "active" | "idle" | "closing" | "closed" | "error";
  binding?: AcpBinding;
  pid?: number;
};

export type AcpBinding = {
  platform: "telegram" | "discord" | "slack" | string;
  threadId: string;
  channelId?: string;
  boundAt: number;
};

/** Entry stored in the 1:N sessions array per thread */
export type AcpSessionEntry = {
  sessionId: string;
  agentName: AcpAgentId;
  agentDisplayName: string;
  spawnedAt: number;
  status: AcpSession["state"];
  pid?: number;
};

/** Legacy 1:1 binding from old state format */
export type LegacyAcpBinding = {
  sessionId: string;
  agentName: string;
  boundAt: number;
};

export type AcpSpawnRequest = {
  agentId: AcpAgentId;
  mode?: AcpSessionMode;
  cwd?: string;
  binding?: AcpBinding;
  initialPrompt?: string;
};

export type AcpPromptRequest = {
  sessionId: string;
  text: string;
  attachments?: Array<{ name: string; content: string; mimeType: string }>;
};

export type AcpOutputEvent = {
  sessionId: string;
  type: "text" | "tool_call" | "tool_result" | "error" | "done";
  text?: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  error?: string;
};

export type AcpMessageEvent = {
  platform: string;
  threadId: string;
  channelId?: string;
  text: string;
  attachments?: Array<{ name: string; content: string; mimeType: string }>;
  senderName?: string;
};

/** Cross-plugin event payloads */
export type AcpSpawnEvent = {
  agentName: AcpAgentId;
  chatId: string;
  threadId: string;
  companyId: string;
  cwd?: string;
  mode?: AcpSessionMode;
};

export type AcpMessageCrossEvent = {
  sessionId: string;
  text: string;
};

export type AcpCancelEvent = {
  sessionId: string;
};

export type AcpCloseEvent = {
  sessionId: string;
};

// --- Attachment types ---

/** Metadata for a single file attachment on an issue */
export type AcpAttachment = {
  attachmentId: string;
  issueId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  createdAt: number;
  createdBy?: string;
};

/** Response returned when an attachment is created */
export type AcpAttachmentResponse = {
  attachmentId: string;
  issueId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  createdAt: number;
};

/** Parameters for creating an attachment */
export type AcpAttachRequest = {
  issueId: string;
  filename: string;
  content: string; // base64-encoded file content
  mimeType?: string;
};

/** Parameters for listing attachments */
export type AcpListAttachmentsRequest = {
  issueId: string;
};

// --- Webhook hook types ---

/** Paperclip issue status values */
export type PaperclipIssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done";

/**
 * Payload for the on_issue_status_change webhook hook.
 * Fired when a Paperclip issue transitions between statuses.
 */
export type IssueStatusChangeEvent = {
  issueId: string;
  companyId: string;
  previousStatus: PaperclipIssueStatus;
  newStatus: PaperclipIssueStatus;
  title: string;
  description: string;
  priority: string;
  labels?: string[];
  /** Working directory override for the spawned agent. */
  cwd?: string;
  /** Timestamp of the status change (epoch ms). */
  changedAt: number;
};

/**
 * Payload for the on_session_complete webhook hook.
 * Fired when a Claude Code session finishes executing on a ticket.
 */
export type SessionCompleteEvent = {
  sessionId: string;
  issueId: string;
  companyId: string;
  agentId: AcpAgentId;
  /** Exit code of the agent process (0 = success). */
  exitCode: number | null;
  /** Duration of the session in milliseconds. */
  durationMs: number;
  /** Number of prompts sent during the session. */
  promptCount: number;
  /** Number of tool calls executed during the session. */
  toolCallCount: number;
  /** Whether the agent completed successfully vs errored. */
  success: boolean;
  /** Final status to set on the Paperclip issue. */
  targetStatus?: PaperclipIssueStatus;
  /** Optional summary of work done. */
  summary?: string;
  /** Timestamp of session completion (epoch ms). */
  completedAt: number;
};

/**
 * Performance record written to PostgreSQL on session completion.
 */
export type PerformanceRecord = {
  session_id: string;
  issue_id: string;
  company_id: string;
  agent_id: string;
  exit_code: number | null;
  duration_ms: number;
  prompt_count: number;
  tool_call_count: number;
  success: boolean;
  summary: string | null;
  completed_at: string; // ISO 8601
  recorded_at: string; // ISO 8601
};

/**
 * Per-company circuit breaker state for webhook-triggered spawns (v2).
 * Tracks consecutive failures to prevent runaway spawn attempts.
 */
export type WebhookCircuitBreakerState = {
  /** Number of consecutive spawn failures for this company. */
  consecutiveFailures: number;
  /** Timestamp (epoch ms) when the circuit breaker last tripped. */
  trippedAt: number | null;
  /** Whether the circuit is currently open (blocking spawns). */
  isOpen: boolean;
};

// --- Phase 2: Orchestration migration types ---

/**
 * Phase 2 orchestration config fields (session caps, peak-hour, rate-limit).
 * Read from instanceConfigSchema and merged into the main AcpConfig.
 */
export type OrchestrationConfig = {
  peakHourEnabled: boolean;
  peakHourStart: number;
  peakHourEnd: number;
  peakHourTimezone: string;
  peakHourWeekdaysOnly: boolean;
  peakSessionsMax: number;
  peakPriorityThreshold: string;
  maxBudgetUsd: number;
  sharedPoolSize: number;
  rateLimitCooldownMs: number;
};

/**
 * Result of a pre-spawn orchestration check.
 * If `allowed` is false, `reason` explains why the spawn was rejected.
 */
export type SpawnGuardResult = {
  allowed: boolean;
  reason?: string;
  /** If the routine run should be marked with a specific skip/fail reason. */
  routineRunStatus?: "skipped" | "failed";
  /** Detailed reason code for logging / routine run records. */
  reasonCode?:
    | "session_cap_exhausted"
    | "company_cap_exhausted"
    | "peak_hour_deferred"
    | "rate_limit_cooldown"
    | "rate_limited";
};

/**
 * In-memory rate-limit cooldown state (global, not per-company).
 */
export type RateLimitCooldownState = {
  /** Whether the cooldown is currently active. */
  active: boolean;
  /** Epoch ms when the cooldown started. */
  startedAt: number | null;
  /** Epoch ms when the cooldown expires. */
  expiresAt: number | null;
  /** Issue that triggered the rate-limit detection. */
  triggeredByIssueId: string | null;
};

/**
 * Pool status snapshot exposed via the health endpoint.
 */
export type PoolStatus = {
  sharedPoolSize: number;
  inProgressCount: number;
  available: number;
  isPeakHour: boolean;
  effectiveCap: number;
  rateLimitCooldownActive: boolean;
  rateLimitCooldownExpiresAt: number | null;
};

/**
 * Payload for the on_approval_required webhook hook.
 * Fired when a ticket reaches a state requiring Chairman approval.
 */
export type ApprovalRequiredEvent = {
  issueId: string;
  companyId: string;
  title: string;
  description: string;
  /** The deliberation or context that triggered the approval request. */
  deliberationSummary?: string;
  /** Who or what requested the approval. */
  requestedBy: string;
  /** Priority of the approval request. */
  priority: string;
  /** Timestamp of the approval request (epoch ms). */
  requestedAt: number;
};
