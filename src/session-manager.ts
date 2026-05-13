import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  AcpSession,
  AcpBinding,
  AcpSessionMode,
  AcpAgentId,
  AcpSessionEntry,
  LegacyAcpBinding,
} from "./types.js";
import { getAgent } from "./agents.js";
import { DEFAULT_CONFIG } from "./constants.js";

const STATE_PREFIX = "acp-session:";
const SESSIONS_PREFIX = "acp_sessions_";
const LEGACY_BINDING_PREFIX = "acp_";

// --- Per-session state (unchanged key format) ---

function sessionStateKey(sessionId: string): string {
  return `${STATE_PREFIX}${sessionId}`;
}

export function generateSessionId(): string {
  return `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createSession(
  ctx: PluginContext,
  params: {
    sessionId?: string;
    agentId: AcpAgentId;
    mode: AcpSessionMode;
    cwd: string;
    binding?: AcpBinding;
  },
): Promise<AcpSession> {
  const sessionId = params.sessionId ?? generateSessionId();
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

  // Remove from thread sessions array if bound
  if (session.binding) {
    await removeSessionFromThread(
      ctx,
      session.binding.platform,
      session.binding.threadId,
      sessionId,
    );
  }
}

// --- 1:N thread sessions array ---

function threadSessionsKey(chatId: string, threadId: string): string {
  return `${SESSIONS_PREFIX}${chatId}_${threadId}`;
}

function legacyBindingKey(chatId: string, threadId: string): string {
  return `${LEGACY_BINDING_PREFIX}${chatId}_${threadId}`;
}

/**
 * Read the sessions array for a thread, with lazy migration from old 1:1 format.
 *
 * Old format: key `acp_{chatId}_{threadId}` -> { sessionId, agentName, boundAt }
 * New format: key `acp_sessions_{chatId}_{threadId}` -> AcpSessionEntry[]
 */
export async function getThreadSessions(
  ctx: PluginContext,
  chatId: string,
  threadId: string,
): Promise<AcpSessionEntry[]> {
  // Try new key first
  const newData = await ctx.state.get({
    scopeKind: "instance",
    stateKey: threadSessionsKey(chatId, threadId),
  });

  if (Array.isArray(newData)) {
    return newData as AcpSessionEntry[];
  }

  // Lazy migration: check old key format
  const legacyData = await ctx.state.get({
    scopeKind: "instance",
    stateKey: legacyBindingKey(chatId, threadId),
  });

  if (legacyData && typeof legacyData === "object") {
    const legacy = legacyData as LegacyAcpBinding;
    const agent = getAgent(legacy.agentName);
    const migrated: AcpSessionEntry[] = [
      {
        sessionId: legacy.sessionId,
        agentName: legacy.agentName,
        agentDisplayName: agent?.displayName ?? legacy.agentName,
        spawnedAt: legacy.boundAt,
        status: "active",
      },
    ];

    // Write to new key
    await ctx.state.set(
      { scopeKind: "instance", stateKey: threadSessionsKey(chatId, threadId) },
      migrated,
    );

    // Clear old key
    await ctx.state.set(
      { scopeKind: "instance", stateKey: legacyBindingKey(chatId, threadId) },
      null,
    );

    ctx.logger.info("Migrated legacy 1:1 binding to 1:N sessions array", {
      chatId,
      threadId,
      sessionId: legacy.sessionId,
    });

    return migrated;
  }

  return [];
}

/**
 * Add a session entry to a thread's sessions array.
 * Enforces max sessions per thread cap.
 */
export async function addSessionToThread(
  ctx: PluginContext,
  chatId: string,
  threadId: string,
  entry: AcpSessionEntry,
  maxPerThread: number = DEFAULT_CONFIG.maxSessionsPerThread,
): Promise<{ added: boolean; error?: string }> {
  const sessions = await getThreadSessions(ctx, chatId, threadId);

  // Filter out closed/error sessions before checking the cap
  const activeSessions = sessions.filter(
    (s) => s.status !== "closed" && s.status !== "error",
  );

  if (activeSessions.length >= maxPerThread) {
    return {
      added: false,
      error: `Thread already has ${activeSessions.length} active sessions (max: ${maxPerThread}). Close one first.`,
    };
  }

  sessions.push(entry);

  await ctx.state.set(
    { scopeKind: "instance", stateKey: threadSessionsKey(chatId, threadId) },
    sessions,
  );

  return { added: true };
}

/**
 * Remove a session from the thread's sessions array.
 */
export async function removeSessionFromThread(
  ctx: PluginContext,
  chatId: string,
  threadId: string,
  sessionId: string,
): Promise<void> {
  const sessions = await getThreadSessions(ctx, chatId, threadId);
  const filtered = sessions.filter((s) => s.sessionId !== sessionId);

  await ctx.state.set(
    { scopeKind: "instance", stateKey: threadSessionsKey(chatId, threadId) },
    filtered,
  );
}

/**
 * Update the status/pid of a session entry in the thread's array.
 */
export async function updateThreadSessionEntry(
  ctx: PluginContext,
  chatId: string,
  threadId: string,
  sessionId: string,
  updates: Partial<Pick<AcpSessionEntry, "status" | "pid">>,
): Promise<void> {
  const sessions = await getThreadSessions(ctx, chatId, threadId);
  const idx = sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx === -1) return;

  sessions[idx] = { ...sessions[idx], ...updates };

  await ctx.state.set(
    { scopeKind: "instance", stateKey: threadSessionsKey(chatId, threadId) },
    sessions,
  );
}

/**
 * Resolve a single session by ID from a thread.
 */
export async function findSessionInThread(
  ctx: PluginContext,
  chatId: string,
  threadId: string,
  sessionId: string,
): Promise<AcpSessionEntry | null> {
  const sessions = await getThreadSessions(ctx, chatId, threadId);
  return sessions.find((s) => s.sessionId === sessionId) ?? null;
}

// --- Legacy resolveBinding (kept for backward compat in tool handlers) ---

export async function resolveBinding(
  ctx: PluginContext,
  platform: string,
  threadId: string,
): Promise<AcpSession | null> {
  // Try to find any active session for this platform+thread
  const sessions = await getThreadSessions(ctx, platform, threadId);
  const active = sessions.find(
    (s) => s.status === "active" || s.status === "idle" || s.status === "spawning",
  );
  if (!active) return null;

  return getSession(ctx, active.sessionId);
}
