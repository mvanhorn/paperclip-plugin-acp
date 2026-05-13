import { describe, it, expect, beforeEach } from "vitest";
import { createMockContext } from "./helpers.js";
import {
  getThreadSessions,
  addSessionToThread,
  removeSessionFromThread,
  updateThreadSessionEntry,
  findSessionInThread,
  createSession,
  getSession,
  updateSession,
  closeSession,
  generateSessionId,
} from "../src/session-manager.js";
import type { AcpSessionEntry } from "../src/types.js";

function makeEntry(overrides?: Partial<AcpSessionEntry>): AcpSessionEntry {
  return {
    sessionId: `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentName: "claude",
    agentDisplayName: "Claude Code",
    spawnedAt: Date.now(),
    status: "active",
    ...overrides,
  };
}

describe("generateSessionId", () => {
  it("returns a string starting with acp-", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^acp-\d+-[a-z0-9]+$/);
  });

  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateSessionId()));
    expect(ids.size).toBe(50);
  });
});

describe("per-session CRUD (createSession / getSession / updateSession / closeSession)", () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it("createSession persists and getSession retrieves", async () => {
    const session = await createSession(ctx, {
      agentId: "claude",
      mode: "persistent",
      cwd: "/workspace",
    });

    expect(session.sessionId).toBeTruthy();
    expect(session.state).toBe("spawning");
    expect(session.agentId).toBe("claude");

    const retrieved = await getSession(ctx, session.sessionId);
    expect(retrieved).toEqual(session);
  });

  it("createSession honors a caller-supplied session id for cross-plugin chat bridges", async () => {
    const session = await createSession(ctx, {
      sessionId: "line-session-1",
      agentId: "claude",
      mode: "persistent",
      cwd: "/workspace",
    });

    expect(session.sessionId).toBe("line-session-1");
    await expect(getSession(ctx, "line-session-1")).resolves.toEqual(session);
  });

  it("getSession returns null for unknown sessionId", async () => {
    const result = await getSession(ctx, "nonexistent");
    expect(result).toBeNull();
  });

  it("updateSession merges fields and bumps lastActivityAt", async () => {
    const session = await createSession(ctx, {
      agentId: "codex",
      mode: "oneshot",
      cwd: "/tmp",
    });

    const beforeUpdate = session.lastActivityAt;
    // Small delay to ensure timestamp changes
    await new Promise((r) => setTimeout(r, 5));

    await updateSession(ctx, session.sessionId, { state: "active", pid: 1234 });

    const updated = await getSession(ctx, session.sessionId);
    expect(updated!.state).toBe("active");
    expect(updated!.pid).toBe(1234);
    expect(updated!.lastActivityAt).toBeGreaterThanOrEqual(beforeUpdate);
    // Original fields preserved
    expect(updated!.agentId).toBe("codex");
    expect(updated!.mode).toBe("oneshot");
  });

  it("updateSession is a no-op for unknown session", async () => {
    // Should not throw
    await updateSession(ctx, "nonexistent", { state: "active" });
  });

  it("closeSession sets state to closed and removes from thread", async () => {
    const session = await createSession(ctx, {
      agentId: "claude",
      mode: "persistent",
      cwd: "/workspace",
      binding: {
        platform: "telegram",
        threadId: "t1",
        boundAt: Date.now(),
      },
    });

    // Add to thread sessions first
    const entry = makeEntry({ sessionId: session.sessionId });
    await addSessionToThread(ctx, "telegram", "t1", entry);

    await closeSession(ctx, session.sessionId);

    const closed = await getSession(ctx, session.sessionId);
    expect(closed!.state).toBe("closed");

    // Should be removed from thread
    const threadSessions = await getThreadSessions(ctx, "telegram", "t1");
    expect(threadSessions.find((s) => s.sessionId === session.sessionId)).toBeUndefined();
  });
});

describe("getThreadSessions", () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it("returns empty array for a thread with no sessions", async () => {
    const sessions = await getThreadSessions(ctx, "telegram", "thread-new");
    expect(sessions).toEqual([]);
  });

  it("lazy-migrates from old 1:1 format to array", async () => {
    // Seed old-format data under the legacy key
    const legacyKey = "acp_telegram_thread-legacy";
    ctx.state._store.set(legacyKey, {
      sessionId: "old-session-1",
      agentName: "claude",
      boundAt: 1000,
    });

    const sessions = await getThreadSessions(ctx, "telegram", "thread-legacy");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("old-session-1");
    expect(sessions[0].agentName).toBe("claude");
    expect(sessions[0].agentDisplayName).toBe("Claude Code");
    expect(sessions[0].spawnedAt).toBe(1000);
    expect(sessions[0].status).toBe("active");

    // Legacy key should be cleared
    expect(ctx.state._store.has(legacyKey)).toBe(false);

    // New key should be set
    const newKey = "acp_sessions_telegram_thread-legacy";
    expect(ctx.state._store.has(newKey)).toBe(true);

    // Calling again should return same data from new key (no re-migration)
    const again = await getThreadSessions(ctx, "telegram", "thread-legacy");
    expect(again).toEqual(sessions);
  });

  it("returns existing array data from new key", async () => {
    const entries: AcpSessionEntry[] = [
      makeEntry({ sessionId: "s1" }),
      makeEntry({ sessionId: "s2" }),
    ];
    ctx.state._store.set("acp_sessions_discord_t42", entries);

    const result = await getThreadSessions(ctx, "discord", "t42");
    expect(result).toHaveLength(2);
    expect(result[0].sessionId).toBe("s1");
    expect(result[1].sessionId).toBe("s2");
  });
});

describe("addSessionToThread", () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it("adds entry and returns { added: true }", async () => {
    const entry = makeEntry({ sessionId: "new-1" });
    const result = await addSessionToThread(ctx, "slack", "t1", entry);

    expect(result.added).toBe(true);
    expect(result.error).toBeUndefined();

    const sessions = await getThreadSessions(ctx, "slack", "t1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("new-1");
  });

  it("allows multiple entries up to the cap", async () => {
    for (let i = 0; i < 5; i++) {
      const entry = makeEntry({ sessionId: `s-${i}` });
      const result = await addSessionToThread(ctx, "slack", "t1", entry, 5);
      expect(result.added).toBe(true);
    }

    const sessions = await getThreadSessions(ctx, "slack", "t1");
    expect(sessions).toHaveLength(5);
  });

  it("enforces max sessions cap - rejects when at limit", async () => {
    // Add 3 active sessions (using cap of 3)
    for (let i = 0; i < 3; i++) {
      await addSessionToThread(
        ctx,
        "telegram",
        "t1",
        makeEntry({ sessionId: `s-${i}`, status: "active" }),
        3,
      );
    }

    // 4th should be rejected
    const result = await addSessionToThread(
      ctx,
      "telegram",
      "t1",
      makeEntry({ sessionId: "s-overflow" }),
      3,
    );

    expect(result.added).toBe(false);
    expect(result.error).toContain("3 active sessions");
    expect(result.error).toContain("max: 3");
  });

  it("does not count closed/error sessions toward the cap", async () => {
    await addSessionToThread(
      ctx,
      "telegram",
      "t2",
      makeEntry({ sessionId: "s-active", status: "active" }),
      2,
    );
    await addSessionToThread(
      ctx,
      "telegram",
      "t2",
      makeEntry({ sessionId: "s-closed", status: "closed" }),
      2,
    );
    await addSessionToThread(
      ctx,
      "telegram",
      "t2",
      makeEntry({ sessionId: "s-error", status: "error" }),
      2,
    );

    // Only 1 active, so adding another should work (cap=2)
    const result = await addSessionToThread(
      ctx,
      "telegram",
      "t2",
      makeEntry({ sessionId: "s-new", status: "active" }),
      2,
    );
    expect(result.added).toBe(true);
  });
});

describe("removeSessionFromThread", () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it("removes the specified session entry", async () => {
    await addSessionToThread(ctx, "discord", "t1", makeEntry({ sessionId: "keep" }));
    await addSessionToThread(ctx, "discord", "t1", makeEntry({ sessionId: "remove" }));
    await addSessionToThread(ctx, "discord", "t1", makeEntry({ sessionId: "keep2" }));

    await removeSessionFromThread(ctx, "discord", "t1", "remove");

    const sessions = await getThreadSessions(ctx, "discord", "t1");
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.sessionId)).toEqual(["keep", "keep2"]);
  });

  it("is a no-op when sessionId not found", async () => {
    await addSessionToThread(ctx, "slack", "t1", makeEntry({ sessionId: "exists" }));
    await removeSessionFromThread(ctx, "slack", "t1", "nonexistent");

    const sessions = await getThreadSessions(ctx, "slack", "t1");
    expect(sessions).toHaveLength(1);
  });
});

describe("updateThreadSessionEntry", () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it("updates status and pid of the target entry", async () => {
    await addSessionToThread(ctx, "telegram", "t1", makeEntry({ sessionId: "s1", status: "spawning" }));
    await addSessionToThread(ctx, "telegram", "t1", makeEntry({ sessionId: "s2", status: "spawning" }));

    await updateThreadSessionEntry(ctx, "telegram", "t1", "s1", {
      status: "active",
      pid: 9999,
    });

    const sessions = await getThreadSessions(ctx, "telegram", "t1");
    const s1 = sessions.find((s) => s.sessionId === "s1");
    const s2 = sessions.find((s) => s.sessionId === "s2");

    expect(s1!.status).toBe("active");
    expect(s1!.pid).toBe(9999);
    // s2 should be untouched
    expect(s2!.status).toBe("spawning");
  });

  it("is a no-op when sessionId not found", async () => {
    await addSessionToThread(ctx, "slack", "t1", makeEntry({ sessionId: "s1" }));

    await updateThreadSessionEntry(ctx, "slack", "t1", "nonexistent", {
      status: "error",
    });

    const sessions = await getThreadSessions(ctx, "slack", "t1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("active");
  });
});

describe("findSessionInThread", () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it("finds the matching session entry", async () => {
    const entry = makeEntry({ sessionId: "target", agentName: "gemini" });
    await addSessionToThread(ctx, "discord", "t1", makeEntry({ sessionId: "other" }));
    await addSessionToThread(ctx, "discord", "t1", entry);

    const found = await findSessionInThread(ctx, "discord", "t1", "target");
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe("target");
    expect(found!.agentName).toBe("gemini");
  });

  it("returns null when session not found", async () => {
    const result = await findSessionInThread(ctx, "discord", "t1", "missing");
    expect(result).toBeNull();
  });
});
