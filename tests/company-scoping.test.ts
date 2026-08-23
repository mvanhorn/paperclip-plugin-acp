import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import plugin, { resetInvocationGate, stopReaper } from "../src/worker.js";
import {
  getConfig,
  getRuntimeConfigState,
  resetRuntimeConfig,
} from "../src/runtime-config.js";
import { DEFAULT_CONFIG, ORCHESTRATION_DEFAULTS } from "../src/constants.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Host-compatibility matrix for company-scoped configuration.
 *
 * Since Paperclip v2026.720.0 the SDK requires a company scope for
 * `config.get`. `setup()` runs outside any invocation, so the worker must never
 * read config unscoped, must always finish registering its handlers, and must
 * adopt a company's configuration later — from the startup walk, from an
 * `onConfigChanged` delivery, or from the first company-scoped invocation.
 *
 * Configuration arrives from two places only: an `onConfigChanged` delivery
 * (the host replays stored configuration at worker start on >= v2026.817.0 and
 * delivers every save) and a company-scoped invocation when nothing has been
 * adopted yet. `setup()` reads no configuration at all.
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
  /** Stored config rows by company id. A missing entry means the read is denied. */
  configs?: Record<string, Record<string, unknown>>;
  /** Intercepts `config.get` entirely — used for the in-flight read race. */
  configGet?: (companyId?: string) => Promise<Record<string, unknown>>;
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
        if (opts.configGet) return opts.configGet(companyId);
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

  it("is healthy on defaults, and degrades only once the host refuses a read", async () => {
    const host = createHost();
    await definition.setup(host.ctx);

    // Nothing was asked of the host yet, so there is nothing to report.
    const atBoot = await definition.onHealth!();
    expect(atBoot.status).toBe("ok");
    expect(atBoot.message).toBeUndefined();
    expect(atBoot.details?.configSource).toBe("defaults");
    expect(atBoot.details?.configBootstrapped).toBe(false);

    // A company-scoped invocation tries to read, and this host denies it.
    const handler = host.listeners.get("plugin.paperclip-plugin-telegram.acp-spawn")![0];
    await handler({
      payload: {
        agentName: "not-a-real-agent",
        chatId: "chat-1",
        threadId: "thread-1",
        companyId: "company-1",
      },
    });

    const afterDenial = await definition.onHealth!();
    expect(afterDenial.status).toBe("degraded");
    expect(afterDenial.message).toContain("company context is required");
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
    expect(state.lastBootstrapError).toBeNull();

    const health = await definition.onHealth!();
    expect(health.status).toBe("ok");
    expect(health.details?.configSource).toBe("company:company-1");
  });

  it("adopts config from the first company-scoped invocation", async () => {
    // The walk finds nothing readable, then traffic arrives for a company whose
    // config the host will serve under an invocation scope.
    const configs: Record<string, Record<string, unknown>> = {};
    const host = createHost({ configs });
    await definition.setup(host.ctx);
    expect(getRuntimeConfigState().bootstrapped).toBe(false);

    configs["company-1"] = { defaultAgent: "gemini" };

    const handler = host.listeners.get("plugin.paperclip-plugin-telegram.acp-spawn")![0];
    await handler({
      payload: {
        // Unknown agent: handleSpawn rejects it right after the bootstrap hook,
        // so no subprocess is ever spawned.
        agentName: "not-a-real-agent",
        chatId: "chat-1",
        threadId: "thread-1",
        companyId: "company-1",
      },
    });

    const state = getRuntimeConfigState();
    expect(state.bootstrapped).toBe(true);
    expect(state.companyId).toBe("company-1");
    expect(state.source).toBe("invocation");
    expect(getConfig().defaultAgent).toBe("gemini");
  });
});

describe("a slow config read never overwrites a newer save", () => {
  it("drops an invocation read that resolves after a delivery", async () => {
    let release!: (config: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });

    const host = createHost({
      configGet: () => pending,
    });
    await definition.setup(host.ctx);

    // A company-scoped invocation starts reading config.
    const handler = host.listeners.get("plugin.paperclip-plugin-telegram.acp-spawn")![0];
    const dispatch = handler({
      payload: {
        agentName: "not-a-real-agent",
        chatId: "chat-1",
        threadId: "thread-1",
        companyId: "company-a",
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    // The operator saves while that read is still in flight.
    await definition.onConfigChanged!({ defaultAgent: "codex" }, { companyId: "company-a" });
    expect(getConfig().defaultAgent).toBe("codex");

    // The in-flight read now resolves with the older snapshot.
    release({ defaultAgent: "gemini" });
    await dispatch;

    expect(getConfig().defaultAgent).toBe("codex");
    expect(getRuntimeConfigState().source).toBe("config-changed");
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
