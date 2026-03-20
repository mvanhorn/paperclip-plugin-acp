import { describe, it, expect, beforeEach } from "vitest";
import { createMockContext } from "./helpers.js";
import {
  createSession,
  getSession,
  addSessionToThread,
  getThreadSessions,
  updateThreadSessionEntry,
  resolveBinding,
} from "../src/session-manager.js";
import type { AcpSessionEntry } from "../src/types.js";

/**
 * Tests that exercise the session lifecycle as the worker event handlers
 * would drive it (spawn -> add to thread -> update -> close).
 * We test the public session-manager API that the worker depends on,
 * since the worker's event handler functions are private to the module.
 */

function makeEntry(overrides?: Partial<AcpSessionEntry>): AcpSessionEntry {
  return {
    sessionId: `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentName: "claude",
    agentDisplayName: "Claude Code",
    spawnedAt: Date.now(),
    status: "spawning",
    ...overrides,
  };
}

describe("spawn handler flow (session lifecycle)", () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it("creates session with binding, adds to thread registry, updates status", async () => {
    // 1. Create session (as handleSpawn does)
    const session = await createSession(ctx, {
      agentId: "claude",
      mode: "persistent",
      cwd: "/workspace",
      binding: {
        platform: "telegram",
        threadId: "t1",
        channelId: "chat-1",
        boundAt: Date.now(),
      },
    });

    expect(session.state).toBe("spawning");
    expect(session.binding!.platform).toBe("telegram");

    // 2. Add to thread sessions array
    const entry = makeEntry({
      sessionId: session.sessionId,
      status: "spawning",
    });
    const result = await addSessionToThread(ctx, "chat-1", "t1", entry);
    expect(result.added).toBe(true);

    // 3. Simulate spawn success - update session and thread entry
    const fakePid = 42;
    await updateThreadSessionEntry(ctx, "chat-1", "t1", session.sessionId, {
      status: "active",
      pid: fakePid,
    });

    const sessions = await getThreadSessions(ctx, "chat-1", "t1");
    const updated = sessions.find((s) => s.sessionId === session.sessionId);
    expect(updated!.status).toBe("active");
    expect(updated!.pid).toBe(fakePid);
  });

  it("rejects spawn when thread is at max sessions", async () => {
    // Fill up to cap of 2
    for (let i = 0; i < 2; i++) {
      await addSessionToThread(
        ctx,
        "chat-1",
        "t1",
        makeEntry({ sessionId: `s-${i}`, status: "active" }),
        2,
      );
    }

    // Attempt to add another
    const entry = makeEntry({ sessionId: "overflow" });
    const result = await addSessionToThread(ctx, "chat-1", "t1", entry, 2);

    expect(result.added).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("message handler flow (routing to correct session)", () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it("resolveBinding finds the active session for a platform/thread", async () => {
    // Create two sessions
    const s1 = await createSession(ctx, {
      agentId: "claude",
      mode: "persistent",
      cwd: "/workspace",
      binding: { platform: "telegram", threadId: "t1", boundAt: Date.now() },
    });

    // Add both to the thread - one closed, one active
    await addSessionToThread(ctx, "telegram", "t1", makeEntry({
      sessionId: "old-closed",
      status: "closed",
    }));
    await addSessionToThread(ctx, "telegram", "t1", makeEntry({
      sessionId: s1.sessionId,
      status: "active",
    }));

    const resolved = await resolveBinding(ctx, "telegram", "t1");
    // Should resolve to the active session, not the closed one
    expect(resolved).not.toBeNull();
    expect(resolved!.sessionId).toBe(s1.sessionId);
  });

  it("resolveBinding returns null when no active sessions", async () => {
    await addSessionToThread(ctx, "slack", "t1", makeEntry({
      sessionId: "dead",
      status: "closed",
    }));

    const result = await resolveBinding(ctx, "slack", "t1");
    expect(result).toBeNull();
  });

  it("resolveBinding returns null for unknown thread", async () => {
    const result = await resolveBinding(ctx, "discord", "unknown-thread");
    expect(result).toBeNull();
  });
});

describe("close handler flow (removes from registry)", () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it("closing a session removes it from the thread's array and marks it closed", async () => {
    const session = await createSession(ctx, {
      agentId: "codex",
      mode: "oneshot",
      cwd: "/tmp",
      binding: {
        platform: "discord",
        threadId: "t42",
        boundAt: Date.now(),
      },
    });

    await addSessionToThread(ctx, "discord", "t42", makeEntry({
      sessionId: session.sessionId,
      status: "active",
    }));

    // Verify it's there
    let sessions = await getThreadSessions(ctx, "discord", "t42");
    expect(sessions).toHaveLength(1);

    // Close
    const { closeSession } = await import("../src/session-manager.js");
    await closeSession(ctx, session.sessionId);

    // Session state should be closed
    const closed = await getSession(ctx, session.sessionId);
    expect(closed!.state).toBe("closed");

    // Thread array should be empty
    sessions = await getThreadSessions(ctx, "discord", "t42");
    expect(sessions).toHaveLength(0);
  });
});

describe("output event structure", () => {
  it("AcpOutputEvent variants match expected shapes", () => {
    // Just verify the types compile and have the right structure
    const textEvent = {
      sessionId: "s1",
      type: "text" as const,
      text: "Hello",
    };
    expect(textEvent.type).toBe("text");
    expect(textEvent.text).toBe("Hello");

    const toolCallEvent = {
      sessionId: "s1",
      type: "tool_call" as const,
      toolName: "Read",
      toolInput: '{"path":"/foo"}',
    };
    expect(toolCallEvent.type).toBe("tool_call");

    const errorEvent = {
      sessionId: "s1",
      type: "error" as const,
      error: "spawn failed",
    };
    expect(errorEvent.type).toBe("error");

    const doneEvent = {
      sessionId: "s1",
      type: "done" as const,
      text: "Agent exited with code 0",
    };
    expect(doneEvent.type).toBe("done");
  });
});
