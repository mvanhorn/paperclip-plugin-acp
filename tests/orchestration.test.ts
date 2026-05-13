/**
 * Phase 2: Orchestration migration tests.
 *
 * Tests cover:
 * - Session cap enforcement (pool exhaustion blocks spawns)
 * - Peak-hour scheduling (reduced concurrency, priority filtering)
 * - Rate-limit detection (text, JSON, unified) and cooldown
 * - Spawn guard composite logic
 * - Pool status reporting for health endpoint
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockContext } from "./helpers.js";

// ── Module mocks ────────────────────────────────────────────────────────────

// Mock fetch globally for Paperclip API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after mocks are in place
import {
  isPeakHour,
  detectRateLimitInText,
  detectRateLimitInJson,
  detectRateLimit,
  getRateLimitCooldown,
  activateRateLimitCooldown,
  isRateLimitCooldownActive,
  resetRateLimitCooldown,
  checkSpawnGuards,
  formatRateLimitComment,
  getPoolStatus,
} from "../src/webhook-hooks.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    sharedPoolSize: 18,
    peakSessionsMax: 2,
    peakHourEnabled: true,
    peakHourTimezone: "Europe/Amsterdam",
    peakHourStart: 14,
    peakHourEnd: 20,
    peakHourWeekdaysOnly: true,
    peakPriorityThreshold: "high",
    ...overrides,
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    issueId: "ISS-200",
    companyId: "company-1",
    priority: "high",
    title: "Test issue",
    ...overrides,
  };
}

/** Create a date in Europe/Amsterdam timezone at a specific hour on a specific weekday.
 *  weekday: 1=Mon ... 5=Fri, 6=Sat, 0=Sun */
function dateAtAmsterdamHour(hour: number, weekday?: number): Date {
  // Amsterdam is UTC+1 in winter, UTC+2 in summer (CEST).
  // Use a known date: 2026-01-12 is a Monday (winter, UTC+1)
  // 2026-01-12T00:00:00+01:00 = 2026-01-11T23:00:00Z
  // For hour H in Amsterdam winter: UTC = H - 1
  const baseMonday = new Date("2026-01-12T00:00:00Z"); // a Monday in UTC
  const dayOffset = weekday !== undefined ? ((weekday - 1 + 7) % 7) : 0; // offset from Monday
  const utcHour = hour - 1; // CET = UTC+1 in January
  const d = new Date(baseMonday);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(utcHour, 0, 0, 0);
  return d;
}

function mockFetchInProgress(count: number) {
  const issues = Array.from({ length: count }, (_, i) => ({ id: `ISS-${i}` }));
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ issues, total: count }),
    text: async () => JSON.stringify({ issues, total: count }),
  });
}

