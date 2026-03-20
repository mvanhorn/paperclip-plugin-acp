export const PLUGIN_ID = "paperclip-plugin-acp";
export const PLUGIN_VERSION = "0.2.0";

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
