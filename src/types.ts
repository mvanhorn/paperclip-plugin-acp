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
