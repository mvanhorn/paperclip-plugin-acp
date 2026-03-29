import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createMockContext } from "./helpers.js";
import type { AcpSession, AcpOutputEvent, AcpAgentConfig } from "../src/types.js";
import { METRIC_NAMES } from "../src/constants.js";

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock getAgent
const mockGetAgent = vi.fn();
vi.mock("../src/agents.js", () => ({
  getAgent: (...args: unknown[]) => mockGetAgent(...args),
}));

// Mock updateSession
const mockUpdateSession = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/session-manager.js", () => ({
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
}));

// Import after mocks are set up
const { spawnAgent, sendPrompt, cancelSession, killSession, getActiveSessionIds } =
  await import("../src/acp-spawn.js");

function makeAgent(id: string): AcpAgentConfig {
  return {
    id,
    command: id,
    args: [],
    displayName: `${id.charAt(0).toUpperCase()}${id.slice(1)} Agent`,
    description: `Test ${id} agent`,
  };
}

function makeSession(overrides?: Partial<AcpSession>): AcpSession {
  return {
    sessionId: `acp-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId: "claude",
    mode: "persistent",
    cwd: "/workspace",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    state: "spawning",
    ...overrides,
  };
}

/** Creates a fake ChildProcess (EventEmitter with stdin/stdout/stderr). */
function createFakeChild(pid = 12345) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: { writable: boolean; write: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdin = { writable: true, write: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("spawnAgent", () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
    mockUpdateSession.mockResolvedValue(undefined);
    // Clean active processes by killing any leftover sessions
    for (const id of getActiveSessionIds()) {
      killSession(id);
    }
  });

  // --- Happy path: each agent type ---

  it("spawns a claude agent and sets state to active", async () => {
    const child = createFakeChild(111);
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ agentId: "claude", sessionId: "s-claude" });
    const events: AcpOutputEvent[] = [];

    await spawnAgent(ctx, session, (e) => events.push(e));

    expect(mockSpawn).toHaveBeenCalledWith("claude", [], expect.objectContaining({
      cwd: "/workspace",
      stdio: ["pipe", "pipe", "pipe"],
    }));
    expect(mockUpdateSession).toHaveBeenCalledWith(ctx, "s-claude", {
      state: "active",
      pid: 111,
    });
    expect(getActiveSessionIds()).toContain("s-claude");
  });

  it("spawns a codex agent", async () => {
    const child = createFakeChild(222);
    mockGetAgent.mockReturnValue(makeAgent("codex"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ agentId: "codex", sessionId: "s-codex" });

    await spawnAgent(ctx, session, () => {});

    expect(mockSpawn).toHaveBeenCalledWith("codex", [], expect.any(Object));
    expect(getActiveSessionIds()).toContain("s-codex");
  });

  it("spawns a gemini agent", async () => {
    const child = createFakeChild(333);
    mockGetAgent.mockReturnValue(makeAgent("gemini"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ agentId: "gemini", sessionId: "s-gemini" });

    await spawnAgent(ctx, session, () => {});

    expect(mockSpawn).toHaveBeenCalledWith("gemini", [], expect.any(Object));
    expect(getActiveSessionIds()).toContain("s-gemini");
  });

  it("spawns an opencode agent", async () => {
    const child = createFakeChild(444);
    mockGetAgent.mockReturnValue(makeAgent("opencode"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ agentId: "opencode", sessionId: "s-opencode" });

    await spawnAgent(ctx, session, () => {});

    expect(mockSpawn).toHaveBeenCalledWith("opencode", [], expect.any(Object));
    expect(getActiveSessionIds()).toContain("s-opencode");
  });

  it("writes sessionsSpawned metric on successful spawn", async () => {
    const child = createFakeChild();
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ sessionId: "s-metric" });

    await spawnAgent(ctx, session, () => {});

    const metric = ctx.metrics._writes.find(
      (w: { name: string }) => w.name === METRIC_NAMES.sessionsSpawned,
    );
    expect(metric).toBeDefined();
    expect(metric!.value).toBe(1);
  });

  // --- Edge case: unknown agent ---

  it("emits error event for unknown agent id", async () => {
    mockGetAgent.mockReturnValue(undefined);
    const session = makeSession({ agentId: "unknown-agent", sessionId: "s-unknown" });
    const events: AcpOutputEvent[] = [];

    await spawnAgent(ctx, session, (e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(events[0].error).toContain("Unknown agent: unknown-agent");
    expect(mockUpdateSession).toHaveBeenCalledWith(ctx, "s-unknown", { state: "error" });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  // --- Error paths ---

  it("handles spawn throwing synchronously", async () => {
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockImplementation(() => {
      throw new Error("ENOENT: command not found");
    });
    const session = makeSession({ sessionId: "s-throw" });
    const events: AcpOutputEvent[] = [];

    await spawnAgent(ctx, session, (e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(events[0].error).toContain("Spawn failed");
    expect(events[0].error).toContain("ENOENT");
    expect(mockUpdateSession).toHaveBeenCalledWith(ctx, "s-throw", { state: "error" });

    const errorMetric = ctx.metrics._writes.find(
      (w: { name: string }) => w.name === METRIC_NAMES.spawnErrors,
    );
    expect(errorMetric).toBeDefined();
  });

  it("handles child process error event", async () => {
    const child = createFakeChild();
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ sessionId: "s-err-event" });
    const events: AcpOutputEvent[] = [];

    await spawnAgent(ctx, session, (e) => events.push(e));

    // Simulate error event
    child.emit("error", new Error("EPERM: permission denied"));

    // Allow async handlers to flush
    await new Promise((r) => setTimeout(r, 10));

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.error).toContain("Failed to spawn");
    expect(errorEvent!.error).toContain("EPERM");
    expect(getActiveSessionIds()).not.toContain("s-err-event");
  });

  // --- Session lifecycle: close events ---

  it("sets state to closed on exit code 0", async () => {
    const child = createFakeChild();
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ sessionId: "s-close-ok" });
    const events: AcpOutputEvent[] = [];

    await spawnAgent(ctx, session, (e) => events.push(e));

    child.emit("close", 0);
    await new Promise((r) => setTimeout(r, 10));

    expect(mockUpdateSession).toHaveBeenCalledWith(ctx, "s-close-ok", { state: "closed" });

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.text).toContain("exited with code 0");

    const closedMetric = ctx.metrics._writes.find(
      (w: { name: string }) => w.name === METRIC_NAMES.sessionsClosed,
    );
    expect(closedMetric).toBeDefined();
    expect(getActiveSessionIds()).not.toContain("s-close-ok");
  });

  it("sets state to error on non-zero exit code", async () => {
    const child = createFakeChild();
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ sessionId: "s-close-err" });
    const events: AcpOutputEvent[] = [];

    await spawnAgent(ctx, session, (e) => events.push(e));

    child.emit("close", 1);
    await new Promise((r) => setTimeout(r, 10));

    expect(mockUpdateSession).toHaveBeenCalledWith(ctx, "s-close-err", { state: "error" });

    const errorMetric = ctx.metrics._writes.find(
      (w: { name: string }) => w.name === METRIC_NAMES.spawnErrors,
    );
    expect(errorMetric).toBeDefined();
  });

  // --- stdout NDJSON parsing ---

  it("parses NDJSON session/update text messages from stdout", async () => {
    const child = createFakeChild();
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ sessionId: "s-ndjson" });
    const events: AcpOutputEvent[] = [];

    await spawnAgent(ctx, session, (e) => events.push(e));

    const msg = JSON.stringify({
      method: "session/update",
      params: { type: "text", text: "Hello world" },
    });
    child.stdout.emit("data", Buffer.from(msg + "\n"));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("text");
    expect(events[0].text).toBe("Hello world");
  });

  it("parses tool_call messages from stdout", async () => {
    const child = createFakeChild();
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ sessionId: "s-toolcall" });
    const events: AcpOutputEvent[] = [];

    await spawnAgent(ctx, session, (e) => events.push(e));

    const msg = JSON.stringify({
      method: "session/update",
      params: { type: "tool_call", name: "read_file", input: { path: "/tmp/x" } },
    });
    child.stdout.emit("data", Buffer.from(msg + "\n"));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_call");
    expect(events[0].toolName).toBe("read_file");
    expect(events[0].toolInput).toBe(JSON.stringify({ path: "/tmp/x" }));
  });

  it("emits plain text for non-JSON stdout lines", async () => {
    const child = createFakeChild();
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ sessionId: "s-plain" });
    const events: AcpOutputEvent[] = [];

    await spawnAgent(ctx, session, (e) => events.push(e));

    child.stdout.emit("data", Buffer.from("plain text line\n"));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("text");
    expect(events[0].text).toBe("plain text line");
  });

  it("handles partial NDJSON lines across chunks", async () => {
    const child = createFakeChild();
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ sessionId: "s-partial" });
    const events: AcpOutputEvent[] = [];

    await spawnAgent(ctx, session, (e) => events.push(e));

    const fullMsg = JSON.stringify({
      method: "session/update",
      params: { type: "text", text: "split message" },
    });
    const half = Math.floor(fullMsg.length / 2);

    // Send first half (no newline - should buffer)
    child.stdout.emit("data", Buffer.from(fullMsg.slice(0, half)));
    expect(events).toHaveLength(0);

    // Send second half with newline
    child.stdout.emit("data", Buffer.from(fullMsg.slice(half) + "\n"));
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe("split message");
  });

  it("handles fallback JSON with result/content fields", async () => {
    const child = createFakeChild();
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ sessionId: "s-fallback" });
    const events: AcpOutputEvent[] = [];

    await spawnAgent(ctx, session, (e) => events.push(e));

    const msg = JSON.stringify({ result: "some result data" });
    child.stdout.emit("data", Buffer.from(msg + "\n"));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("text");
    expect(events[0].text).toBe(JSON.stringify("some result data"));
  });
});

describe("sendPrompt", () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
    mockUpdateSession.mockResolvedValue(undefined);
    for (const id of getActiveSessionIds()) {
      killSession(id);
    }
  });

  it("returns false when no active process for sessionId", async () => {
    const result = await sendPrompt(ctx, "nonexistent", "hello");
    expect(result).toBe(false);
  });

  it("writes to stdin and returns true for active session", async () => {
    // Spawn a session first to register a process
    const child = createFakeChild();
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ sessionId: "s-prompt" });
    await spawnAgent(ctx, session, () => {});

    const result = await sendPrompt(ctx, "s-prompt", "do something");

    expect(result).toBe(true);
    expect(child.stdin.write).toHaveBeenCalledWith("do something\n");

    const promptMetric = ctx.metrics._writes.find(
      (w: { name: string }) => w.name === METRIC_NAMES.promptsSent,
    );
    expect(promptMetric).toBeDefined();
  });

  it("returns false when stdin is not writable", async () => {
    const child = createFakeChild();
    child.stdin.writable = false;
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockReturnValue(child);
    const session = makeSession({ sessionId: "s-nowrite" });
    await spawnAgent(ctx, session, () => {});

    const result = await sendPrompt(ctx, "s-nowrite", "test");
    expect(result).toBe(false);
  });
});

describe("cancelSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSession.mockResolvedValue(undefined);
    for (const id of getActiveSessionIds()) {
      killSession(id);
    }
  });

  it("returns false for unknown session", () => {
    expect(cancelSession("nonexistent")).toBe(false);
  });

  it("sends SIGINT to the child process", async () => {
    const child = createFakeChild();
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockReturnValue(child);
    const ctx = createMockContext();
    const session = makeSession({ sessionId: "s-cancel" });
    await spawnAgent(ctx, session, () => {});

    const result = cancelSession("s-cancel");

    expect(result).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
  });
});

describe("killSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSession.mockResolvedValue(undefined);
    for (const id of getActiveSessionIds()) {
      killSession(id);
    }
  });

  it("returns false for unknown session", () => {
    expect(killSession("nonexistent")).toBe(false);
  });

  it("sends SIGTERM and removes from active processes", async () => {
    const child = createFakeChild();
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    mockSpawn.mockReturnValue(child);
    const ctx = createMockContext();
    const session = makeSession({ sessionId: "s-kill" });
    await spawnAgent(ctx, session, () => {});

    expect(getActiveSessionIds()).toContain("s-kill");
    const result = killSession("s-kill");

    expect(result).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(getActiveSessionIds()).not.toContain("s-kill");
  });
});

describe("getActiveSessionIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSession.mockResolvedValue(undefined);
    for (const id of getActiveSessionIds()) {
      killSession(id);
    }
  });

  it("returns empty array when no sessions spawned", () => {
    expect(getActiveSessionIds()).toEqual([]);
  });

  it("tracks multiple active sessions", async () => {
    mockGetAgent.mockReturnValue(makeAgent("claude"));
    const ctx = createMockContext();

    for (const id of ["s-a", "s-b", "s-c"]) {
      const child = createFakeChild();
      mockSpawn.mockReturnValue(child);
      const session = makeSession({ sessionId: id });
      await spawnAgent(ctx, session, () => {});
    }

    const ids = getActiveSessionIds();
    expect(ids).toContain("s-a");
    expect(ids).toContain("s-b");
    expect(ids).toContain("s-c");
    expect(ids).toHaveLength(3);
  });
});
