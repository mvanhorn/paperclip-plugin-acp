export const PLUGIN_ID = "paperclip-plugin-acp";
export const PLUGIN_VERSION = "0.1.0";

export const DEFAULT_CONFIG = {
  enabledAgents: "claude,codex,gemini,opencode",
  defaultAgent: "claude",
  defaultMode: "persistent" as const,
  defaultCwd: "/workspace",
  sessionIdleTimeoutMs: 30 * 60 * 1000, // 30 minutes
  sessionMaxAgeMs: 8 * 60 * 60 * 1000, // 8 hours
};

export const METRIC_NAMES = {
  sessionsSpawned: "acp.sessions.spawned",
  sessionsActive: "acp.sessions.active",
  sessionsClosed: "acp.sessions.closed",
  promptsSent: "acp.prompts.sent",
  outputsReceived: "acp.outputs.received",
  spawnErrors: "acp.spawn.errors",
};
