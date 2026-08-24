/**
 * Company-scoped runtime configuration holder.
 *
 * Background: since Paperclip v2026.720.0 the plugin SDK gates `config.get`
 * behind a company scope (`resolveRequiredCompanyId` in
 * `packages/plugins/sdk/src/host-client-factory.ts`). `setup()` runs outside any
 * invocation, so a bare `await ctx.config.get()` in `setup()` throws
 * `not allowed to perform "config.get": company context is required` and takes
 * the whole worker down with it — no tools, no listeners, no reaper.
 *
 * The fix is to stop treating configuration as a startup prerequisite. The
 * worker always boots on safe defaults, registers everything, and adopts a
 * company's configuration only when the host delivers one through
 * `onConfigChanged` — the host replays stored configuration at worker start
 * (Paperclip >= v2026.817.0) and delivers every save, with the company scope
 * attached. The worker never reads configuration itself: a scoped `config.get`
 * does not move the SDK's own owner, so adopting from a read would let the two
 * layers disagree about who owns the worker.
 *
 * Single-runtime company model, mirroring the SDK's own single-tenant guard so
 * the two never disagree about who owns the worker: the first delivered company
 * owns it, a later delivery for that same company refreshes it, and a delivery
 * for a different company is refused — UNLESS its configuration is identical, in
 * which case ownership advances to it exactly as the SDK's guard does. The
 * plugin does not declare `multiCompanyConfig`; multi-company support is a
 * documented follow-up.
 */

import { DEFAULT_CONFIG, ORCHESTRATION_DEFAULTS } from "./constants.js";
import type { AcpConfig, AcpSessionMode } from "./types.js";

/**
 * Where the currently active configuration came from. A delivery is the only
 * way to adopt one, so there are exactly two states.
 */
export type ConfigSource =
  /** No company config has landed yet — every value is a built-in default. */
  | "defaults"
  /** Adopted from an `onConfigChanged` delivery by the host. */
  | "config-changed";

/** Snapshot of the bootstrap state, surfaced through `onHealth`. */
export type RuntimeConfigState = {
  /** True once a company's configuration has been adopted. */
  bootstrapped: boolean;
  /** The company whose config is active, or null for defaults / instance saves. */
  companyId: string | null;
  /** Provenance of the active configuration. */
  source: ConfigSource;
  /** Human-readable provenance, e.g. `company:8f2c-…` — safe for health output. */
  configSource: string;
};

/** Result of an attempted config adoption. */
export type ApplyConfigResult = {
  /** True when the incoming config became the active one. */
  applied: boolean;
  /**
   * Why an adoption was skipped, when `applied` is false. A second company's
   * config arrived while one is running.
   */
  skippedReason?: "other-company";
  /**
   * True when ownership moved to a different company because its configuration
   * was identical to the running one. The SDK's guard allows exactly this (an
   * idempotent replay of the same config under another scope, which legacy
   * duplicate config rows produce) and advances its own owner with it, so the
   * plugin must advance too or the two disagree about who owns the worker.
   */
  ownerAdvanced?: boolean;
  /**
   * True when an unscoped (company-less) delivery replaced a configuration that
   * a known company owned. Hosts before v2026.817.0 call `onConfigChanged` with
   * no company context at all, so a second company's save is indistinguishable
   * from a refresh of the running one — the caller warns on this.
   */
  legacyUnscopedReplace?: boolean;
  /** True when `reaperIntervalMs` changed, so the caller must restart the timer. */
  reaperIntervalChanged: boolean;
  /** The company that owns the active config after this call. */
  companyId: string | null;
};

const BASE_CONFIG: AcpConfig = {
  ...ORCHESTRATION_DEFAULTS,
  enabledAgents: DEFAULT_CONFIG.enabledAgents,
  defaultAgent: DEFAULT_CONFIG.defaultAgent,
  defaultMode: DEFAULT_CONFIG.defaultMode as AcpSessionMode,
  defaultCwd: DEFAULT_CONFIG.defaultCwd,
  sessionIdleTimeoutMs: DEFAULT_CONFIG.sessionIdleTimeoutMs,
  sessionMaxAgeMs: DEFAULT_CONFIG.sessionMaxAgeMs,
  maxSessionsPerThread: DEFAULT_CONFIG.maxSessionsPerThread,
  reaperIntervalMs: DEFAULT_CONFIG.reaperIntervalMs,
  sessionRowTtlDays: DEFAULT_CONFIG.sessionRowTtlDays,
};

