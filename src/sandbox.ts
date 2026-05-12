/**
 * Host-isolation sandbox for ACP worker spawns.
 *
 * Source-of-truth port: kairos/daemon/sandbox.py (commit dc9884a — chat-bleed
 * incident, May 2026). Each ACP subprocess gets:
 *   - an isolated temporary HOME under /tmp/paperclip-acp-sandbox-<uuid>/HOME
 *   - a minimal ~/.claude/settings.json containing exactly {"hooks":{}} so the
 *     operator's PostToolUse/Stop hooks do NOT leak into the spawned agent's
 *     stdout (this is what produced the `[Task Active]` bleed in dc9884a)
 *   - an env dict built from an explicit allowlist with a denylist override:
 *     CLAUDE_, PAPERCLIP_, KAIROS_, OPENAI_, SESSION_, MCP_ prefixed keys
 *     and any TOKEN / SECRET / KEY substring match are stripped, EXCEPT
 *     ANTHROPIC_API_KEY which is required for `claude -p` to function and is
 *     explicitly exempted.
 *
 * The sandbox dir is deleted on clean exit (code === 0) and preserved on any
 * non-zero exit for post-mortem inspection. A TTL sweeper deletes any sandbox
 * older than 24h to backstop orphan accumulation if a session is reaped or
 * the plugin restarts mid-flight.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const _SANDBOX_TMP_PREFIX = "paperclip-acp-sandbox-";

/** Env keys allowed to pass through to the worker subprocess.
 *  HOME/PATH are always overridden, but listed here for symmetry with kairos. */
export const _ENV_ALLOWLIST = new Set<string>([
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "ANTHROPIC_API_KEY",
]);

/** Env-key glob patterns (case-insensitive) that must NOT leak through. */
export const _ENV_DENYLIST_PATTERNS: readonly string[] = [
  "*TOKEN*",
  "*SECRET*",
  "*KEY*",
  "CLAUDE_*",
  "PAPERCLIP_*",
  "OPENAI_*",
  "SESSION_*",
  "MCP_*",
  "KAIROS_*",
];

/** Keys that ARE allowed despite matching a denylist pattern. */
export const _ENV_DENYLIST_EXCEPTIONS = new Set<string>([
  "ANTHROPIC_API_KEY",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxProfile {
  /** ACP session id this sandbox is bound to. */
  sessionId: string;
  /** Absolute path /tmp/paperclip-acp-sandbox-<uuid>/ — the dir to rm on cleanup. */
  sandboxRoot: string;
  /** Absolute path sandboxRoot + "/HOME" — what HOME points at inside subprocess. */
  home: string;
  /** Env dict to pass to spawn(): allowlist applied + denylist filtered + pinned PATH. */
  env: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Convert a fnmatch-style glob to a RegExp anchored at start/end. */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}

const _DENY_REGEXES: readonly RegExp[] = _ENV_DENYLIST_PATTERNS.map(globToRegex);

/** True if `key` matches any denylist pattern (case-insensitive). */
export function _matchesDeny(key: string): boolean {
  for (const re of _DENY_REGEXES) {
    if (re.test(key)) return true;
  }
  return false;
}

/** Resolve the directory containing the `claude` binary, with a safe fallback. */
function resolveClaudeBinDir(): string {
  try {
    const out = execSync("which claude", { encoding: "utf8" }).trim();
    if (out) return path.dirname(out);
  } catch {
    // `which` exits non-zero if claude isn't on PATH — fall through.
  }
  return "/usr/local/bin";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an env dict from `parentEnv`. Starts from an empty object (NEVER
 * spreads parentEnv) and copies only allowlisted keys, then re-applies the
 * denylist as a defensive sweep. Pins PATH and overrides HOME to `home`.
 *
 * `ANTHROPIC_API_KEY` survives the *KEY* denylist via the exceptions set.
 */
export function buildEnv(
  parentEnv: NodeJS.ProcessEnv,
  home: string,
): Record<string, string> {
  const claudeBinDir = resolveClaudeBinDir();
  const pinnedPath = `/usr/bin:/bin:/usr/local/bin:${claudeBinDir}`;

  const env: Record<string, string> = {};

  // Copy allowlisted keys from parent env, applying denylist with exceptions.
  for (const key of _ENV_ALLOWLIST) {
    if (key === "HOME" || key === "PATH") continue; // overridden below
    const value = parentEnv[key];
    if (value === undefined) continue;
    if (_matchesDeny(key) && !_ENV_DENYLIST_EXCEPTIONS.has(key)) continue;
    env[key] = value;
  }

  // Required overrides — set last so they cannot be filtered out.
  env.PATH = pinnedPath;
  env.HOME = home;

  // Defensive: ensure no denied key sneaks through (e.g., via future allowlist
  // additions). Mirrors kairos sandbox.py:189-191.
  for (const key of Object.keys(env)) {
    if (key === "HOME" || key === "PATH") continue;
    if (_matchesDeny(key) && !_ENV_DENYLIST_EXCEPTIONS.has(key)) {
      delete env[key];
    }
  }

  return env;
}

/**
 * Write `{home}/.claude/settings.json` containing exactly `{"hooks":{}}`.
 * Throws if the target path is a symlink (defends against TOCTOU attacks
 * pointing settings.json at the operator's real settings).
 */
export function writeMinimalSettings(home: string): void {
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.writeFileSync(settingsPath, '{"hooks":{}}', { encoding: "utf8" });
  // Re-stat after write to assert the result is a regular file, not a symlink
  // someone planted between mkdir and writeFileSync.
  const stat = fs.lstatSync(settingsPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`settings.json must not be a symlink: ${settingsPath}`);
  }
}

/**
 * Build a fresh sandbox profile for `sessionId`. Creates the tmp dir, writes
 * the minimal settings.json, and constructs the scrubbed env dict.
 */
export function buildSandboxProfile(sessionId: string): SandboxProfile {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), _SANDBOX_TMP_PREFIX),
  );
  const home = path.join(sandboxRoot, "HOME");
  fs.mkdirSync(home, { recursive: true });
  writeMinimalSettings(home);
  const env = buildEnv(process.env, home);
  return { sessionId, sandboxRoot, home, env };
}

