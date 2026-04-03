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
