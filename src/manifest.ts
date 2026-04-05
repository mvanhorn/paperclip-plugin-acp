import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, ORCHESTRATION_DEFAULTS, PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "ACP Runtime",
  description:
    "Agent Client Protocol runtime for Paperclip. Run Claude Code, Codex, Gemini CLI, and other coding agents from any chat platform via thread-bound sessions.",
  author: "mvanhorn",
  categories: ["connector", "automation"],
  capabilities: [
    "events.subscribe",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "activity.log.write",
    "metrics.write",
    "agent.tools.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      enabledAgents: {
        type: "string",
        title: "Enabled agents",
        description:
          "Comma-separated list of ACP agents to enable. Options: claude, codex, gemini, opencode.",
        default: DEFAULT_CONFIG.enabledAgents,
      },
      defaultAgent: {
        type: "string",
        title: "Default agent",
        description: "Agent to use when none is specified in /acp spawn.",
        default: DEFAULT_CONFIG.defaultAgent,
      },
      defaultMode: {
        type: "string",
        title: "Default session mode",
        description: "persistent (stays alive for follow-ups) or oneshot (single task, auto-closes).",
        default: DEFAULT_CONFIG.defaultMode,
      },
      defaultCwd: {
        type: "string",
        title: "Default working directory",
        description: "Working directory for spawned agents.",
        default: DEFAULT_CONFIG.defaultCwd,
      },
      sessionIdleTimeoutMs: {
        type: "number",
        title: "Session idle timeout (ms)",
        description: "Close sessions after this many ms of inactivity.",
        default: DEFAULT_CONFIG.sessionIdleTimeoutMs,
      },
      sessionMaxAgeMs: {
        type: "number",
        title: "Session max age (ms)",
        description: "Close sessions after this many ms regardless of activity.",
        default: DEFAULT_CONFIG.sessionMaxAgeMs,
      },
      maxSessionsPerThread: {
        type: "number",
        title: "Max sessions per thread",
        description: "Maximum concurrent ACP sessions allowed per chat thread.",
        default: DEFAULT_CONFIG.maxSessionsPerThread,
      },
      // --- Phase 2: Orchestration migration config ---
      peakHourEnabled: {
        type: "boolean",
        title: "Enable peak-hour scheduling",
        description: "When enabled, reduce concurrency and filter by priority during peak hours.",
        default: ORCHESTRATION_DEFAULTS.peakHourEnabled,
      },
      peakHourStart: {
        type: "number",
        title: "Peak hour start (0-23)",
        description: "Hour (in configured timezone) when peak scheduling begins.",
        default: ORCHESTRATION_DEFAULTS.peakHourStart,
      },
      peakHourEnd: {
        type: "number",
        title: "Peak hour end (0-23)",
        description: "Hour (in configured timezone) when peak scheduling ends.",
        default: ORCHESTRATION_DEFAULTS.peakHourEnd,
      },
      peakHourTimezone: {
        type: "string",
        title: "Peak hour timezone",
        description: "IANA timezone for peak-hour calculations (e.g. Europe/Amsterdam).",
        default: ORCHESTRATION_DEFAULTS.peakHourTimezone,
      },
      peakHourWeekdaysOnly: {
        type: "boolean",
        title: "Peak hours on weekdays only",
        description: "When true, weekends are always off-peak regardless of time.",
        default: ORCHESTRATION_DEFAULTS.peakHourWeekdaysOnly,
      },
      peakSessionsMax: {
        type: "number",
        title: "Peak session cap",
        description: "Maximum concurrent sessions during peak hours.",
        default: ORCHESTRATION_DEFAULTS.peakSessionsMax,
      },
      peakPriorityThreshold: {
        type: "string",
        title: "Peak priority threshold",
        description: "Minimum priority level for spawning during peak hours (critical, high, medium, low).",
        default: ORCHESTRATION_DEFAULTS.peakPriorityThreshold,
      },
      maxBudgetUsd: {
        type: "number",
        title: "Max budget (USD)",
        description: "Maximum USD budget for subscription usage tracking.",
        default: ORCHESTRATION_DEFAULTS.maxBudgetUsd,
      },
      sharedPoolSize: {
        type: "number",
        title: "Shared session pool size",
        description: "Total number of shared sessions available across all companies.",
        default: ORCHESTRATION_DEFAULTS.sharedPoolSize,
      },
      rateLimitCooldownMs: {
        type: "number",
        title: "Rate-limit cooldown (ms)",
        description: "Duration to halt spawns after a rate-limit is detected.",
        default: ORCHESTRATION_DEFAULTS.rateLimitCooldownMs,
      },
    },
  },
  tools: [
    {
      name: "acp_spawn",
      displayName: "Spawn ACP Agent",
      description: "Start a new ACP coding agent session. Agents: claude, codex, gemini, opencode.",
      parametersSchema: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: "Agent to spawn (claude, codex, gemini, opencode).",
          },
          mode: {
            type: "string",
            description: "Session mode: persistent or oneshot.",
          },
          cwd: {
            type: "string",
            description: "Working directory for the agent.",
          },
          prompt: {
            type: "string",
            description: "Initial prompt to send to the agent.",
          },
        },
      },
    },
    {
      name: "acp_status",
      displayName: "ACP Session Status",
      description: "List active ACP sessions and their state.",
      parametersSchema: { type: "object", properties: {} },
    },
    {
      name: "acp_send",
      displayName: "Send to ACP Session",
      description: "Send a prompt to an active ACP session.",
      parametersSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Target session ID." },
          text: { type: "string", description: "Prompt text to send." },
        },
        required: ["sessionId", "text"],
      },
    },
    {
      name: "acp_cancel",
      displayName: "Cancel ACP Session",
      description: "Cancel the current turn in an ACP session.",
      parametersSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session to cancel." },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "acp_close",
      displayName: "Close ACP Session",
      description: "Close an ACP session and remove thread bindings.",
      parametersSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session to close." },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "acp_attach",
      displayName: "Attach File to Issue",
      description:
        "Upload a file attachment to an issue. Content must be base64-encoded. Returns attachment metadata including ID and URL.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "The issue ID to attach the file to.",
          },
          filename: {
            type: "string",
            description: "Original filename (e.g. report.pdf).",
          },
          content: {
            type: "string",
            description: "Base64-encoded file content.",
          },
          mimeType: {
            type: "string",
            description:
              "MIME type of the file (optional — inferred from filename if omitted).",
          },
        },
        required: ["issueId", "filename", "content"],
      },
    },
    {
      name: "acp_attachments",
      displayName: "List Issue Attachments",
      description:
        "List all file attachments for a given issue. Returns attachment metadata array.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "The issue ID to list attachments for.",
          },
        },
        required: ["issueId"],
      },
    },
  ],
};

export default manifest;