/**
 * Merge a raw host config object over the built-in defaults.
 *
 * `null` / `undefined` values are dropped rather than overwriting a default:
 * the host stores unset optional fields as null, and a null
 * `reaperIntervalMs` would otherwise turn the reaper into a busy loop.
 */
export function resolveConfig(raw: unknown): AcpConfig {
  const merged: Record<string, unknown> = { ...BASE_CONFIG };
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      merged[key] = value;
    }
  }
  return merged as AcpConfig;
}

/** Built-in defaults, for callers that need a config before bootstrap. */
export function defaultConfig(): AcpConfig {
  return { ...BASE_CONFIG };
}

let current: AcpConfig = defaultConfig();
let bootstrapped = false;
let activeCompanyId: string | null = null;
let source: ConfigSource = "defaults";
/**
 * The raw configuration exactly as the host last delivered it. Ownership
 * decisions compare against this rather than the merged view, because the SDK's
 * guard compares the raw payloads.
 */
let lastRawConfig: unknown = undefined;

/** The configuration every handler must read at dispatch time. */
export function getConfig(): AcpConfig {
  return current;
}

/** Bootstrap state for health reporting and tests. */
export function getRuntimeConfigState(): RuntimeConfigState {
  return {
    bootstrapped,
    companyId: activeCompanyId,
    source,
    configSource: describeSource(),
  };
}

function describeSource(): string {
  if (!bootstrapped) return "defaults";
  if (activeCompanyId) return `company:${activeCompanyId}`;
  return "instance";
}

/** True when a company config has been adopted. */
export function isBootstrapped(): boolean {
  return bootstrapped;
}

/** The company whose config is active, if any. */
export function getActiveCompanyId(): string | null {
  return activeCompanyId;
}

/**
 * Adopt a company's configuration.
 *
 * Idempotent: re-delivering the same company's config refreshes it. A delivery
 * for a different company while one is already running is refused (the caller
 * logs it) so the worker never silently collapses onto whichever company
 * arrived last.
 */
export function applyCompanyConfig(
  raw: unknown,
  opts: { companyId: string | null; source: ConfigSource },
): ApplyConfigResult {
  // Mirror of the SDK's fail-closed cross-tenant guard
  // (`handleConfigChanged` in worker-rpc-host): a different company is refused
  // only when it brings a DIFFERENT configuration. An identical configuration
  // under another scope is an idempotent replay — legacy duplicate config rows
  // produce exactly that — and the SDK advances its owner to it, so the plugin
  // advances too. Diverging here would leave the SDK rejecting our owner's saves
  // before they ever reach the hook.
  const otherCompany =
    bootstrapped &&
    activeCompanyId !== null &&
    opts.companyId !== null &&
    opts.companyId !== activeCompanyId;

  if (otherCompany && !configsEqual(raw, lastRawConfig)) {
    return {
      applied: false,
      skippedReason: "other-company",
      reaperIntervalChanged: false,
      companyId: activeCompanyId,
    };
  }

  const legacyUnscopedReplace =
    bootstrapped && activeCompanyId !== null && opts.companyId === null;

  const next = resolveConfig(raw);
  const reaperIntervalChanged = next.reaperIntervalMs !== current.reaperIntervalMs;

  current = next;
  bootstrapped = true;
  source = opts.source;
  if (opts.companyId !== null) activeCompanyId = opts.companyId;
  lastRawConfig = raw;

  return {
    applied: true,
    reaperIntervalChanged,
    companyId: activeCompanyId,
    legacyUnscopedReplace,
    ownerAdvanced: otherCompany,
  };
}

/**
 * Configuration equality, canonicalized the same way the SDK canonicalizes it
 * (key order ignored, `undefined` members dropped) so the plugin's ownership
 * decision matches the host's for the same pair of payloads.
 */
function configsEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

/** Reset to built-in defaults. Test-only. */
export function resetRuntimeConfig(): void {
  current = defaultConfig();
  bootstrapped = false;
  activeCompanyId = null;
  source = "defaults";
  lastRawConfig = undefined;
}
