import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import plugin, { stopReaper } from "../src/worker.js";
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
 * The mocks below model three hosts:
 *   - pre-720 / capability denied — `companies.list` fails;
 *   - v2026.720.0 / v2026.722.0   — every `config.get` is denied, scoped or not;
 *   - >= v2026.817.0              — scoped `config.get` resolves for companies
 *                                   that already have a stored config row,
 *                                   unscoped is still denied.
 */

const SCOPE_DENIED =
  'plugin "paperclip-plugin-acp" is not allowed to perform "config.get": company context is required';
const CAPABILITY_DENIED =
  'plugin "paperclip-plugin-acp" is missing capability "companies.read"';

type EventHandler = (event: { payload: unknown }) => unknown;

type HostMock = {
  ctx: PluginContext;
  /** `companyId` argument of every `config.get` call, in order. */
  configGetCalls: Array<string | undefined>;
  /** Arguments of every `companies.list` call, in order. */
  listCalls: Array<{ limit?: number; offset?: number } | undefined>;
  listeners: Map<string, EventHandler[]>;
  tools: Map<string, (params: unknown, runCtx: unknown) => unknown>;
  emitted: Array<{ event: string; args: unknown[] }>;
  warnings: Array<{ message: string; meta?: Record<string, unknown> }>;
};

