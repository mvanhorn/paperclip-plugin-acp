import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  AcpSession,
  AcpBinding,
  AcpSessionMode,
  AcpAgentId,
} from "./types.js";

const STATE_PREFIX = "acp-session:";
const BINDING_PREFIX = "acp-binding:";

function sessionStateKey(sessionId: string): string {
  return `${STATE_PREFIX}${sessionId}`;
}

function bindingStateKey(platform: string, threadId: string): string {
  return `${BINDING_PREFIX}${platform}:${threadId}`;
}

export function generateSessionId(): string {
  return `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createSession(
  ctx: PluginContext,
  params: {
    agentId: AcpAgentId;
    mode: AcpSessionMode;
    cwd: string;
    binding?: AcpBinding;
  },
): Promise<AcpSession> {
  const sessionId = generateSessionId();
  const now = Date.now();

  const session: AcpSession = {
    sessionId,
    agentId: params.agentId,
    mode: params.mode,
    cwd: params.cwd,
    createdAt: now,
    lastActivityAt: now,
    state: "spawning",
    binding: params.binding,
  };

  await ctx.state.set(
    { scopeKind: "instance", stateKey: sessionStateKey(sessionId) },
    session,
  );

  if (params.binding) {
    await ctx.state.set(
      {
        scopeKind: "instance",
        stateKey: bindingStateKey(params.binding.platform, params.binding.threadId),
      },
      sessionId,
    );
  }

  return session;
}

export async function getSession(
  ctx: PluginContext,
  sessionId: string,
): Promise<AcpSession | null> {
  const data = await ctx.state.get({
    scopeKind: "instance",
    stateKey: sessionStateKey(sessionId),
  });
  return (data as AcpSession) ?? null;
}

export async function updateSession(
  ctx: PluginContext,
  sessionId: string,
  updates: Partial<AcpSession>,
): Promise<void> {
  const session = await getSession(ctx, sessionId);
  if (!session) return;

  const updated = { ...session, ...updates, lastActivityAt: Date.now() };
  await ctx.state.set(
    { scopeKind: "instance", stateKey: sessionStateKey(sessionId) },
    updated,
  );
}

export async function closeSession(
  ctx: PluginContext,
  sessionId: string,
): Promise<void> {
  const session = await getSession(ctx, sessionId);
  if (!session) return;

  await updateSession(ctx, sessionId, { state: "closed" });

  if (session.binding) {
    await ctx.state.set(
      {
        scopeKind: "instance",
        stateKey: bindingStateKey(session.binding.platform, session.binding.threadId),
      },
      null,
    );
  }
}

export async function resolveBinding(
  ctx: PluginContext,
  platform: string,
  threadId: string,
): Promise<AcpSession | null> {
  const sessionId = await ctx.state.get({
    scopeKind: "instance",
    stateKey: bindingStateKey(platform, threadId),
  });

  if (!sessionId || typeof sessionId !== "string") return null;

  const session = await getSession(ctx, sessionId);
  if (!session || session.state === "closed" || session.state === "error") {
    return null;
  }

  return session;
}
