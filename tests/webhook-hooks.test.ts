/**
 * Tests for ACP webhook hooks.
 *
 * These test stubs validate the three webhook hooks against the spec:
 * - on_issue_status_change: spawns a Claude Code session when an issue moves to in_progress
 * - on_session_complete: writes a performance record to PostgreSQL + updates issue status
 * - on_approval_required: surfaces a Chairman approval request via Cockpit
 *
 * The Code Tester will fill in the test implementations based on the spec
 * and acceptance criteria — without reading the source implementation.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import {
  createMockContext,
  createMockMetrics,
  createMockEvents,
} from "./helpers.js";

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("pg", () => {
  const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  const mockRelease = vi.fn();
  const mockConnect = vi.fn().mockResolvedValue({
    query: mockQuery,
    release: mockRelease,
  });
  const Pool = vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    on: vi.fn().mockReturnThis(),
    end: vi.fn().mockResolvedValue(undefined),
  }));
  return { default: { Pool }, Pool };
});

vi.mock("../src/session-manager.js", () => ({
  createSession: vi.fn().mockResolvedValue({ sessionId: "sess-001" }),
  updateSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/acp-spawn.js", () => ({
  spawnAgent: vi.fn().mockResolvedValue(undefined),
  sendPrompt: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import { onIssueStatusChange, onSessionComplete, onApprovalRequired } from "../src/webhook-hooks.js";
import { createSession, updateSession } from "../src/session-manager.js";
import { spawnAgent, sendPrompt } from "../src/acp-spawn.js";
import { Pool } from "pg";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeIssueEvent(overrides: Record<string, unknown> = {}) {
  return {
    issueId: "ISS-100",
    companyId: "company-1",
    previousStatus: "backlog",
    newStatus: "in_progress",
    title: "Fix login bug",
    description: "Users cannot log in after password reset.",
    priority: "high",
    labels: ["bug", "auth"],
    changedAt: "2026-04-05T10:00:00Z",
    ...overrides,
  };
}

function makeSessionCompleteEvent(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-001",
    issueId: "ISS-100",
    companyId: "company-1",
    agentId: "agent-1",
    exitCode: 0,
    durationMs: 12000,
    promptCount: 5,
    toolCallCount: 10,
    success: true,
    completedAt: "2026-04-05T11:00:00Z",
    ...overrides,
  };
}

function makeApprovalEvent(overrides: Record<string, unknown> = {}) {
  return {
    issueId: "ISS-200",
    companyId: "company-1",
    title: "Deploy to production",
    description: "Release v2.1 to production environment.",
    requestedBy: "agent-alpha",
    priority: "critical",
    requestedAt: "2026-04-05T12:00:00Z",
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    defaultAgent: "claude",
    mode: "autonomous",
    defaultCwd: "/default/cwd",
    paperclipApiUrl: "https://api.paperclip.test",
    ...overrides,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let ctx: ReturnType<typeof createMockContext>;
let config: ReturnType<typeof makeConfig>;
let fetchMock: Mock;
let pgQueryMock: Mock;

beforeEach(() => {
  vi.clearAllMocks();

  ctx = createMockContext();
  config = makeConfig();

  // Mock global.fetch
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
  global.fetch = fetchMock as any;

  // Get reference to the pg query mock
  const poolInstance = new (Pool as any)();
  poolInstance.connect().then((client: any) => {
    pgQueryMock = client.query;
  });
});

// ── on_issue_status_change ───────────────────────────────────────────────────

describe("on_issue_status_change", () => {
  it("spawns a Claude Code session when issue transitions to in_progress", async () => {
    const event = makeIssueEvent();
    const result = await onIssueStatusChange(ctx, config, event);

    expect(result.spawned).toBe(true);
    expect(result.sessionId).toBeTruthy();
    expect(createSession).toHaveBeenCalled();
    expect(spawnAgent).toHaveBeenCalled();
  });

  it("does not spawn when issue transitions to a non-trigger status (e.g. backlog)", async () => {
    const event = makeIssueEvent({ newStatus: "backlog", previousStatus: "todo" });
    const result = await onIssueStatusChange(ctx, config, event);

    expect(result.spawned).toBe(false);
    expect(result.sessionId).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("does not spawn when previousStatus equals newStatus (no-op)", async () => {
    const event = makeIssueEvent({ previousStatus: "in_progress", newStatus: "in_progress" });
    const result = await onIssueStatusChange(ctx, config, event);

    expect(result.spawned).toBe(false);
    expect(result.sessionId).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("builds a ticket prompt containing issue title, description, priority, and labels", async () => {
    const event = makeIssueEvent();
    await onIssueStatusChange(ctx, config, event);

    // The prompt is sent via sendPrompt after spawning
    const promptCall = (sendPrompt as Mock).mock.calls[0];
    const allArgs = JSON.stringify(promptCall);
    expect(allArgs).toContain("Fix login bug");
    expect(allArgs).toContain("ISS-100");
    expect(allArgs).toContain("high");
    expect(allArgs).toContain("bug");
    expect(allArgs).toContain("auth");
    expect(allArgs).toContain("Users cannot log in after password reset.");
  });

  it("writes the issueStatusChangeReceived metric on every invocation", async () => {
    const event = makeIssueEvent({ newStatus: "backlog", previousStatus: "todo" });
    await onIssueStatusChange(ctx, config, event);

    const names = ctx.metrics._writes.map((w: any) => w.name);
    expect(names).toContain("acp.webhook.issue_status_change.received");
  });

  it("writes the issueStatusChangeSpawned metric on successful spawn", async () => {
    const event = makeIssueEvent();
    await onIssueStatusChange(ctx, config, event);

    const names = ctx.metrics._writes.map((w: any) => w.name);
    expect(names).toContain("acp.webhook.issue_status_change.spawned");
  });

  it("writes the issueStatusChangeErrors metric and throws on failure", async () => {
    (createSession as Mock).mockRejectedValueOnce(new Error("session creation failed"));

    const event = makeIssueEvent();
    await expect(onIssueStatusChange(ctx, config, event)).rejects.toThrow();

    const names = ctx.metrics._writes.map((w: any) => w.name);
    expect(names).toContain("acp.webhook.issue_status_change.errors");
  });

  it("uses the configured defaultAgent and defaultCwd when event omits cwd", async () => {
    const event = makeIssueEvent(); // no cwd
    await onIssueStatusChange(ctx, config, event);

    // Check createSession and spawnAgent args for the agent and cwd
    const allCalls = JSON.stringify([
      (createSession as Mock).mock.calls,
      (spawnAgent as Mock).mock.calls,
    ]);
    expect(allCalls).toContain("claude");
    expect(allCalls).toContain("/default/cwd");
  });

  it("uses event.cwd when provided, overriding defaultCwd", async () => {
    const event = makeIssueEvent({ cwd: "/custom/project" });
    await onIssueStatusChange(ctx, config, event);

    const allCalls = JSON.stringify([
      (createSession as Mock).mock.calls,
      (spawnAgent as Mock).mock.calls,
    ]);
    expect(allCalls).toContain("/custom/project");
    expect(allCalls).not.toContain("/default/cwd");
  });
});

// ── on_session_complete ──────────────────────────────────────────────────────

describe("on_session_complete", () => {
  it("writes a performance record to the performance_records table", async () => {
    const event = makeSessionCompleteEvent();
    const result = await onSessionComplete(ctx, event);

    expect(result.recorded).toBe(true);
    // Verify pg query was called with INSERT into performance_records
    const poolInst = new (Pool as any)();
    const client = await poolInst.connect();
    const queryCall = client.query.mock.calls.find((c: any[]) =>
      typeof c[0] === "string" && c[0].toLowerCase().includes("performance_records"),
    );
    expect(queryCall).toBeTruthy();
  });

  it("performance record contains all required fields (session_id, issue_id, company_id, etc.)", async () => {
    const event = makeSessionCompleteEvent({ summary: "All tests pass" });
    await onSessionComplete(ctx, event);

    const poolInst = new (Pool as any)();
    const client = await poolInst.connect();
    // Find the INSERT query call
    const queryCall = client.query.mock.calls.find((c: any[]) =>
      typeof c[0] === "string" && c[0].toLowerCase().includes("performance_records"),
    );
    expect(queryCall).toBeTruthy();
    const sql = queryCall![0].toLowerCase();
    expect(sql).toContain("session_id");
    expect(sql).toContain("issue_id");
    expect(sql).toContain("company_id");
    expect(sql).toContain("agent_id");
    expect(sql).toContain("exit_code");
    expect(sql).toContain("duration_ms");
    expect(sql).toContain("prompt_count");
    expect(sql).toContain("tool_call_count");
    expect(sql).toContain("success");
    expect(sql).toContain("summary");
    expect(sql).toContain("completed_at");
    expect(sql).toContain("recorded_at");
  });

  it("updates the Paperclip issue status to in_review on success", async () => {
    const event = makeSessionCompleteEvent({ success: true });
    const result = await onSessionComplete(ctx, event);

    expect(result.statusUpdated).toBe(true);
    const patchCall = fetchMock.mock.calls.find(
      (c: any[]) => c[1]?.method === "PATCH" && c[0].includes("issues/ISS-100"),
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(patchCall![1].body);
    expect(body.status).toBe("in_review");
  });

  it("updates the Paperclip issue status to in_progress on failure", async () => {
    const event = makeSessionCompleteEvent({ success: false, exitCode: 1 });
    const result = await onSessionComplete(ctx, event);

    expect(result.statusUpdated).toBe(true);
    const patchCall = fetchMock.mock.calls.find(
      (c: any[]) => c[1]?.method === "PATCH" && c[0].includes("issues/ISS-100"),
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(patchCall![1].body);
    expect(body.status).toBe("in_progress");
  });

  it("uses event.targetStatus when explicitly provided", async () => {
    const event = makeSessionCompleteEvent({ success: true, targetStatus: "done" });
    await onSessionComplete(ctx, event);

    const patchCall = fetchMock.mock.calls.find(
      (c: any[]) => c[1]?.method === "PATCH" && c[0].includes("issues/ISS-100"),
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(patchCall![1].body);
    expect(body.status).toBe("done");
  });

  it("posts a comment with the summary when summary is provided", async () => {
    const event = makeSessionCompleteEvent({ summary: "Fixed the login bug successfully" });
    await onSessionComplete(ctx, event);

    const postCall = fetchMock.mock.calls.find(
      (c: any[]) => c[1]?.method === "POST" && c[0].includes("issues/ISS-100/comments"),
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse(postCall![1].body);
    expect(JSON.stringify(body)).toContain("Fixed the login bug successfully");
  });

  it("does not post a comment when summary is absent", async () => {
    const event = makeSessionCompleteEvent(); // no summary
    await onSessionComplete(ctx, event);

    const postCall = fetchMock.mock.calls.find(
      (c: any[]) => c[1]?.method === "POST" && c[0].includes("comments"),
    );
    expect(postCall).toBeUndefined();
  });

  it("emits a performance.recorded event with session and issue metadata", async () => {
    const event = makeSessionCompleteEvent();
    await onSessionComplete(ctx, event);

    const emitted = ctx.events._emitted.find((e: any) => e.event === "performance.recorded");
    expect(emitted).toBeTruthy();
    // Events are emitted as (eventName, companyId, payload)
    const payload = emitted!.args[1] as any;
    expect(payload.sessionId).toBe("sess-001");
    expect(payload.issueId).toBe("ISS-100");
    expect(payload.success).toBe(true);
    expect(payload.durationMs).toBe(12000);
  });

  it("updates internal session state to closed on success, error on failure", async () => {
    // Success case
    const successEvent = makeSessionCompleteEvent({ success: true });
    await onSessionComplete(ctx, successEvent);

    // updateSession should be called with "closed" state on success
    expect(updateSession).toHaveBeenCalledWith(
      ctx,
      "sess-001",
      expect.objectContaining({ state: "closed" }),
    );

    vi.clearAllMocks();

    // Failure case — fresh context
    const ctx2 = createMockContext();
    global.fetch = fetchMock;
    const failEvent = makeSessionCompleteEvent({ success: false, sessionId: "sess-002", exitCode: 1 });
    await onSessionComplete(ctx2, failEvent);

    // updateSession should be called with "error" state on failure
    expect(updateSession).toHaveBeenCalledWith(
      ctx2,
      "sess-002",
      expect.objectContaining({ state: "error" }),
    );
  });

  it("writes the sessionCompleteReceived metric on every invocation", async () => {
    const event = makeSessionCompleteEvent();
    await onSessionComplete(ctx, event);

    const names = ctx.metrics._writes.map((w: any) => w.name);
    expect(names).toContain("acp.webhook.session_complete.received");
  });

  it("writes the sessionCompleteRecorded metric after successful DB write", async () => {
    const event = makeSessionCompleteEvent();
    await onSessionComplete(ctx, event);

    const names = ctx.metrics._writes.map((w: any) => w.name);
    expect(names).toContain("acp.webhook.session_complete.recorded");
  });

  it("writes the sessionCompleteErrors metric and throws on failure", async () => {
    // Make fetch throw to simulate failure
    fetchMock.mockRejectedValueOnce(new Error("network error"));
    // Also need pg to work first, then fetch fails for status update
    // Actually let's make the DB query fail
    const poolInst = new (Pool as any)();
    const client = await poolInst.connect();
    client.query.mockRejectedValueOnce(new Error("db connection failed"));

    const event = makeSessionCompleteEvent();
    await expect(onSessionComplete(ctx, event)).rejects.toThrow();

    const names = ctx.metrics._writes.map((w: any) => w.name);
    expect(names).toContain("acp.webhook.session_complete.errors");
  });
});

// ── on_approval_required ─────────────────────────────────────────────────────

describe("on_approval_required", () => {
  it("sets the Paperclip issue status to in_review (AWAITING_CHAIRMAN)", async () => {
    const event = makeApprovalEvent();
    const result = await onApprovalRequired(ctx, event);

    expect(result.surfaced).toBe(true);
    const patchCall = fetchMock.mock.calls.find(
      (c: any[]) => c[1]?.method === "PATCH" && c[0].includes("issues/ISS-200"),
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(patchCall![1].body);
    expect(body.status).toBe("in_review");
  });

  it("posts an approval request comment with requestedBy and priority", async () => {
    const event = makeApprovalEvent();
    await onApprovalRequired(ctx, event);

    const postCall = fetchMock.mock.calls.find(
      (c: any[]) => c[1]?.method === "POST" && c[0].includes("issues/ISS-200/comments"),
    );
    expect(postCall).toBeTruthy();
    const bodyStr = postCall![1].body;
    expect(bodyStr).toContain("agent-alpha");
    expect(bodyStr).toContain("critical");
    expect(bodyStr.toLowerCase()).toContain("approval");
  });

  it("includes deliberation summary in the comment when provided", async () => {
    const event = makeApprovalEvent({
      deliberationSummary: "Team consensus: proceed with caution",
    });
    await onApprovalRequired(ctx, event);

    const postCall = fetchMock.mock.calls.find(
      (c: any[]) => c[1]?.method === "POST" && c[0].includes("issues/ISS-200/comments"),
    );
    expect(postCall).toBeTruthy();
    const bodyStr = postCall![1].body;
    expect(bodyStr).toContain("Team consensus: proceed with caution");
  });

  it("omits deliberation summary from the comment when not provided", async () => {
    const event = makeApprovalEvent(); // no deliberationSummary
    await onApprovalRequired(ctx, event);

    const postCall = fetchMock.mock.calls.find(
      (c: any[]) => c[1]?.method === "POST" && c[0].includes("issues/ISS-200/comments"),
    );
    expect(postCall).toBeTruthy();
    const bodyStr = postCall![1].body;
    // Should not contain a deliberation section — but since we don't know exact format,
    // just verify the comment exists and doesn't reference a summary
    expect(bodyStr).not.toContain("deliberation");
  });

  it("emits a cockpit.approval_request event with issue metadata", async () => {
    const event = makeApprovalEvent({
      deliberationSummary: "Needs chairman sign-off",
    });
    await onApprovalRequired(ctx, event);

    const emitted = ctx.events._emitted.find(
      (e: any) => e.event === "cockpit.approval_request",
    );
    expect(emitted).toBeTruthy();
    // Events are emitted as (eventName, companyId, payload)
    const payload = emitted!.args[1] as any;
    expect(payload.issueId).toBe("ISS-200");
    expect(payload.title).toBe("Deploy to production");
    expect(payload.priority).toBe("critical");
    expect(payload.requestedBy).toBe("agent-alpha");
    expect(payload.requestedAt).toBe("2026-04-05T12:00:00Z");
    expect(payload.deliberationSummary).toBe("Needs chairman sign-off");
  });

  it("writes the approvalRequiredReceived metric on every invocation", async () => {
    const event = makeApprovalEvent();
    await onApprovalRequired(ctx, event);

    const names = ctx.metrics._writes.map((w: any) => w.name);
    expect(names).toContain("acp.webhook.approval_required.received");
  });

  it("writes the approvalRequiredSurfaced metric on success", async () => {
    const event = makeApprovalEvent();
    await onApprovalRequired(ctx, event);

    const names = ctx.metrics._writes.map((w: any) => w.name);
    expect(names).toContain("acp.webhook.approval_required.surfaced");
  });

  it("writes the approvalRequiredErrors metric and throws on failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const event = makeApprovalEvent();
    await expect(onApprovalRequired(ctx, event)).rejects.toThrow();

    const names = ctx.metrics._writes.map((w: any) => w.name);
    expect(names).toContain("acp.webhook.approval_required.errors");
  });
});

// ── buildTicketPrompt (via on_issue_status_change) ───────────────────────────

describe("buildTicketPrompt (via on_issue_status_change)", () => {
  it("includes the issue title as a markdown header", async () => {
    const event = makeIssueEvent({ title: "Implement OAuth flow" });
    await onIssueStatusChange(ctx, config, event);

    const promptCall = (sendPrompt as Mock).mock.calls[0];
    const prompt = JSON.stringify(promptCall);
    // Title should appear as a markdown header (e.g. "# Ticket: Implement OAuth flow")
    expect(prompt).toContain("Implement OAuth flow");
    expect(prompt).toMatch(/# .+Implement OAuth flow/);
  });

  it("includes issue ID, priority, and labels", async () => {
    const event = makeIssueEvent({
      issueId: "ISS-999",
      priority: "urgent",
      labels: ["frontend", "ux"],
    });
    await onIssueStatusChange(ctx, config, event);

    const prompt = JSON.stringify((sendPrompt as Mock).mock.calls[0]);
    expect(prompt).toContain("ISS-999");
    expect(prompt).toContain("urgent");
    expect(prompt).toContain("frontend");
    expect(prompt).toContain("ux");
  });

  it("includes the full issue description", async () => {
    const event = makeIssueEvent({
      description: "The entire authentication module needs refactoring to support SSO.",
    });
    await onIssueStatusChange(ctx, config, event);

    const prompt = JSON.stringify((sendPrompt as Mock).mock.calls[0]);
    expect(prompt).toContain(
      "The entire authentication module needs refactoring to support SSO.",
    );
  });
});

// ── buildPerformanceRecord (via on_session_complete) ─────────────────────────

describe("buildPerformanceRecord (via on_session_complete)", () => {
  it("maps SessionCompleteEvent fields to snake_case PerformanceRecord", async () => {
    const event = makeSessionCompleteEvent();
    await onSessionComplete(ctx, event);

    const poolInst = new (Pool as any)();
    const client = await poolInst.connect();
    const queryCall = client.query.mock.calls.find((c: any[]) =>
      typeof c[0] === "string" && c[0].toLowerCase().includes("performance_records"),
    );
    expect(queryCall).toBeTruthy();
    // Verify the params contain the mapped values
    const params = queryCall![1];
    expect(params).toContain("sess-001"); // session_id
    expect(params).toContain("ISS-100"); // issue_id
    expect(params).toContain("company-1"); // company_id
    expect(params).toContain("agent-1"); // agent_id
  });

  it("sets summary to null when event.summary is undefined", async () => {
    const event = makeSessionCompleteEvent(); // no summary
    await onSessionComplete(ctx, event);

    const poolInst = new (Pool as any)();
    const client = await poolInst.connect();
    const queryCall = client.query.mock.calls.find((c: any[]) =>
      typeof c[0] === "string" && c[0].toLowerCase().includes("performance_records"),
    );
    expect(queryCall).toBeTruthy();
    const params = queryCall![1] as any[];
    // summary should be null in the params
    expect(params).toContain(null);
  });

  it("sets completed_at from event.completedAt as ISO 8601", async () => {
    const event = makeSessionCompleteEvent({ completedAt: "2026-04-05T11:30:00Z" });
    await onSessionComplete(ctx, event);

    const poolInst = new (Pool as any)();
    const client = await poolInst.connect();
    const queryCall = client.query.mock.calls.find((c: any[]) =>
      typeof c[0] === "string" && c[0].toLowerCase().includes("performance_records"),
    );
    expect(queryCall).toBeTruthy();
    const params = queryCall![1] as any[];
    // completed_at may be stored as ISO 8601 string or Date-equivalent
    const hasCompletedAt = params.some((p: any) => {
      if (typeof p === "string") return p.includes("2026-04-05T11:30:00");
      if (p instanceof Date) return p.toISOString().includes("2026-04-05T11:30:00");
      return false;
    });
    expect(hasCompletedAt).toBe(true);
  });

  it("sets recorded_at to current time as ISO 8601", async () => {
    const now = new Date("2026-04-05T13:00:00Z");
    vi.setSystemTime(now);

    const event = makeSessionCompleteEvent();
    await onSessionComplete(ctx, event);

    const poolInst = new (Pool as any)();
    const client = await poolInst.connect();
    const queryCall = client.query.mock.calls.find((c: any[]) =>
      typeof c[0] === "string" && c[0].toLowerCase().includes("performance_records"),
    );
    expect(queryCall).toBeTruthy();
    const params = queryCall![1] as any[];
    // recorded_at should be close to "now"
    const isoParams = params.filter(
      (p: any) => typeof p === "string" && /^\d{4}-\d{2}-\d{2}T/.test(p),
    );
    expect(isoParams).toContain(now.toISOString());

    vi.useRealTimers();
  });
});

// ── buildApprovalComment (via on_approval_required) ──────────────────────────

describe("buildApprovalComment (via on_approval_required)", () => {
  it("includes the requestedBy and priority in the comment", async () => {
    const event = makeApprovalEvent({
      requestedBy: "agent-beta",
      priority: "high",
    });
    await onApprovalRequired(ctx, event);

    const postCall = fetchMock.mock.calls.find(
      (c: any[]) => c[1]?.method === "POST" && c[0].includes("comments"),
    );
    expect(postCall).toBeTruthy();
    const bodyStr = postCall![1].body;
    expect(bodyStr).toContain("agent-beta");
    expect(bodyStr).toContain("high");
  });

  it("includes deliberation summary when present", async () => {
    const event = makeApprovalEvent({
      deliberationSummary: "Risk assessment: medium. Three agents concur.",
    });
    await onApprovalRequired(ctx, event);

    const postCall = fetchMock.mock.calls.find(
      (c: any[]) => c[1]?.method === "POST" && c[0].includes("comments"),
    );
    expect(postCall).toBeTruthy();
    expect(postCall![1].body).toContain(
      "Risk assessment: medium. Three agents concur.",
    );
  });

  it("includes a Cockpit review prompt", async () => {
    const event = makeApprovalEvent();
    await onApprovalRequired(ctx, event);

    const postCall = fetchMock.mock.calls.find(
      (c: any[]) => c[1]?.method === "POST" && c[0].includes("comments"),
    );
    expect(postCall).toBeTruthy();
    const bodyStr = postCall![1].body.toLowerCase();
    // The comment should prompt for Cockpit review
    expect(bodyStr).toContain("cockpit");
    expect(bodyStr).toContain("review");
  });
});