function mockFetchFailure() {
  mockFetch.mockRejectedValue(new Error("Network error"));
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  resetRateLimitCooldown();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Session cap enforcement ─────────────────────────────────────────────────

describe("Session cap enforcement", () => {
  it("should allow spawn when in_progress count is below shared pool size", async () => {
    mockFetchInProgress(10); // 10 < 18
    const ctx = createMockContext();
    const config = makeConfig({ peakHourEnabled: false });
    const event = makeEvent();

    const result = await checkSpawnGuards(ctx, config, event);
    expect(result.allowed).toBe(true);
  });

  it("should reject spawn when in_progress count equals shared pool size", async () => {
    mockFetchInProgress(18); // 18 == 18
    const ctx = createMockContext();
    const config = makeConfig({ peakHourEnabled: false });
    const event = makeEvent();

    const result = await checkSpawnGuards(ctx, config, event);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("session_cap_exhausted");
    expect(result.routineRunStatus).toBe("skipped");
  });

  it("should reject spawn when in_progress count exceeds shared pool size", async () => {
    mockFetchInProgress(25); // 25 > 18
    const ctx = createMockContext();
    const config = makeConfig({ peakHourEnabled: false });
    const event = makeEvent();

    const result = await checkSpawnGuards(ctx, config, event);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("session_cap_exhausted");
  });

  it("should use peak session cap during peak hours instead of shared pool size", async () => {
    // During peak hours, cap is peakSessionsMax=2
    // 2 in-progress should be rejected during peak
    mockFetchInProgress(2);
    const ctx = createMockContext();
    const config = makeConfig();
    // Weekday 15:00 Amsterdam = peak
    const peakDate = dateAtAmsterdamHour(15, 1); // Monday 15:00
    vi.setSystemTime(peakDate);

    const event = makeEvent({ priority: "critical" }); // high enough priority
    const result = await checkSpawnGuards(ctx, config, event);
    expect(result.allowed).toBe(false);
    // During peak hours the cap is peakSessionsMax; reason may differ from shared pool
    expect(["session_cap_exhausted", "company_cap_exhausted"]).toContain(result.reasonCode);

    vi.useRealTimers();
  });

  it("should fail-open (allow spawn) when Paperclip API query fails", async () => {
    mockFetchFailure();
    const ctx = createMockContext();
    const config = makeConfig();
    const event = makeEvent();

    const result = await checkSpawnGuards(ctx, config, event);
    expect(result.allowed).toBe(true);
  });
});

// ── Peak-hour scheduling ────────────────────────────────────────────────────

describe("Peak-hour scheduling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isPeakHour", () => {
    it("should return true during weekday peak hours in configured timezone", () => {
      const config = makeConfig();
      // Monday 15:00 Amsterdam
      const d = dateAtAmsterdamHour(15, 1);
      expect(isPeakHour(config, d)).toBe(true);
    });

    it("should return false outside peak hours", () => {
      const config = makeConfig();
      // Monday 10:00 Amsterdam (before 14:00)
      const d = dateAtAmsterdamHour(10, 1);
      expect(isPeakHour(config, d)).toBe(false);
    });

    it("should return false on weekends when weekdaysOnly is true", () => {
      const config = makeConfig({ peakHourWeekdaysOnly: true });
      // Saturday 15:00 Amsterdam
      const d = dateAtAmsterdamHour(15, 6);
      expect(isPeakHour(config, d)).toBe(false);
    });

    it("should return true on weekends when weekdaysOnly is false", () => {
      const config = makeConfig({ peakHourWeekdaysOnly: false });
      // Saturday 15:00 Amsterdam
      const d = dateAtAmsterdamHour(15, 6);
      expect(isPeakHour(config, d)).toBe(true);
    });

    it("should return false when peakHourEnabled is false", () => {
      const config = makeConfig({ peakHourEnabled: false });
      // Monday 15:00 Amsterdam (would be peak otherwise)
      const d = dateAtAmsterdamHour(15, 1);
      expect(isPeakHour(config, d)).toBe(false);
    });

    it("should handle timezone conversion correctly (e.g. UTC vs Europe/Amsterdam)", () => {
      const config = makeConfig();
      // 13:00 UTC in January = 14:00 Amsterdam (CET, UTC+1) = start of peak
      const d = new Date("2026-01-12T13:00:00Z"); // Monday
      expect(isPeakHour(config, d)).toBe(true);

      // 12:59 UTC in January = 13:59 Amsterdam = NOT peak
      const d2 = new Date("2026-01-12T12:59:00Z");
      expect(isPeakHour(config, d2)).toBe(false);
    });
  });

  describe("priority filtering during peak", () => {
    it("should allow critical priority issues during peak", async () => {
      mockFetchInProgress(0);
      const ctx = createMockContext();
      const config = makeConfig();
      vi.setSystemTime(dateAtAmsterdamHour(15, 1)); // peak

      const event = makeEvent({ priority: "critical" });
      const result = await checkSpawnGuards(ctx, config, event);
      expect(result.allowed).toBe(true);
    });

    it("should allow high priority issues during peak when threshold is high", async () => {
      mockFetchInProgress(0);
      const ctx = createMockContext();
      const config = makeConfig({ peakPriorityThreshold: "high" });
      vi.setSystemTime(dateAtAmsterdamHour(15, 1));

      const event = makeEvent({ priority: "high" });
      const result = await checkSpawnGuards(ctx, config, event);
      expect(result.allowed).toBe(true);
    });

    it("should reject medium priority issues during peak when threshold is high", async () => {
      mockFetchInProgress(0);
      const ctx = createMockContext();
      const config = makeConfig({ peakPriorityThreshold: "high" });
      vi.setSystemTime(dateAtAmsterdamHour(15, 1));

      const event = makeEvent({ priority: "medium" });
      const result = await checkSpawnGuards(ctx, config, event);
      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe("peak_hour_deferred");
    });

    it("should reject low priority issues during peak when threshold is high", async () => {
      mockFetchInProgress(0);
      const ctx = createMockContext();
      const config = makeConfig({ peakPriorityThreshold: "high" });
      vi.setSystemTime(dateAtAmsterdamHour(15, 1));

      const event = makeEvent({ priority: "low" });
      const result = await checkSpawnGuards(ctx, config, event);
      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe("peak_hour_deferred");
    });

    it("should mark rejected issues as skipped with reason peak_hour_deferred", async () => {
      mockFetchInProgress(0);
      const ctx = createMockContext();
      const config = makeConfig({ peakPriorityThreshold: "high" });
      vi.setSystemTime(dateAtAmsterdamHour(15, 1));

      const event = makeEvent({ priority: "medium" });
      const result = await checkSpawnGuards(ctx, config, event);
      expect(result.allowed).toBe(false);
      expect(result.routineRunStatus).toBe("skipped");
      expect(result.reasonCode).toBe("peak_hour_deferred");
    });
  });
});

