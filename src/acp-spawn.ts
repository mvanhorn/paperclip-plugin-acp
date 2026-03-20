import { spawn, type ChildProcess } from "node:child_process";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getAgent } from "./agents.js";
import { updateSession } from "./session-manager.js";
import type { AcpSession, AcpOutputEvent } from "./types.js";
import { METRIC_NAMES } from "./constants.js";

const activeProcesses = new Map<string, ChildProcess>();

export async function spawnAgent(
  ctx: PluginContext,
  session: AcpSession,
  onOutput: (event: AcpOutputEvent) => void,
): Promise<void> {
  const agent = getAgent(session.agentId);
  if (!agent) {
    await updateSession(ctx, session.sessionId, { state: "error" });
    onOutput({
      sessionId: session.sessionId,
      type: "error",
      error: `Unknown agent: ${session.agentId}`,
    });
    return;
  }

  ctx.logger.info("Spawning ACP agent", {
    sessionId: session.sessionId,
    agent: agent.id,
    cwd: session.cwd,
  });

  try {
    const child = spawn(agent.command, agent.args, {
      cwd: session.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb" },
    });

    activeProcesses.set(session.sessionId, child);
    await updateSession(ctx, session.sessionId, {
      state: "active",
      pid: child.pid,
    });
    await ctx.metrics.write(METRIC_NAMES.sessionsSpawned, 1);

    let outputBuffer = "";

    child.stdout?.on("data", (data: Buffer) => {
      outputBuffer += data.toString();

      // Process complete lines (NDJSON)
      const lines = outputBuffer.split("\n");
      outputBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          handleAgentMessage(ctx, session.sessionId, msg, onOutput);
        } catch {
          // Plain text output from agent
          onOutput({
            sessionId: session.sessionId,
            type: "text",
            text: line,
          });
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      ctx.logger.warn("Agent stderr", {
        sessionId: session.sessionId,
        text: text.slice(0, 500),
      });
    });

    child.on("close", async (code: number | null) => {
      activeProcesses.delete(session.sessionId);
      const finalState = code === 0 ? "closed" : "error";
      await updateSession(ctx, session.sessionId, { state: finalState });

      onOutput({
        sessionId: session.sessionId,
        type: "done",
        text: `Agent exited with code ${code}`,
      });

      if (finalState === "closed") {
        await ctx.metrics.write(METRIC_NAMES.sessionsClosed, 1);
      } else {
        await ctx.metrics.write(METRIC_NAMES.spawnErrors, 1);
      }
    });

    child.on("error", async (err: Error) => {
      activeProcesses.delete(session.sessionId);
      await updateSession(ctx, session.sessionId, { state: "error" });
      await ctx.metrics.write(METRIC_NAMES.spawnErrors, 1);

      onOutput({
        sessionId: session.sessionId,
        type: "error",
        error: `Failed to spawn ${agent.displayName}: ${err.message}`,
      });
    });
  } catch (err) {
    await updateSession(ctx, session.sessionId, { state: "error" });
    await ctx.metrics.write(METRIC_NAMES.spawnErrors, 1);

    onOutput({
      sessionId: session.sessionId,
      type: "error",
      error: `Spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export async function sendPrompt(
  ctx: PluginContext,
  sessionId: string,
  text: string,
): Promise<boolean> {
  const child = activeProcesses.get(sessionId);
  if (!child || !child.stdin?.writable) {
    ctx.logger.warn("Cannot send prompt - no active process", { sessionId });
    return false;
  }

  try {
    child.stdin.write(text + "\n");
    await updateSession(ctx, sessionId, { lastActivityAt: Date.now() });
    await ctx.metrics.write(METRIC_NAMES.promptsSent, 1);
    return true;
  } catch (err) {
    ctx.logger.error("Failed to send prompt", {
      sessionId,
      error: String(err),
    });
    return false;
  }
}

export function cancelSession(sessionId: string): boolean {
  const child = activeProcesses.get(sessionId);
  if (!child) return false;

  child.kill("SIGINT");
  return true;
}

export function killSession(sessionId: string): boolean {
  const child = activeProcesses.get(sessionId);
  if (!child) return false;

  child.kill("SIGTERM");
  activeProcesses.delete(sessionId);
  return true;
}

export function getActiveSessionIds(): string[] {
  return Array.from(activeProcesses.keys());
}

function handleAgentMessage(
  ctx: PluginContext,
  sessionId: string,
  msg: Record<string, unknown>,
  onOutput: (event: AcpOutputEvent) => void,
): void {
  // Handle ACP JSON-RPC messages
  const method = msg.method as string | undefined;

  if (method === "session/update") {
    const params = msg.params as Record<string, unknown> | undefined;
    if (!params) return;

    const updateType = params.type as string | undefined;

    if (updateType === "text") {
      onOutput({
        sessionId,
        type: "text",
        text: params.text as string,
      });
    } else if (updateType === "tool_call") {
      onOutput({
        sessionId,
        type: "tool_call",
        toolName: params.name as string,
        toolInput: JSON.stringify(params.input),
      });
    } else if (updateType === "tool_result") {
      onOutput({
        sessionId,
        type: "tool_result",
        toolName: params.name as string,
        toolOutput: params.output as string,
      });
    }

    ctx.metrics.write(METRIC_NAMES.outputsReceived, 1).catch(() => {});
    return;
  }

  // Fallback: treat as text
  if (msg.result || msg.content) {
    onOutput({
      sessionId,
      type: "text",
      text: JSON.stringify(msg.result ?? msg.content),
    });
  }
}
