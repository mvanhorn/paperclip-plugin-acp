/**
 * Sandbox unit tests — exercises every FR in spec 167:
 *   FR-2/3/4: env allowlist + denylist + ANTHROPIC_API_KEY exception
 *   FR-5:     pinned PATH
 *   FR-6/7:   isolated HOME + minimal settings.json
 *   FR-8:     cleanup on success / preservation on failure / idempotency
 *   FR-9/10:  TTL sweep + path-traversal guard
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildEnv,
  buildSandboxProfile,
  cleanupSandbox,
  sweepExpiredSandboxes,
  writeMinimalSettings,
  _matchesDeny,
  _SANDBOX_TMP_PREFIX,
} from "../src/sandbox.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Track sandboxes we create so afterEach can rm them. */
const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// buildEnv — denylist enforcement (FR-2/3/4)
// ---------------------------------------------------------------------------

describe("buildEnv", () => {
  it("drops PAPERCLIP_AGENT_ID / CLAUDE_AGENT_ID / KAIROS_SPAWNED / OPENAI_API_KEY", () => {
    const env = buildEnv(
      {
        PAPERCLIP_AGENT_ID: "test",
        CLAUDE_AGENT_ID: "test",
        KAIROS_SPAWNED: "1",
        OPENAI_API_KEY: "sk-test",
        TERM: "dumb",
      },
      "/tmp/fake-home",
    );
    expect(env.PAPERCLIP_AGENT_ID).toBeUndefined();
    expect(env.CLAUDE_AGENT_ID).toBeUndefined();
    expect(env.KAIROS_SPAWNED).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("keeps ANTHROPIC_API_KEY despite *KEY* denylist (exception)", () => {
    const env = buildEnv(
      {
        ANTHROPIC_API_KEY: "sk-ant-test",
        OPENAI_API_KEY: "sk-other",
      },
      "/tmp/fake-home",
    );
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("strips arbitrary *TOKEN* and *SECRET* keys even if not on allowlist", () => {
    // These wouldn't even be copied because they're not on the allowlist,
    // but _matchesDeny is the contract surface and we test it explicitly.
    expect(_matchesDeny("GITHUB_TOKEN")).toBe(true);
    expect(_matchesDeny("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(_matchesDeny("STRIPE_SECRET")).toBe(true);
    expect(_matchesDeny("SOMETHING_KEY")).toBe(true);
  });

  it("matches denylist case-insensitively", () => {
    expect(_matchesDeny("paperclip_agent_id")).toBe(true);
    expect(_matchesDeny("Claude_Agent_Id")).toBe(true);
  });

  it("does NOT flag harmless keys (TERM, LANG, LC_ALL)", () => {
    expect(_matchesDeny("TERM")).toBe(false);
    expect(_matchesDeny("LANG")).toBe(false);
    expect(_matchesDeny("LC_ALL")).toBe(false);
    expect(_matchesDeny("HOME")).toBe(false);
    expect(_matchesDeny("PATH")).toBe(false);
  });

  it("pins PATH and does not expose parent PATH", () => {
    const env = buildEnv(
      { PATH: "/evil/path:/some/other" },
      "/tmp/fake-home",
    );
    expect(env.PATH).toBeDefined();
    expect(env.PATH).not.toBe("/evil/path:/some/other");
    expect(env.PATH).toContain("/usr/bin");
    expect(env.PATH).toContain("/bin");
    expect(env.PATH).toContain("/usr/local/bin");
  });

  it("sets HOME to the sandbox path argument", () => {
    const env = buildEnv({}, "/tmp/sandbox-x/HOME");
    expect(env.HOME).toBe("/tmp/sandbox-x/HOME");
  });

  it("does not spread the entire parent env (must start from empty)", () => {
    const env = buildEnv(
      {
        SOME_RANDOM_VAR: "should-not-survive",
        ANOTHER_VAR: "neither",
        TERM: "dumb",
      },
      "/tmp/fake-home",
    );
    expect(env.SOME_RANDOM_VAR).toBeUndefined();
    expect(env.ANOTHER_VAR).toBeUndefined();
    expect(env.TERM).toBe("dumb");
  });
});

// ---------------------------------------------------------------------------
// writeMinimalSettings (FR-7)
// ---------------------------------------------------------------------------

describe("writeMinimalSettings", () => {
  it('writes exactly {"hooks":{}}', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sbtest-home-"));
    createdDirs.push(home);
    writeMinimalSettings(home);
    const content = fs.readFileSync(
      path.join(home, ".claude", "settings.json"),
      "utf8",
    );
    expect(content).toBe('{"hooks":{}}');
  });

  it("the written settings.json is NOT a symlink", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sbtest-home-"));
    createdDirs.push(home);
    writeMinimalSettings(home);
    const stat = fs.lstatSync(path.join(home, ".claude", "settings.json"));
    expect(stat.isSymbolicLink()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSandboxProfile (integration of buildEnv + writeMinimalSettings)
// ---------------------------------------------------------------------------

describe("buildSandboxProfile", () => {
  it("creates a sandbox dir under tmpdir with the canonical prefix", () => {
    const profile = buildSandboxProfile("sess-1");
    createdDirs.push(profile.sandboxRoot);
    expect(profile.sandboxRoot.startsWith(path.join(os.tmpdir(), _SANDBOX_TMP_PREFIX)))
      .toBe(true);
    expect(fs.existsSync(profile.sandboxRoot)).toBe(true);
    expect(fs.existsSync(profile.home)).toBe(true);
    expect(fs.existsSync(path.join(profile.home, ".claude", "settings.json")))
      .toBe(true);
  });

  it("env.HOME points at the sandbox home", () => {
    const profile = buildSandboxProfile("sess-2");
    createdDirs.push(profile.sandboxRoot);
    expect(profile.env.HOME).toBe(profile.home);
  });

  it("each call returns a distinct sandbox dir", () => {
    const a = buildSandboxProfile("sess-a");
    const b = buildSandboxProfile("sess-b");
    createdDirs.push(a.sandboxRoot, b.sandboxRoot);
    expect(a.sandboxRoot).not.toBe(b.sandboxRoot);
  });
});

// ---------------------------------------------------------------------------
// cleanupSandbox (FR-8)
// ---------------------------------------------------------------------------

describe("cleanupSandbox", () => {
  it("deletes the sandbox dir on success=true", () => {
    const profile = buildSandboxProfile("sess-cleanup-ok");
    expect(fs.existsSync(profile.sandboxRoot)).toBe(true);
    cleanupSandbox(profile.sandboxRoot, true);
    expect(fs.existsSync(profile.sandboxRoot)).toBe(false);
  });

  it("preserves the sandbox dir on success=false", () => {
    const profile = buildSandboxProfile("sess-cleanup-fail");
    createdDirs.push(profile.sandboxRoot);
    cleanupSandbox(profile.sandboxRoot, false);
    expect(fs.existsSync(profile.sandboxRoot)).toBe(true);
    expect(fs.existsSync(path.join(profile.home, ".claude", "settings.json")))
      .toBe(true);
  });

  it("is idempotent — second call on already-deleted dir does not throw", () => {
    const profile = buildSandboxProfile("sess-idempotent");
    cleanupSandbox(profile.sandboxRoot, true);
    expect(() => cleanupSandbox(profile.sandboxRoot, true)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sweepExpiredSandboxes (FR-9/10)
// ---------------------------------------------------------------------------

describe("sweepExpiredSandboxes", () => {
  it("removes a sandbox dir whose mtime is older than ttlHours", () => {
    // Create a dir, then backdate its mtime by 26h.
    const oldDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `${_SANDBOX_TMP_PREFIX}sweep-old-`),
    );
    const past = new Date(Date.now() - 26 * 3_600_000);
    fs.utimesSync(oldDir, past, past);
    // Sanity: dir exists before sweep.
    expect(fs.existsSync(oldDir)).toBe(true);
    sweepExpiredSandboxes(24);
    expect(fs.existsSync(oldDir)).toBe(false);
  });

  it("preserves a sandbox dir whose mtime is fresher than ttlHours", () => {
    const freshDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `${_SANDBOX_TMP_PREFIX}sweep-fresh-`),
    );
    createdDirs.push(freshDir);
    sweepExpiredSandboxes(24);
    expect(fs.existsSync(freshDir)).toBe(true);
  });

  it("path-traversal guard: ignores symlinks resolving outside the prefix", () => {
    // Plant a symlink in tmpdir whose name matches the prefix but whose target
    // is OUTSIDE the allowed prefix. After realpathSync, the resolved path
    // will not start with the prefix and the sweep must skip it.
    const evilName = `${_SANDBOX_TMP_PREFIX}evil-${Date.now()}`;
    const evilPath = path.join(os.tmpdir(), evilName);
    // Point at /etc (a real dir on every macOS / Linux box). /etc is NOT
    // under the paperclip-acp-sandbox- prefix, so the guard must skip.
    try {
      fs.symlinkSync("/etc", evilPath);
    } catch {
      // If symlinks aren't permitted (rare), the test is moot — bail gracefully.
      return;
    }
    try {
      const past = new Date(Date.now() - 48 * 3_600_000);
      fs.lutimesSync(evilPath, past, past);
      sweepExpiredSandboxes(24);
      // /etc must STILL exist.
      expect(fs.existsSync("/etc")).toBe(true);
    } finally {
      try {
        fs.unlinkSync(evilPath);
      } catch {
        /* ignore */
      }
    }
  });

  it("returns the count of sandboxes removed", () => {
    const a = fs.mkdtempSync(
      path.join(os.tmpdir(), `${_SANDBOX_TMP_PREFIX}sweep-count-a-`),
    );
    const b = fs.mkdtempSync(
      path.join(os.tmpdir(), `${_SANDBOX_TMP_PREFIX}sweep-count-b-`),
    );
    const past = new Date(Date.now() - 30 * 3_600_000);
    fs.utimesSync(a, past, past);
    fs.utimesSync(b, past, past);
    const removed = sweepExpiredSandboxes(24);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
  });
});