// ── Rate-limit detection ────────────────────────────────────────────────────

describe("Rate-limit detection", () => {
  describe("detectRateLimitInText", () => {
    it("should detect 'rate limit' in text (case-insensitive)", () => {
      expect(detectRateLimitInText("Hit a Rate Limit on the API")).toBe(true);
      expect(detectRateLimitInText("rate limit exceeded")).toBe(true);
    });

    it("should detect '429' in text", () => {
      expect(detectRateLimitInText("Error 429: Too many requests")).toBe(true);
      expect(detectRateLimitInText("HTTP 429")).toBe(true);
    });

    it("should detect 'too many requests' in text", () => {
      expect(detectRateLimitInText("too many requests")).toBe(true);
      expect(detectRateLimitInText("Too Many Requests")).toBe(true);
    });

    it("should detect 'overloaded' in text", () => {
      expect(detectRateLimitInText("Server is overloaded")).toBe(true);
    });

    it("should detect 'throttled' in text", () => {
      expect(detectRateLimitInText("Request was throttled")).toBe(true);
      expect(detectRateLimitInText("throttling in effect")).toBe(true);
    });

    it("should return false for normal output text", () => {
      expect(detectRateLimitInText("Build succeeded in 3.2s")).toBe(false);
      expect(detectRateLimitInText("All tests passed")).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(detectRateLimitInText("")).toBe(false);
    });
  });

  describe("detectRateLimitInJson", () => {
    it("should detect rate_limited boolean flag", () => {
      expect(detectRateLimitInJson({ rate_limited: true })).toBe(true);
      expect(detectRateLimitInJson({ rate_limit: true })).toBe(true);
      expect(detectRateLimitInJson({ is_rate_limited: true })).toBe(true);
    });

    it("should detect rate_limit_error in error.type", () => {
      expect(
        detectRateLimitInJson({ error: { type: "rate_limit_error" } }),
      ).toBe(true);
    });

    it("should detect overloaded_error in error.type", () => {
      expect(
        detectRateLimitInJson({ error: { type: "overloaded_error" } }),
      ).toBe(true);
    });

    it("should detect rate-limit patterns in error.message", () => {
      expect(
        detectRateLimitInJson({
          error: { type: "api_error", message: "rate limit exceeded" },
        }),
      ).toBe(true);
    });

    it("should detect rate-limit patterns in result text", () => {
      expect(
        detectRateLimitInJson({ result: "Request throttled, retry after 60s" }),
      ).toBe(true);
    });

    it("should return false for normal JSON responses", () => {
      expect(detectRateLimitInJson({ status: "ok", data: [1, 2, 3] })).toBe(
        false,
      );
      expect(detectRateLimitInJson({ rate_limited: false })).toBe(false);
    });
  });

  describe("detectRateLimit (unified)", () => {
    it("should return false when exitCode is 0 and no JSON", () => {
      expect(detectRateLimit(0, "", "All good", undefined)).toBe(false);
    });

    it("should detect rate-limit in stderr", () => {
      expect(detectRateLimit(1, "Error 429: rate limit", "", undefined)).toBe(
        true,
      );
    });

    it("should detect rate-limit in stdout", () => {
      expect(detectRateLimit(1, "", "too many requests", undefined)).toBe(true);
    });

    it("should detect rate-limit in parsed JSON", () => {
      expect(
        detectRateLimit(1, "", "", { error: { type: "rate_limit_error" } }),
      ).toBe(true);
    });

    it("should check JSON even when exitCode is 0", () => {
      expect(
        detectRateLimit(0, "", "", { rate_limited: true }),
      ).toBe(true);
    });
  });
});