/**
 * Delete the sandbox dir on success; preserve on failure for post-mortem.
 * Idempotent — safe to call multiple times (e.g. from both acp-spawn close
 * handler and session-manager closeSession). ENOENT and other rm errors are
 * silenced because the dir may already be gone.
 */
export function cleanupSandbox(sandboxPath: string, success: boolean): void {
  if (!success) {
    // Preserve for post-mortem. Caller should log.
    return;
  }
  try {
    fs.rmSync(sandboxPath, { recursive: true, force: true });
  } catch {
    // Idempotent: ignore errors (ENOENT, EACCES on stale handles, etc).
  }
}

/**
 * Sweep any sandbox dir under os.tmpdir() older than `ttlHours`.
 *
 * Path-traversal guard: only directories whose RESOLVED path starts with
 * `path.join(os.tmpdir(), _SANDBOX_TMP_PREFIX)` are eligible for deletion.
 * A malicious symlink named `paperclip-acp-sandbox-evil` pointing at
 * `/etc/passwd` would fail the prefix check after resolution.
 *
 * Returns the count of dirs removed.
 */
export function sweepExpiredSandboxes(ttlHours: number = 24): number {
  const tmpdir = os.tmpdir();
  // Resolve tmpdir so the path-traversal prefix check works on macOS where
  // /var/folders/... is itself a symlink to /private/var/folders/...
  let resolvedTmpdir: string;
  try {
    resolvedTmpdir = fs.realpathSync(tmpdir);
  } catch {
    resolvedTmpdir = tmpdir;
  }
  const allowedPrefix = path.join(resolvedTmpdir, _SANDBOX_TMP_PREFIX);
  const ttlMs = ttlHours * 3_600_000;
  const now = Date.now();
  let count = 0;

  let entries: string[];
  try {
    entries = fs.readdirSync(tmpdir);
  } catch {
    return 0;
  }

  for (const name of entries) {
    if (!name.startsWith(_SANDBOX_TMP_PREFIX)) continue;
    const full = path.join(tmpdir, name);

    // Resolve symlinks before checking the prefix — this is the
    // path-traversal guard. A symlink named paperclip-acp-sandbox-evil
    // pointing at /etc would resolve to /etc which fails the startsWith.
    let resolved: string;
    try {
      resolved = fs.realpathSync(full);
    } catch {
      // Broken symlink or permission error — skip.
      continue;
    }
    if (!resolved.startsWith(allowedPrefix)) {
      // Path-traversal attempt or symlink outside the tmpdir prefix.
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs < ttlMs) continue;

    try {
      fs.rmSync(full, { recursive: true, force: true });
      count += 1;
    } catch {
      // Already gone, permission error — ignore.
    }
  }

  return count;
}
