import { describe, it, expect, beforeEach } from "vitest";
import { computeReapReason, reapSessionIfDue } from "../src/reaper.js";
import { createSession, closeSession } from "../src/session-manager.js";
import { createMockContext } from "./helpers.js";
import { METRIC_NAMES } from "../src/constants.js";
import type { AcpSession } from "../src/types.js";

type ReapSession = Pick<AcpSession, "state" | "lastActivityAt" | "createdAt">;

const IDLE_MS = 30 * 60_000; // 30 min
const MAX_AGE_MS = 8 * 3600_000; // 8 hr

describe("computeReapReason", () => {
  // Fixed epoch ~= 2023-11-14; realistic so timestamps don't go negative
  // when subtracting hour/day offsets in test cases.
  const now = 1_700_000_000_000;

  it("reaps when idle timeout is exceeded", () => {
    const session: ReapSession = {
      state: "active",
      lastActivityAt: now - 31 * 60_000,
      createdAt: now - 60_000,
    };
    expect(computeReapReason(now, session, IDLE_MS, MAX_AGE_MS)).toBe(
      "idle timeout exceeded",
    );
  });

  it("reaps when max age is exceeded but session is otherwise active", () => {
    const session: ReapSession = {
      state: "active",
      lastActivityAt: now - 1_000,
      createdAt: now - 9 * 3600_000,
    };
    expect(computeReapReason(now, session, IDLE_MS, MAX_AGE_MS)).toBe(
      "max age exceeded",
    );
  });

  it("reports idle timeout when both thresholds are exceeded (idle takes precedence)", () => {
    const session: ReapSession = {
      state: "active",
      lastActivityAt: now - 31 * 60_000,
      createdAt: now - 9 * 3600_000,
    };
    expect(computeReapReason(now, session, IDLE_MS, MAX_AGE_MS)).toBe(
      "idle timeout exceeded",
    );
  });

  const stale = {
    lastActivityAt: now - 99 * 3600_000,
    createdAt: now - 99 * 3600_000,
  };

  it("skips sessions already in a closed state", () => {
    const closed: ReapSession = { ...stale, state: "closed" };
    expect(computeReapReason(now, closed, IDLE_MS, MAX_AGE_MS)).toBeNull();
  });

  it("skips sessions already in an error state", () => {
    const errored: ReapSession = { ...stale, state: "error" };
    expect(computeReapReason(now, errored, IDLE_MS, MAX_AGE_MS)).toBeNull();
  });

  it("does not reap sessions within both thresholds", () => {
    const session: ReapSession = {
      state: "active",
      lastActivityAt: now - 5_000,
      createdAt: now - 60_000,
    };
    expect(computeReapReason(now, session, IDLE_MS, MAX_AGE_MS)).toBeNull();
  });
});

describe("reapSessionIfDue (emits acp.sessions.reaped counter)", () => {
  let ctx: ReturnType<typeof createMockContext>;
  const idleTimeoutMs = IDLE_MS;
  const maxAgeMs = MAX_AGE_MS;

  beforeEach(() => {
    ctx = createMockContext();
  });

  async function seedSession(overrides: Partial<AcpSession>): Promise<string> {
    const s = await createSession(ctx, {
      agentId: "claude",
      mode: "persistent",
      cwd: "/workspace",
    });
    // Backdate fields the reaper inspects.
    const now = Date.now();
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `acp-session:${s.sessionId}` },
      {
        ...s,
        lastActivityAt: overrides.lastActivityAt ?? now,
        createdAt: overrides.createdAt ?? now,
        state: overrides.state ?? "active",
      },
    );
    return s.sessionId;
  }

  function countReaped(): number {
    return (ctx.metrics._writes as Array<{ name: string; value: number }>)
      .filter((w) => w.name === METRIC_NAMES.sessionsReaped)
      .reduce((n, w) => n + w.value, 0);
  }

  it("emits acp.sessions.reaped exactly once when idle timeout is exceeded", async () => {
    const now = Date.now();
    const sessionId = await seedSession({
      lastActivityAt: now - 31 * 60_000,
      createdAt: now - 60_000,
    });
    const killed: string[] = [];
    const result = await reapSessionIfDue(ctx, sessionId, {
      killSession: (id) => {
        killed.push(id);
        return true;
      },
      now,
      idleTimeoutMs,
      maxAgeMs,
    });
    expect(result.reaped).toBe(true);
    expect(result.reason).toBe("idle timeout exceeded");
    expect(killed).toEqual([sessionId]);
    expect(countReaped()).toBe(1);
  });

  it("emits acp.sessions.reaped exactly once when max age is exceeded", async () => {
    const now = Date.now();
    const sessionId = await seedSession({
      lastActivityAt: now - 1_000,
      createdAt: now - 9 * 3600_000,
    });
    const result = await reapSessionIfDue(ctx, sessionId, {
      killSession: () => true,
      now,
      idleTimeoutMs,
      maxAgeMs,
    });
    expect(result.reaped).toBe(true);
    expect(result.reason).toBe("max age exceeded");
    expect(countReaped()).toBe(1);
  });

  it("does not emit the counter when the session is within thresholds", async () => {
    const now = Date.now();
    const sessionId = await seedSession({
      lastActivityAt: now - 1_000,
      createdAt: now - 1_000,
    });
    const killed: string[] = [];
    const result = await reapSessionIfDue(ctx, sessionId, {
      killSession: (id) => {
        killed.push(id);
        return true;
      },
      now,
      idleTimeoutMs,
      maxAgeMs,
    });
    expect(result.reaped).toBe(false);
    expect(killed).toEqual([]);
    expect(countReaped()).toBe(0);
  });

  it("does not emit the counter when the manual closeSession path is used", async () => {
    const sessionId = await seedSession({});
    await closeSession(ctx, sessionId);
    expect(countReaped()).toBe(0);
  });

  it("does not emit the counter when closeSession throws during reap", async () => {
    const now = Date.now();
    const sessionId = await seedSession({
      lastActivityAt: now - 31 * 60_000,
      createdAt: now - 60_000,
    });
    // Force ctx.state.set to reject on the next write (closeSession path).
    const origSet = ctx.state.set;
    let calls = 0;
    ctx.state.set = async (
      opts: { scopeKind: string; stateKey: string },
      value: unknown,
    ) => {
      calls += 1;
      if (calls >= 1) throw new Error("state write failed");
      return origSet(opts, value);
    };
    await expect(
      reapSessionIfDue(ctx, sessionId, {
        killSession: () => true,
        now,
        idleTimeoutMs,
        maxAgeMs,
      }),
    ).rejects.toThrow("state write failed");
    expect(countReaped()).toBe(0);
  });
});