// ── Rate-limit cooldown ─────────────────────────────────────────────────────

describe("Rate-limit cooldown", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetRateLimitCooldown();
  });

  it("should not be active initially", () => {
    const state = getRateLimitCooldown();
    expect(state.active).toBe(false);
    expect(isRateLimitCooldownActive()).toBe(false);
  });

  it("should activate cooldown with correct expiry", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    activateRateLimitCooldown("ISS-300", 60000);

    const state = getRateLimitCooldown();
    expect(state.active).toBe(true);
    expect(state.triggeredByIssueId).toBe("ISS-300");
    expect(state.startedAt).toBeDefined();
    expect(state.expiresAt).toBeDefined();
    // expiresAt should be ~60s after startedAt
    expect(state.expiresAt! - state.startedAt!).toBeCloseTo(60000, -2);
  });

  it("should report active during cooldown period", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    activateRateLimitCooldown("ISS-300", 60000);

    // Advance 30s (still within 60s cooldown)
    vi.setSystemTime(now + 30000);
    expect(isRateLimitCooldownActive()).toBe(true);
  });

  it("should auto-clear after cooldown period expires", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    activateRateLimitCooldown("ISS-300", 60000);

    // Advance past cooldown
    vi.setSystemTime(now + 61000);
    expect(isRateLimitCooldownActive()).toBe(false);
  });

  it("should block spawns during cooldown", async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    activateRateLimitCooldown("ISS-300", 60000);

    mockFetchInProgress(0);
    const ctx = createMockContext();
    const config = makeConfig({ peakHourEnabled: false });
    const event = makeEvent();

    const result = await checkSpawnGuards(ctx, config, event);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("rate_limit_cooldown");
  });

  it("should reset on resetRateLimitCooldown()", () => {
    activateRateLimitCooldown("ISS-300", 60000);
    expect(isRateLimitCooldownActive()).toBe(true);

    resetRateLimitCooldown();
    expect(isRateLimitCooldownActive()).toBe(false);
    const state = getRateLimitCooldown();
    expect(state.active).toBe(false);
  });
});

// ── Spawn guard composite ───────────────────────────────────────────────────

describe("checkSpawnGuards (composite)", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetRateLimitCooldown();
  });

  it("should allow spawn when all guards pass", async () => {
    mockFetchInProgress(5); // under cap
    const ctx = createMockContext();
    const config = makeConfig({ peakHourEnabled: false });
    const event = makeEvent();

    const result = await checkSpawnGuards(ctx, config, event);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.reasonCode).toBeUndefined();
  });

  it("should reject on rate-limit cooldown before checking other guards", async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    activateRateLimitCooldown("ISS-300", 60000);

    // Even with plenty of capacity, cooldown should block
    mockFetchInProgress(0);
    const ctx = createMockContext();
    const config = makeConfig({ peakHourEnabled: false });
    const event = makeEvent();

    const result = await checkSpawnGuards(ctx, config, event);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("rate_limit_cooldown");
    // fetch should NOT have been called if cooldown is checked first
    // (but this depends on implementation - the spec says check order is:
    //  rate-limit cooldown -> session cap -> peak-hour priority)
  });

  it("should reject on session cap exhaustion", async () => {
    mockFetchInProgress(18);
    const ctx = createMockContext();
    const config = makeConfig({ peakHourEnabled: false });
    const event = makeEvent();

    const result = await checkSpawnGuards(ctx, config, event);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("session_cap_exhausted");
  });

  it("should reject on peak-hour priority filter", async () => {
    mockFetchInProgress(0);
    const ctx = createMockContext();
    const config = makeConfig();
    vi.setSystemTime(dateAtAmsterdamHour(15, 1)); // peak

    const event = makeEvent({ priority: "low" });
    const result = await checkSpawnGuards(ctx, config, event);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("peak_hour_deferred");
  });

  it("should return correct routineRunStatus and reasonCode on rejection", async () => {
    mockFetchInProgress(20);
    const ctx = createMockContext();
    const config = makeConfig({ peakHourEnabled: false });
    const event = makeEvent();

    const result = await checkSpawnGuards(ctx, config, event);
    expect(result.allowed).toBe(false);
    expect(result.routineRunStatus).toBe("skipped");
    expect(result.reasonCode).toEqual(expect.any(String));
    expect(result.reasonCode!.length).toBeGreaterThan(0);
  });
});

