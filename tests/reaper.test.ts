import { describe, it, expect } from "vitest";
import { computeReapReason } from "../src/reaper.js";
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
