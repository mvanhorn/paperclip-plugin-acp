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
 * worker always boots on safe defaults, registers everything, and then adopts a
 * company's configuration whenever one becomes reachable:
 *
 *   1. `onConfigChanged` — the host delivers stored config at startup and on
 *      every save, with the company scope attached;
 *   2. the first company-scoped invocation (event or tool call) that carries a
 *      `companyId`;
 *   3. a best-effort startup walk over `companies.list()` + `config.get(id)`.
 *
 * Single-runtime company model: the first company whose config resolves wins.
 * A later delivery for the same company refreshes the config; a delivery for a
 * different company is logged and ignored (the plugin does not declare
 * `multiCompanyConfig`). Multi-company support is a documented follow-up.
 */

import { DEFAULT_CONFIG, ORCHESTRATION_DEFAULTS } from "./constants.js";
import type { AcpConfig, AcpSessionMode } from "./types.js";

/** Where the currently active configuration came from. */
export type ConfigSource =
  /** No company config has landed yet — every value is a built-in default. */
  | "defaults"
  /** Adopted from the best-effort `companies.list()` + `config.get(id)` walk. */
  | "startup-walk"
  /** Adopted from an `onConfigChanged` delivery by the host. */
  | "config-changed"
  /** Adopted from the first company-scoped invocation (event or tool call). */
  | "invocation";

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
  /** Last host error seen while trying to read config, truncated. Never a secret. */
  lastBootstrapError: string | null;
};

/** Result of an attempted config adoption. */
export type ApplyConfigResult = {
  /** True when the incoming config became the active one. */
  applied: boolean;
  /** Why an adoption was skipped, when `applied` is false. */
  skippedReason?: "other-company";
  /** True when `reaperIntervalMs` changed, so the caller must restart the timer. */
  reaperIntervalChanged: boolean;
  /** The company that owns the active config after this call. */
  companyId: string | null;
};

/** Maximum length of a host error message kept for health output. */
const MAX_ERROR_LENGTH = 240;

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
let lastBootstrapError: string | null = null;

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
    lastBootstrapError,
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
 * Record a host error encountered while reading config. The message is
 * truncated and stored verbatim so operators see the real host reason
 * (e.g. `company context is required`) in the health payload.
 */
export function recordBootstrapError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  lastBootstrapError =
    message.length > MAX_ERROR_LENGTH
      ? `${message.slice(0, MAX_ERROR_LENGTH)}…`
      : message;
  return lastBootstrapError;
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
  if (
    bootstrapped &&
    activeCompanyId !== null &&
    opts.companyId !== null &&
    opts.companyId !== activeCompanyId
  ) {
    return {
      applied: false,
      skippedReason: "other-company",
      reaperIntervalChanged: false,
      companyId: activeCompanyId,
    };
  }

  const next = resolveConfig(raw);
  const reaperIntervalChanged = next.reaperIntervalMs !== current.reaperIntervalMs;

  current = next;
  bootstrapped = true;
  source = opts.source;
  if (opts.companyId !== null) activeCompanyId = opts.companyId;
  lastBootstrapError = null;

  return {
    applied: true,
    reaperIntervalChanged,
    companyId: activeCompanyId,
  };
}

/** Reset to built-in defaults. Test-only. */
export function resetRuntimeConfig(): void {
  current = defaultConfig();
  bootstrapped = false;
  activeCompanyId = null;
  source = "defaults";
  lastBootstrapError = null;
}
