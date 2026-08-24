import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import plugin, { resetInvocationGate, stopReaper } from "../src/worker.js";
import {
  getConfig,
  getRuntimeConfigState,
  resetRuntimeConfig,
} from "../src/runtime-config.js";
import { DEFAULT_CONFIG, ORCHESTRATION_DEFAULTS } from "../src/constants.js";
import { createSession, getSession } from "../src/session-manager.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Host-compatibility matrix for company-scoped configuration.
 *
 * Since Paperclip v2026.720.0 the SDK requires a company scope for
 * `config.get`. `setup()` runs outside any invocation, so the worker must never
 * read config unscoped, must always finish registering its handlers, and must
 * adopt a company's configuration later, when the host delivers it through
 * `onConfigChanged`.
 *
 * Configuration arrives from ONE place: an `onConfigChanged` delivery — the
 * host replays stored configuration at worker start on >= v2026.817.0 and
 * delivers every save. Neither `setup()` nor any invocation ever reads config.
 */

const SCOPE_DENIED =
  'plugin "paperclip-plugin-acp" is not allowed to perform "config.get": company context is required';

type EventHandler = (event: { payload: unknown }) => unknown;

type HostMock = {
  ctx: PluginContext;
  /** `companyId` argument of every `config.get` call, in order. */
  configGetCalls: Array<string | undefined>;
  /** Everything written to plugin state, to prove a refusal changed nothing. */
  stateWrites: string[];
  listeners: Map<string, EventHandler[]>;
  tools: Map<string, (params: unknown, runCtx: unknown) => unknown>;
  emitted: Array<{ event: string; args: unknown[] }>;
  warnings: Array<{ message: string; meta?: Record<string, unknown> }>;
};

function createHost(opts: {
  /**
   * Stored config rows by company id. The plugin never reads them — they exist
   * so a test can prove a readable row is still not read.
   */
  configs?: Record<string, Record<string, unknown>>;
} = {}): HostMock {
  const configGetCalls: Array<string | undefined> = [];
  const stateWrites: string[] = [];
  const listeners = new Map<string, EventHandler[]>();
  const tools = new Map<string, (params: unknown, runCtx: unknown) => unknown>();
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const state = new Map<string, unknown>();

  const ctx = {
    config: {
      async get(companyId?: string) {
        configGetCalls.push(companyId);
        // The gate the whole fix exists for: an unscoped read always throws.
        if (!companyId) throw new Error(SCOPE_DENIED);
        const row = opts.configs?.[companyId];
        if (!row) throw new Error(SCOPE_DENIED);
        return row;
      },
    },
    events: {
      on(event: string, handler: EventHandler) {
        const arr = listeners.get(event) ?? [];
        arr.push(handler);
        listeners.set(event, arr);
      },
      emit(event: string, ...args: unknown[]) {
        emitted.push({ event, args });
      },
    },
    tools: {
      register(
        name: string,
        _decl: unknown,
        handler: (params: unknown, runCtx: unknown) => unknown,
      ) {
        tools.set(name, handler);
      },
    },
    state: {
      async get(key: { stateKey: string }) {
        return state.get(key.stateKey) ?? null;
      },
      async set(key: { stateKey: string }, value: unknown) {
        stateWrites.push(key.stateKey);
        state.set(key.stateKey, value);
      },
      async delete(key: { stateKey: string }) {
        state.delete(key.stateKey);
      },
    },
    metrics: { async write() {} },
    logger: {
      info() {},
      debug() {},
      error() {},
      warn(message: string, meta?: Record<string, unknown>) {
        warnings.push({ message, meta });
      },
    },
  } as unknown as PluginContext;

  return { ctx, configGetCalls, stateWrites, listeners, tools, emitted, warnings };
}

/** Every registration `setup()` must complete regardless of config access. */
function assertFullyRegistered(host: HostMock): void {
  for (const platform of [
    "paperclip-plugin-telegram",
    "paperclip-plugin-slack",
    "paperclip-plugin-discord",
    "paperclip-plugin-line",
  ]) {
    for (const suffix of ["acp-spawn", "acp-message", "acp-cancel", "acp-close"]) {
      expect(host.listeners.has(`plugin.${platform}.${suffix}`)).toBe(true);
    }
  }
  expect(host.listeners.has("webhook.issue_status_change")).toBe(true);
  expect(host.listeners.has("webhook.session_complete")).toBe(true);
  expect(host.listeners.has("webhook.approval_required")).toBe(true);
  expect(host.listeners.has("plugin.stopping")).toBe(true);

  for (const tool of [
    "acp_spawn",
    "acp_status",
    "acp_send",
    "acp_cancel",
    "acp_close",
    "acp_result",
    "acp_attach",
    "acp_attachments",
  ]) {
    expect(host.tools.has(tool)).toBe(true);
  }
}