function createHost(opts: {
  /**
   * Companies visible to the plugin. A function is called per page: it may throw
   * (denied or transient listing failure) or return a page to model a listing
   * that fails only part-way through.
   */
  companies?: Array<{ id: string }> | (() => never) | (() => Array<{ id: string }> | undefined);
  /** Stored config rows by company id. A missing entry means the read is denied. */
  configs?: Record<string, Record<string, unknown>>;
  /** Intercepts `config.get` entirely — used for the in-flight read race. */
  configGet?: (companyId?: string) => Promise<Record<string, unknown>>;
}): HostMock {
  const configGetCalls: Array<string | undefined> = [];
  const listCalls: Array<{ limit?: number; offset?: number } | undefined> = [];
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
    companies: {
      async list(input?: { limit?: number; offset?: number }) {
        listCalls.push(input);
        // A function source may throw (denied / transient failure) or return a
        // page directly, so a partial enumeration can be modelled.
        if (typeof opts.companies === "function") {
          const produced = (opts.companies as () => Array<{ id: string }> | undefined)();
          if (produced !== undefined) return produced;
          return Array.from({ length: 100 }, (_, i) => ({
            id: `company-${String(i).padStart(3, "0")}`,
          }));
        }
        const all = opts.companies ?? [];
        const offset = input?.offset ?? 0;
        return input?.limit == null
          ? all.slice(offset)
          : all.slice(offset, offset + input.limit);
      },
      async get(id: string) {
        return (Array.isArray(opts.companies) ? opts.companies : []).find((c) => c.id === id) ?? null;
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

  return { ctx, configGetCalls, listCalls, listeners, tools, emitted, warnings };
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
    const host = createHost({ companies: [{ id: "company-1" }] });

    await expect(definition.setup(host.ctx)).resolves.toBeUndefined();

    assertFullyRegistered(host);
    expect(host.configGetCalls.length).toBeGreaterThan(0);
    expect(host.configGetCalls.every((id) => typeof id === "string" && id.length > 0)).toBe(true);

    const state = getRuntimeConfigState();
    expect(state.bootstrapped).toBe(false);
    expect(state.configSource).toBe("defaults");
    expect(state.lastBootstrapError).toContain("company context is required");
    expect(getConfig().defaultAgent).toBe(DEFAULT_CONFIG.defaultAgent);
  });

  it("reports degraded health carrying the real host error", async () => {
    const host = createHost({ companies: [{ id: "company-1" }] });
    await definition.setup(host.ctx);

    const health = await definition.onHealth!();
    expect(health.status).toBe("degraded");
    expect(health.message).toContain("company context is required");
    expect(health.details?.configSource).toBe("defaults");
    expect(health.details?.configBootstrapped).toBe(false);
  });

  it("bootstraps from an onConfigChanged delivery without a worker restart", async () => {
    const host = createHost({ companies: [{ id: "company-1" }] });
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
    const host = createHost({ companies: [{ id: "company-1" }], configs });
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

describe("host matrix: >= v2026.817.0 (scoped reads resolve)", () => {
  it("bootstraps from the startup walk, skipping companies with no readable config", async () => {
    const host = createHost({
      companies: [{ id: "company-a" }, { id: "company-b" }],
      configs: { "company-b": { defaultAgent: "opencode", maxSessionsPerThread: 9 } },
    });

    await definition.setup(host.ctx);

    assertFullyRegistered(host);
    expect(host.listCalls).toEqual([{ limit: 100, offset: 0 }]);
    expect(host.configGetCalls).toEqual(["company-a", "company-b"]);

    const state = getRuntimeConfigState();
    expect(state.bootstrapped).toBe(true);
    expect(state.companyId).toBe("company-b");
    expect(state.source).toBe("startup-walk");
    expect(getConfig().defaultAgent).toBe("opencode");
    expect(getConfig().maxSessionsPerThread).toBe(9);

    const health = await definition.onHealth!();
    expect(health.status).toBe("ok");
    expect(health.details?.configSource).toBe("company:company-b");
  });

  it("fresh install: the walk finds nothing, a later save bootstraps the runtime", async () => {
    const host = createHost({ companies: [] });

    await definition.setup(host.ctx);
    assertFullyRegistered(host);
    expect(host.configGetCalls).toEqual([]);
    expect(getRuntimeConfigState().bootstrapped).toBe(false);
    // No config row exists yet, so there is no host error to report.
    expect((await definition.onHealth!()).status).toBe("ok");

    await definition.onConfigChanged!({ defaultAgent: "codex" }, { companyId: "company-1" });

    expect(getRuntimeConfigState().bootstrapped).toBe(true);
    expect(getConfig().defaultAgent).toBe("codex");
  });
});

describe("host matrix: pre-720 / companies.read not granted", () => {
  it("survives a failing companies.list and stays on defaults", async () => {
    const host = createHost({
      companies: () => {
        throw new Error(CAPABILITY_DENIED);
      },
    });

    await expect(definition.setup(host.ctx)).resolves.toBeUndefined();

    assertFullyRegistered(host);
    expect(host.configGetCalls).toEqual([]);

    const state = getRuntimeConfigState();
    expect(state.bootstrapped).toBe(false);
    // The listing failure is recorded apart from config reads: the host did not
    // refuse our configuration, so it must not be reported as a config error.
    expect(state.lastCompanyListingError).toContain('missing capability "companies.read"');
    expect(state.lastBootstrapError).toBeNull();

    // The runtime is fully functional on defaults, so health stays ok and the
    // listing failure is visible in the details only.
    const health = await definition.onHealth!();
    expect(health.status).toBe("ok");
    expect(health.message).toBeUndefined();
    expect(health.details?.lastCompanyListingError).toContain(
      'missing capability "companies.read"',
    );
  });
});

describe("walk ownership matches the host's replay order", () => {
  it("adopts the lowest companyId when several companies have a readable config", async () => {
    // companies.list() has no ORDER BY on the host, but the startup config
    // replay is sorted by companyId ascending and the SDK's own single-tenant
    // guard binds to the first company it replays. Walking in list order could
    // leave this plugin owning a different company than the SDK does, after
    // which neither company's saves can reach the runtime.
    const host = createHost({
      companies: [{ id: "company-z" }, { id: "company-a" }],
      configs: {
        "company-z": { defaultAgent: "gemini" },
        "company-a": { defaultAgent: "codex" },
      },
    });

    await definition.setup(host.ctx);

    expect(host.configGetCalls[0]).toBe("company-a");
    expect(getRuntimeConfigState().companyId).toBe("company-a");
    expect(getConfig().defaultAgent).toBe("codex");
  });

  it("sorts the complete company set, not one arbitrary page", async () => {
    // The host pages `companies.list()` and gives it no ordering contract, so
    // the globally lowest configured company can sit in any page. Sorting only
    // the first page would bind this plugin to a different company than the
    // host's replay picks, and neither side's saves could then reach the other.
    const host = createHost({
      companies: [
        ...Array.from({ length: 25 }, (_, i) => ({
          id: `z-company-${String(i).padStart(2, "0")}`,
        })),
        { id: "a-company" },
      ],
      configs: {
        "z-company-00": { defaultAgent: "gemini" },
        "a-company": { defaultAgent: "codex" },
      },
    });

    await definition.setup(host.ctx);

    // Enumerated in full before any config read.
    expect(host.listCalls).toEqual([{ limit: 100, offset: 0 }]);
    // `a-company` sorts first across the whole set, and it is readable, so the
    // walk stops there — the same company the host's replay would bind to.
    expect(host.configGetCalls).toEqual(["a-company"]);
    expect(getRuntimeConfigState().companyId).toBe("a-company");
    expect(getConfig().defaultAgent).toBe("codex");
  });

  it("pages until a short page, then probes in global order", async () => {
    const host = createHost({
      // 150 companies: two full pages plus a short one.
      companies: [
        ...Array.from({ length: 149 }, (_, i) => ({
          id: `m-company-${String(i).padStart(3, "0")}`,
        })),
        { id: "a-company" },
      ],
      configs: { "a-company": { defaultAgent: "codex" } },
    });

    await definition.setup(host.ctx);

    expect(host.listCalls).toEqual([
      { limit: 100, offset: 0 },
      { limit: 100, offset: 100 },
    ]);
    expect(host.configGetCalls).toEqual(["a-company"]);
    expect(getRuntimeConfigState().companyId).toBe("a-company");
  });

  it("bounds how many companies it probes when none is readable", async () => {
    const host = createHost({
      companies: Array.from({ length: 60 }, (_, i) => ({
        id: `company-${String(i).padStart(3, "0")}`,
      })),
    });

    await definition.setup(host.ctx);

    // Probing a prefix of the globally sorted set can never pick the wrong
    // owner — it stops at the first readable config — so the probe count stays
    // bounded even though the listing enumerates everything.
    expect(host.configGetCalls).toHaveLength(25);
    expect(host.configGetCalls[0]).toBe("company-000");
    expect(host.configGetCalls[24]).toBe("company-024");
    expect(getRuntimeConfigState().bootstrapped).toBe(false);
  });

  it("gives up ownership selection when the tenant count is past the ceiling", async () => {
    const host = createHost({
      companies: Array.from({ length: 1101 }, (_, i) => ({
        id: `company-${String(i).padStart(5, "0")}`,
      })),
    });

    await definition.setup(host.ctx);

    // No owner may be chosen from a set that was never fully established.
    expect(host.configGetCalls).toEqual([]);
    expect(getRuntimeConfigState().bootstrapped).toBe(false);
    expect(host.warnings.some((w) => w.message.includes("Too many companies"))).toBe(true);

    // The delivery path still bootstraps it.
    await definition.onConfigChanged!({ defaultAgent: "codex" }, { companyId: "company-00042" });
    expect(getRuntimeConfigState().companyId).toBe("company-00042");
  });

  it("does not select an owner when the listing fails part-way through", async () => {
    let calls = 0;
    const host = createHost({
      companies: () => {
        // The first page succeeds, the second fails: the set is incomplete.
        if (calls++ === 0) return undefined as never;
        throw new Error("transient listing failure");
      },
      configs: { "company-000": { defaultAgent: "codex" } },
    });

    await definition.setup(host.ctx);

    expect(host.configGetCalls).toEqual([]);
    expect(getRuntimeConfigState().bootstrapped).toBe(false);
    expect(getRuntimeConfigState().lastCompanyListingError).toContain("transient listing failure");
  });

  it("stops at the first company with a readable config", async () => {
    const host = createHost({
      companies: [{ id: "company-a" }, { id: "company-b" }, { id: "company-c" }],
      configs: {
        "company-b": { defaultAgent: "codex" },
        "company-c": { defaultAgent: "gemini" },
      },
    });

    await definition.setup(host.ctx);

    expect(host.configGetCalls).toEqual(["company-a", "company-b"]);
    expect(getRuntimeConfigState().companyId).toBe("company-b");
  });
});

describe("a slow config read never overwrites a newer save", () => {
  it("drops an invocation read that resolves after a delivery", async () => {
    let release!: (config: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });

    const host = createHost({
      companies: [],
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

  it("drops a startup-walk read that resolves after a delivery", async () => {
    let release!: (config: Record<string, unknown>) => void;
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });

    const host = createHost({
      companies: [{ id: "company-a" }],
      configGet: () => pending,
    });

    const setupDone = definition.setup(host.ctx);
    await new Promise((resolve) => setImmediate(resolve));

    await definition.onConfigChanged!({ defaultAgent: "codex" }, { companyId: "company-a" });
    release({ defaultAgent: "gemini" });
    await setupDone;

    expect(getConfig().defaultAgent).toBe("codex");
  });
});

describe("single-company runtime model", () => {
  it("refreshes configuration when the same company saves again", async () => {
    const host = createHost({
      companies: [{ id: "company-1" }],
      configs: { "company-1": { defaultAgent: "codex" } },
    });
    await definition.setup(host.ctx);
    expect(getConfig().defaultAgent).toBe("codex");

    await definition.onConfigChanged!({ defaultAgent: "gemini" }, { companyId: "company-1" });

    expect(getConfig().defaultAgent).toBe("gemini");
    expect(getRuntimeConfigState().companyId).toBe("company-1");
  });

  it("keeps the running company when a second company's config is delivered", async () => {
    const host = createHost({
      companies: [{ id: "company-1" }],
      configs: { "company-1": { defaultAgent: "codex" } },
    });
    await definition.setup(host.ctx);

    await definition.onConfigChanged!({ defaultAgent: "gemini" }, { companyId: "company-2" });

    expect(getConfig().defaultAgent).toBe("codex");
    expect(getRuntimeConfigState().companyId).toBe("company-1");
    expect(host.warnings.some((w) => w.message.includes("second company"))).toBe(true);
  });

  it("warns when an unscoped save replaces a company-owned config", async () => {
    // Hosts before v2026.817.0 call onConfigChanged with no company context at
    // all, so a second company's save looks exactly like a refresh. The plugin
    // cannot tell them apart — it must not swap the running settings mutely.
    const host = createHost({
      companies: [{ id: "company-1" }],
      configs: { "company-1": { defaultAgent: "codex" } },
    });
    await definition.setup(host.ctx);
    expect(getRuntimeConfigState().companyId).toBe("company-1");

    await definition.onConfigChanged!({ defaultAgent: "gemini" }, undefined);

    expect(getConfig().defaultAgent).toBe("gemini");
    expect(getRuntimeConfigState().companyId).toBe("company-1");
    expect(
      host.warnings.some((w) => w.message.includes("without a company scope")),
    ).toBe(true);
  });

  it("applies an instance-scoped save (companyId null) to the running config", async () => {
    const host = createHost({ companies: [] });
    await definition.setup(host.ctx);

    await definition.onConfigChanged!({ defaultAgent: "opencode" }, { companyId: null });

    expect(getConfig().defaultAgent).toBe("opencode");
    expect(getRuntimeConfigState().configSource).toBe("instance");
  });
});

describe("reaper follows the live configuration", () => {
  it("restarts the timer only when the scan interval changes", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const host = createHost({ companies: [] });

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
    const host = createHost({ companies: [] });
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