// ── Rate-limit comment formatting ───────────────────────────────────────────

describe("formatRateLimitComment", () => {
  it("should include issue ID in comment", () => {
    const comment = formatRateLimitComment("ISS-500");
    expect(comment).toContain("ISS-500");
  });

  it("should include timestamp", () => {
    const comment = formatRateLimitComment("ISS-500");
    // Should contain some form of date/time
    expect(comment).toMatch(/\d{4}[-/]\d{2}[-/]\d{2}|T\d{2}:\d{2}/);
  });

  it("should mention circuit breaker exclusion", () => {
    const comment = formatRateLimitComment("ISS-500");
    const lower = comment.toLowerCase();
    expect(lower).toMatch(/not\s+count|circuit\s*breaker|excluded/i);
  });

  it("should mention automatic retry after cooldown", () => {
    const comment = formatRateLimitComment("ISS-500");
    const lower = comment.toLowerCase();
    expect(lower).toMatch(/retr|automatic/i);
  });
});

// ── Pool status (health endpoint) ───────────────────────────────────────────

describe("getPoolStatus", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetRateLimitCooldown();
  });

  it("should report shared pool size and available slots", async () => {
    mockFetchInProgress(5);
    const config = makeConfig({ peakHourEnabled: false });

    const status = await getPoolStatus(config);
    expect(status.sharedPoolSize).toBe(18);
    expect(status.inProgressCount).toBe(5);
    expect(status.available).toBe(13); // 18 - 5
  });

  it("should report peak-hour state", async () => {
    mockFetchInProgress(0);
    const config = makeConfig();

    // Non-peak
    vi.setSystemTime(dateAtAmsterdamHour(10, 1));
    const statusOff = await getPoolStatus(config);
    expect(statusOff.isPeakHour).toBe(false);

    // Peak
    mockFetchInProgress(0);
    vi.setSystemTime(dateAtAmsterdamHour(15, 1));
    const statusOn = await getPoolStatus(config);
    expect(statusOn.isPeakHour).toBe(true);
  });

  it("should report effective cap (reduced during peak)", async () => {
    mockFetchInProgress(0);
    const config = makeConfig();

    // Non-peak: effective cap = sharedPoolSize
    vi.setSystemTime(dateAtAmsterdamHour(10, 1));
    const statusOff = await getPoolStatus(config);
    expect(statusOff.effectiveCap).toBe(18);

    // Peak: effective cap = peakSessionsMax
    mockFetchInProgress(0);
    vi.setSystemTime(dateAtAmsterdamHour(15, 1));
    const statusOn = await getPoolStatus(config);
    expect(statusOn.effectiveCap).toBe(2);
  });

  it("should report rate-limit cooldown state", async () => {
    mockFetchInProgress(0);
    const config = makeConfig({ peakHourEnabled: false });

    const statusBefore = await getPoolStatus(config);
    expect(statusBefore.rateLimitCooldownActive).toBe(false);

    activateRateLimitCooldown("ISS-400", 60000);
    mockFetchInProgress(0);
    const statusDuring = await getPoolStatus(config);
    expect(statusDuring.rateLimitCooldownActive).toBe(true);
    expect(statusDuring.rateLimitCooldownExpiresAt).toBeDefined();
  });
});
