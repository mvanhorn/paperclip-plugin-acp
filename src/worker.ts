import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginHealthDiagnostics,
} from "@paperclipai/plugin-sdk";
import { getAgent, listAgents, parseEnabledAgents } from "./agents.js";
import {
  createSession,
  getSession,
  closeSession,
  resolveBinding,
  updateSession,
} from "./session-manager.js";
import {
  spawnAgent,
  sendPrompt,
  cancelSession,
  killSession,
  getActiveSessionIds,
} from "./acp-spawn.js";
import { METRIC_NAMES } from "./constants.js";
import type {
  AcpMessageEvent,
  AcpOutputEvent,
  AcpSessionMode,
} from "./types.js";

type AcpConfig = {
  enabledAgents: string;
  defaultAgent: string;
  defaultMode: AcpSessionMode;
  defaultCwd: string;
  sessionIdleTimeoutMs: number;
  sessionMaxAgeMs: number;
};

const plugin = definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    const config = rawConfig as unknown as AcpConfig;
    ctx.logger.info("ACP plugin loaded", {
      enabledAgents: config.enabledAgents,
      defaultAgent: config.defaultAgent,
    });

    const enabledAgents = parseEnabledAgents(config.enabledAgents);
    if (enabledAgents.length === 0) {
      ctx.logger.warn("No ACP agents enabled");
      return;
    }

    // --- Event bus: receive messages from chat plugins ---

    ctx.events.on("acp:message", async (rawEvent) => {
      const event = rawEvent as unknown as AcpMessageEvent;
      ctx.logger.info("ACP message received", {
        platform: event.platform,
        threadId: event.threadId,
        textLength: event.text?.length,
      });

      // Find existing session for this thread
      const session = await resolveBinding(ctx, event.platform, event.threadId);
      if (!session) {
        ctx.logger.debug("No ACP binding for thread", {
          platform: event.platform,
          threadId: event.threadId,
        });
        return;
      }

      // Send prompt to the active session
      const sent = await sendPrompt(ctx, session.sessionId, event.text);
      if (!sent) {
        ctx.events.emit("acp:output", {
          sessionId: session.sessionId,
          platform: event.platform,
          threadId: event.threadId,
          type: "error",
          error: "Session is not active. Start a new one with /acp spawn.",
        });
      }
    });

    // --- Tool handlers ---

    ctx.tools.register("acp_spawn", async (params) => {
      const agentId = (params.agent as string) || config.defaultAgent;
      const mode = (params.mode as AcpSessionMode) || config.defaultMode;
      const cwd = (params.cwd as string) || config.defaultCwd;
      const initialPrompt = params.prompt as string | undefined;

      const agent = getAgent(agentId);
      if (!agent) {
        return {
          success: false,
          error: `Unknown agent: ${agentId}. Available: ${enabledAgents.map((a) => a.id).join(", ")}`,
        };
      }

      const enabled = enabledAgents.find((a) => a.id === agentId);
      if (!enabled) {
        return {
          success: false,
          error: `Agent ${agentId} is not enabled. Enabled: ${enabledAgents.map((a) => a.id).join(", ")}`,
        };
      }

      const session = await createSession(ctx, { agentId, mode, cwd });

      const outputHandler = (event: AcpOutputEvent) => {
        ctx.events.emit("acp:output", {
          ...event,
          platform: session.binding?.platform,
          threadId: session.binding?.threadId,
        });
      };

      await spawnAgent(ctx, session, outputHandler);

      if (initialPrompt) {
        await sendPrompt(ctx, session.sessionId, initialPrompt);
      }

      return {
        success: true,
        sessionId: session.sessionId,
        agent: agent.displayName,
        mode,
        cwd,
      };
    });

    ctx.tools.register("acp_status", async () => {
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

      return { activeSessions: sessions.length, sessions };
    });

    ctx.tools.register("acp_send", async (params) => {
      const sessionId = params.sessionId as string;
      const text = params.text as string;

      if (!sessionId || !text) {
        return { success: false, error: "sessionId and text are required" };
      }

      const sent = await sendPrompt(ctx, sessionId, text);
      return { success: sent };
    });

    ctx.tools.register("acp_cancel", async (params) => {
      const sessionId = params.sessionId as string;
      const cancelled = cancelSession(sessionId);
      return { success: cancelled };
    });

    ctx.tools.register("acp_close", async (params) => {
      const sessionId = params.sessionId as string;
      killSession(sessionId);
      await closeSession(ctx, sessionId);
      return { success: true };
    });

    // --- Cleanup on plugin shutdown ---

    ctx.events.on("plugin.stopping", async () => {
      const activeIds = getActiveSessionIds();
      for (const id of activeIds) {
        killSession(id);
        await closeSession(ctx, id);
      }
      ctx.logger.info("ACP plugin stopped, cleaned up sessions", {
        count: activeIds.length,
      });
    });

    ctx.logger.info("ACP runtime plugin started", {
      agents: enabledAgents.map((a) => a.id),
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
    return { ok: true };
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const activeCount = getActiveSessionIds().length;
    return {
      status: "ok",
      details: { activeSessions: activeCount },
    };
  },
});

runWorker(plugin, import.meta.url);