const definition = plugin.definition;

beforeEach(() => {
  resetRuntimeConfig();
  resetInvocationGate();
  // getPoolStatus() reaches the Paperclip API from onHealth; keep it offline.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ count: 0 }) })),
  );
});

afterEach(() => {
  stopReaper();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("host matrix: v2026.720.0 / v2026.722.0 (every config read denied)", () => {
  it("completes setup, registers everything, and never reads config unscoped", async () => {
    const host = createHost();

    await expect(definition.setup(host.ctx)).resolves.toBeUndefined();

    assertFullyRegistered(host);
    // setup() runs outside any company scope, so it must not read config at all.
    expect(host.configGetCalls).toEqual([]);

    const state = getRuntimeConfigState();
    expect(state.bootstrapped).toBe(false);
    expect(state.configSource).toBe("defaults");
    expect(getConfig().defaultAgent).toBe(DEFAULT_CONFIG.defaultAgent);
  });

  it("is healthy on defaults, before and after traffic arrives", async () => {
    const host = createHost();
    await definition.setup(host.ctx);

    const atBoot = await definition.onHealth!();
    expect(atBoot.status).toBe("ok");
    expect(atBoot.details?.configSource).toBe("defaults");
    expect(atBoot.details?.configBootstrapped).toBe(false);

    // An invocation arrives before any configuration has been delivered. It is
    // served on defaults — every field is tuning — and reads nothing.
    const handler = host.listeners.get("plugin.paperclip-plugin-telegram.acp-spawn")![0];
    await handler({
      companyId: "company-1",
      payload: {
        agentName: "not-a-real-agent",
        chatId: "chat-1",
        threadId: "thread-1",
        companyId: "company-1",
      },
    });

    expect(host.configGetCalls).toEqual([]);
    const afterTraffic = await definition.onHealth!();
    expect(afterTraffic.status).toBe("ok");
    expect(afterTraffic.details?.configSource).toBe("defaults");
  });

  it("bootstraps from an onConfigChanged delivery without a worker restart", async () => {
    const host = createHost();
    await definition.setup(host.ctx);
    expect(getRuntimeConfigState().bootstrapped).toBe(false);

    await definition.onConfigChanged!(
      { defaultAgent: "codex", sharedPoolSize: 4 },
      { companyId: "company-1" },
    );

    expect(getConfig().defaultAgent).toBe("codex");
    expect(getConfig().sharedPoolSize).toBe(4);
    // Untouched fields keep their defaults.
    expect(getConfig().peakHourTimezone).toBe(ORCHESTRATION_DEFAULTS.peakHourTimezone);

    const state = getRuntimeConfigState();
    expect(state.bootstrapped).toBe(true);
    expect(state.companyId).toBe("company-1");
    expect(state.source).toBe("config-changed");

    const health = await definition.onHealth!();
    expect(health.status).toBe("ok");
    expect(health.details?.configSource).toBe("company:company-1");
  });

  it("never reads configuration from an invocation", async () => {
    // A successful scoped `config.get` does not move the SDK's own owner — only
    // a delivery does — so adopting from an invocation would split the two.
    // The plugin therefore never reads config outside a delivery at all.
    const host = createHost({ configs: { "company-1": { defaultAgent: "gemini" } } });
    await definition.setup(host.ctx);

    const handler = host.listeners.get("plugin.paperclip-plugin-telegram.acp-spawn")![0];
    await handler({
      companyId: "company-1",
      payload: {
        agentName: "not-a-real-agent",
        chatId: "chat-1",
        threadId: "thread-1",
        companyId: "company-1",
      },
    });

    expect(host.configGetCalls).toEqual([]);
    expect(getRuntimeConfigState().bootstrapped).toBe(false);
    expect(getRuntimeConfigState().configSource).toBe("defaults");
    expect(getConfig().defaultAgent).toBe(DEFAULT_CONFIG.defaultAgent);
  });
});

describe("an invocation racing a delivery", () => {
  it("does no work for a company the delivery made a non-owner", async () => {
    // The race the old invocation-bootstrap had: company A's invocation was in
    // flight, company B's delivery won, and A's handler carried on under B's
    // runtime. With no adoption path there is nothing to lose the race with —
    // the gate is synchronous, so a delivery either lands before it (A refused,
    // zero work) or after the handler already holds its own config snapshot.
    const host = createHost();
    await definition.setup(host.ctx);

    await definition.onConfigChanged!({ defaultAgent: "gemini" }, { companyId: "company-b" });

    const emittedBefore = host.emitted.length;
    const handler = host.listeners.get("plugin.paperclip-plugin-telegram.acp-spawn")![0];
    await handler({
      companyId: "company-a",
      payload: {
        agentName: "not-a-real-agent",
        chatId: "chat-1",
        threadId: "thread-1",
        companyId: "company-a",
      },
    });

    // Zero work for the loser, and no read under its scope.
    expect(host.emitted).toHaveLength(emittedBefore);
    expect(host.configGetCalls).toEqual([]);
    expect(getRuntimeConfigState().companyId).toBe("company-b");
  });
});

describe("single-company runtime model", () => {
  it("refreshes configuration when the same company saves again", async () => {
    const host = createHost();
    await definition.setup(host.ctx);
    await definition.onConfigChanged!({ defaultAgent: "codex" }, { companyId: "company-1" });
    expect(getConfig().defaultAgent).toBe("codex");

    await definition.onConfigChanged!({ defaultAgent: "gemini" }, { companyId: "company-1" });

    expect(getConfig().defaultAgent).toBe("gemini");
    expect(getRuntimeConfigState().companyId).toBe("company-1");
  });

  it("keeps the running company when a second company brings a different config", async () => {
    const host = createHost();
    await definition.setup(host.ctx);
    await definition.onConfigChanged!({ defaultAgent: "codex" }, { companyId: "company-1" });

    await definition.onConfigChanged!({ defaultAgent: "gemini" }, { companyId: "company-2" });

    expect(getConfig().defaultAgent).toBe("codex");
    expect(getRuntimeConfigState().companyId).toBe("company-1");
    expect(host.warnings.some((w) => w.message.includes("second company"))).toBe(true);
  });

  it("warns when an unscoped save replaces a company-owned config", async () => {
    // Hosts before v2026.817.0 call onConfigChanged with no company context at
    // all, so a second company's save looks exactly like a refresh. The plugin
    // cannot tell them apart — it must not swap the running settings mutely.
    const host = createHost();
    await definition.setup(host.ctx);
    await definition.onConfigChanged!({ defaultAgent: "codex" }, { companyId: "company-1" });
    expect(getRuntimeConfigState().companyId).toBe("company-1");

    await definition.onConfigChanged!({ defaultAgent: "gemini" }, undefined);

    expect(getConfig().defaultAgent).toBe("gemini");
    expect(getRuntimeConfigState().companyId).toBe("company-1");
    expect(
      host.warnings.some((w) => w.message.includes("without a company scope")),
    ).toBe(true);
  });

  it("applies an instance-scoped save (companyId null) to the running config", async () => {
    const host = createHost();
    await definition.setup(host.ctx);

    await definition.onConfigChanged!({ defaultAgent: "opencode" }, { companyId: null });

    expect(getConfig().defaultAgent).toBe("opencode");
    expect(getRuntimeConfigState().configSource).toBe("instance");
  });
});

describe("ownership mirrors the SDK's single-tenant guard", () => {
  it("ordered replay of two distinct configs keeps the first company", async () => {
    // The host replays every stored config row at worker start, sorted by
    // company id. The first delivery owns the worker; the SDK refuses to hand a
    // second, differently-configured company to a single-tenant plugin, and the
    // plugin must reach the same verdict.
    const host = createHost();
    await definition.setup(host.ctx);

    await definition.onConfigChanged!({ defaultAgent: "codex" }, { companyId: "company-a" });
    await definition.onConfigChanged!({ defaultAgent: "gemini" }, { companyId: "company-b" });

    expect(getRuntimeConfigState().companyId).toBe("company-a");
    expect(getConfig().defaultAgent).toBe("codex");
    expect(
      host.warnings.some((w) => w.message.includes("second company")),
    ).toBe(true);
  });

  it("advances ownership to a later company with an identical config", async () => {
    // Legacy installs duplicated one configuration across every company (host
    // migration 0164), so the replay delivers byte-equal rows under several
    // scopes. The SDK treats that as an idempotent replay and moves its own
    // owner to the last one; if the plugin kept the first, the SDK would reject
    // the plugin owner's saves before they ever reached the hook.
    const host = createHost();
    await definition.setup(host.ctx);

    const shared = { defaultAgent: "codex", maxSessionsPerThread: 3 };
    await definition.onConfigChanged!({ ...shared }, { companyId: "company-a" });
    expect(getRuntimeConfigState().companyId).toBe("company-a");

    // Key order differs, contents do not: still an idempotent replay.
    await definition.onConfigChanged!(
      { maxSessionsPerThread: 3, defaultAgent: "codex" },
      { companyId: "company-b" },
    );

    expect(getRuntimeConfigState().companyId).toBe("company-b");
    expect(getConfig().defaultAgent).toBe("codex");
  });

  it("after the advance, the new owner's saves apply and the old owner's are refused", async () => {
    const host = createHost();
    await definition.setup(host.ctx);

    const shared = { defaultAgent: "codex" };
    await definition.onConfigChanged!({ ...shared }, { companyId: "company-a" });
    await definition.onConfigChanged!({ ...shared }, { companyId: "company-b" });
    expect(getRuntimeConfigState().companyId).toBe("company-b");

    // company-a now edits its own config: a different config for a company that
    // no longer owns the worker.
    await definition.onConfigChanged!({ defaultAgent: "gemini" }, { companyId: "company-a" });
    expect(getConfig().defaultAgent).toBe("codex");
    expect(getRuntimeConfigState().companyId).toBe("company-b");

    // The owner's own save still applies.
    await definition.onConfigChanged!({ defaultAgent: "opencode" }, { companyId: "company-b" });
    expect(getConfig().defaultAgent).toBe("opencode");
    expect(getRuntimeConfigState().companyId).toBe("company-b");
  });
});

describe("invocations for another company are refused", () => {
  it("refuses a non-owner event before any read or state change", async () => {
    const host = createHost({ configs: { "company-b": { defaultAgent: "gemini" } } });
    await definition.setup(host.ctx);
    await definition.onConfigChanged!({ defaultAgent: "codex" }, { companyId: "company-a" });

    const readsBefore = host.configGetCalls.length;
    const writesBefore = host.stateWrites.length;
    const emittedBefore = host.emitted.length;

    const handler = host.listeners.get("plugin.paperclip-plugin-telegram.acp-spawn")![0];
    await handler({
      companyId: "company-b",
      payload: {
        agentName: "claude",
        chatId: "chat-1",
        threadId: "thread-1",
        companyId: "company-b",
      },
    });

    // Terminal: no config read under the wrong scope, no session state, no work.
    expect(host.configGetCalls).toHaveLength(readsBefore);
    expect(host.stateWrites).toHaveLength(writesBefore);
    expect(host.emitted).toHaveLength(emittedBefore);
    expect(getRuntimeConfigState().companyId).toBe("company-a");
    expect(getConfig().defaultAgent).toBe("codex");
    expect(
      host.warnings.some((w) => w.message.includes("does not serve")),
    ).toBe(true);
  });

  it("judges an event by the host envelope, not the payload", async () => {
    // The envelope is minted by the host; payload fields are written by the
    // emitting plugin and cannot be trusted to name the company.
    const host = createHost();
    await definition.setup(host.ctx);
    await definition.onConfigChanged!({ defaultAgent: "codex" }, { companyId: "company-a" });

    const emittedBefore = host.emitted.length;
    const handler = host.listeners.get("plugin.paperclip-plugin-telegram.acp-spawn")![0];
    await handler({
      // A non-owner envelope with the owner's id in the payload must not pass.
      companyId: "company-b",
      payload: {
        agentName: "claude",
        chatId: "chat-1",
        threadId: "thread-1",
        companyId: "company-a",
      },
    });

    expect(host.emitted).toHaveLength(emittedBefore);
    expect(host.stateWrites).toEqual([]);
  });

  it("refuses every session tool for a non-owner company", async () => {
    const host = createHost();
    await definition.setup(host.ctx);
    await definition.onConfigChanged!({ defaultAgent: "codex" }, { companyId: "company-a" });

    // The owner has a live session; another company must not be able to read,
    // signal, close or disclose it through any tool.
    const session = await createSession(host.ctx, {
      sessionId: "owner-session",
      agentId: "claude",
      mode: "persistent",
      cwd: "/workspace",
    });
    const writesAfterSetup = host.stateWrites.length;

    for (const [tool, params] of [
      ["acp_status", {}],
      ["acp_send", { sessionId: session.sessionId, text: "hello" }],
      ["acp_cancel", { sessionId: session.sessionId }],
      ["acp_close", { sessionId: session.sessionId }],
      ["acp_result", { sessionId: session.sessionId }],
      ["acp_attach", { issueId: "i1", filename: "f.txt", content: "eA==" }],
      ["acp_attachments", { issueId: "i1" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = (await host.tools.get(tool)!(params, { companyId: "company-b" })) as {
        error?: string;
      };
      expect(result.error, `${tool} was not refused`).toContain("different company");
    }

    // The owner's session is untouched.
    expect(host.stateWrites).toHaveLength(writesAfterSetup);
    expect((await getSession(host.ctx, session.sessionId))!.state).toBe("spawning");
  });

  it("refuses a non-owner tool call with an error result", async () => {
    const host = createHost();
    await definition.setup(host.ctx);
    await definition.onConfigChanged!({ defaultAgent: "codex" }, { companyId: "company-a" });

    const spawn = host.tools.get("acp_spawn")!;
    const result = (await spawn({ agent: "claude" }, { companyId: "company-b" })) as {
      error?: string;
    };

    expect(result.error).toContain("different company");
    expect(host.stateWrites).toEqual([]);
  });

  it("rate-limits the refusal log for a repeating non-owner company", async () => {
    const host = createHost();
    await definition.setup(host.ctx);
    await definition.onConfigChanged!({ defaultAgent: "codex" }, { companyId: "company-a" });

    const spawn = host.tools.get("acp_spawn")!;
    for (let i = 0; i < 5; i++) {
      await spawn({ agent: "claude" }, { companyId: "company-b" });
    }

    expect(
      host.warnings.filter((w) => w.message.includes("does not serve")),
    ).toHaveLength(1);
  });

  it("serves the owner's own invocations normally", async () => {
    const host = createHost();
    await definition.setup(host.ctx);
    await definition.onConfigChanged!({ defaultAgent: "codex" }, { companyId: "company-a" });

    const spawn = host.tools.get("acp_spawn")!;
    const result = (await spawn({ agent: "not-a-real-agent" }, { companyId: "company-a" })) as {
      error?: string;
    };

    // It reaches the handler: the error is about the agent, not the company.
    expect(result.error).toContain("Unknown agent");
  });
});

describe("reaper follows the live configuration", () => {
  it("restarts the timer only when the scan interval changes", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const host = createHost();

    await definition.setup(host.ctx);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0]![1]).toBe(DEFAULT_CONFIG.reaperIntervalMs);

    // Same interval: no restart.
    await definition.onConfigChanged!(
      { reaperIntervalMs: DEFAULT_CONFIG.reaperIntervalMs, defaultAgent: "codex" },
      { companyId: "company-1" },
    );
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    // Changed interval: the timer is recreated with the new value.
    await definition.onConfigChanged!({ reaperIntervalMs: 5_000 }, { companyId: "company-1" });
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(setIntervalSpy.mock.calls[1]![1]).toBe(5_000);
  });

  it("ignores null config values instead of overwriting defaults", async () => {
    const host = createHost();
    await definition.setup(host.ctx);

    await definition.onConfigChanged!(
      { reaperIntervalMs: null, sessionIdleTimeoutMs: null, defaultAgent: "codex" },
      { companyId: "company-1" },
    );

    expect(getConfig().reaperIntervalMs).toBe(DEFAULT_CONFIG.reaperIntervalMs);
    expect(getConfig().sessionIdleTimeoutMs).toBe(DEFAULT_CONFIG.sessionIdleTimeoutMs);
    expect(getConfig().defaultAgent).toBe("codex");
  });
});
