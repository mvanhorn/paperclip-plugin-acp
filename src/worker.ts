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
} from "./constants.js";
import {
  createAttachment,
  listAttachments,
} from "./attachment-manager.js";
import type {
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
  onIssueStatusChange,
  onSessionComplete,
  onApprovalRequired,
  closeWritePool,
} from "./webhook-hooks.js";

type AcpConfig = {
  enabledAgents: string;
  defaultAgent: string;
  defaultMode: AcpSessionMode;
  defaultCwd: string;
  sessionIdleTimeoutMs: number;
  sessionMaxAgeMs: number;
  maxSessionsPerThread: number;
};

const plugin = definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    const config = rawConfig as unknown as AcpConfig;
    ctx.logger.info("ACP plugin loaded", {
      enabledAgents: config.enabledAgents,
      defaultAgent: config.defaultAgent,
    });

    const enabledAgents = parseEnabledAgents(config?.enabledAgents ?? "claude,codex,gemini,opencode");
    if (enabledAgents.length === 0) {
      ctx.logger.warn("No ACP agents enabled");
      return;
    }

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
          await handleSpawn(ctx, config, enabledAgents, event, platformPlugin);
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
          await onIssueStatusChange(ctx, config, event);
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
          await onSessionComplete(ctx, event);
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

        await spawnAgent(ctx, session, outputHandler);

        if (initialPrompt) {
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

    // --- Cleanup on plugin shutdown ---

    ctx.events.on("plugin.stopping" as `plugin.${string}`, async () => {
      const activeIds = getActiveSessionIds();
      for (const id of activeIds) {
        killSession(id);
        await closeSession(ctx, id);
      }
      await closeWritePool();
      ctx.logger.info("ACP plugin stopped, cleaned up sessions", {
        count: activeIds.length,
      });
    });

    ctx.logger.info("ACP runtime plugin started", {
      agents: enabledAgents.map((a) => a.id),
      listeningTo: CHAT_PLATFORM_PLUGINS as unknown as string[],
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
    return {
      status: "ok",
      details: { activeSessions: activeCount },
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

  const session = await createSession(ctx, { agentId, mode, cwd, binding });

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
