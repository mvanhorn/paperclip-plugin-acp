# paperclip-plugin-acp

[![npm](https://img.shields.io/npm/v/paperclip-plugin-acp)](https://www.npmjs.com/package/paperclip-plugin-acp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

ACP (Agent Client Protocol) runtime plugin for [Paperclip](https://github.com/paperclipai/paperclip). Run Claude Code, Codex, Gemini CLI, and other coding agents from any chat platform through thread-bound sessions.

Built on the Paperclip plugin SDK.

## Why this exists

Paperclip's chat plugins (Telegram, Discord, Slack) let users interact with agents through messaging platforms, but they need a runtime to actually spawn and manage coding agent processes. The ACP plugin is that runtime - it bridges chat messages to subprocess-managed coding agents over stdio, following the [Agent Client Protocol](https://agentclientprotocol.com/) standard created by Zed Industries.

Without this plugin, the `/acp spawn`, `/acp status`, and `/acp close` commands in the chat plugins have nothing to connect to.

## What it does

### Agent lifecycle management
- **Spawn agents** as subprocesses over stdio from any chat platform
- **Persistent sessions** - agents stay alive for follow-up prompts within the same thread
- **Oneshot mode** - single-task sessions that auto-close after completion
- **Idle timeout** - sessions close after 30 min of inactivity (configurable)
- **Max age** - sessions close after 8 hours regardless of activity (configurable)
- **Graceful shutdown** - SIGTERM with cleanup of thread bindings and state

### 1:N session support
- A single chat thread can run up to 5 concurrent agent sessions (configurable via `maxSessionsPerThread`)
- Spawn multiple agents in the same thread - for example, Claude Code reviewing while Codex implements
- Route messages to specific sessions by session ID
- Active sessions tracked per-thread as an array; closed/errored sessions don't count toward the cap
- The `acp_status` tool lists all active sessions with uptime, idle time, and binding info

### Supported agents

| Agent | Command | Status |
|-------|---------|--------|
| Claude Code | `claude` | Supported |
| Codex CLI | `codex` | Supported |
| Gemini CLI | `gemini` | Supported |
| OpenCode | `opencode` | Supported |

Agents must be installed on the Paperclip server. The plugin spawns them as subprocesses.

### Cross-plugin event system

Chat plugins communicate with the ACP plugin via namespaced events on Paperclip's event bus. Each platform plugin emits events under its own namespace:

```
plugin.paperclip-plugin-telegram.acp-spawn
plugin.paperclip-plugin-slack.acp-message
plugin.paperclip-plugin-discord.acp-close
```

**Inbound events (chat plugin -> ACP)**

| Event suffix | Payload | Description |
|-------------|---------|-------------|
| `acp-spawn` | `{ agentName, chatId, threadId, companyId, cwd?, mode? }` | Spawn an agent session bound to a thread |
| `acp-message` | `{ sessionId, text }` | Send a prompt to a running session |
| `acp-cancel` | `{ sessionId }` | SIGINT the current turn |
| `acp-close` | `{ sessionId }` | SIGTERM and remove the session |

**Outbound events (ACP -> chat plugin)**

| Event | Payload | Description |
|-------|---------|-------------|
| `output` | `{ sessionId, type, text?, error?, chatId, threadId }` | Agent output routed back to the originating thread |

The ACP plugin registers listeners for all three platforms (Telegram, Slack, Discord) on startup. Adding a new platform requires adding its plugin ID to `CHAT_PLATFORM_PLUGINS` in `constants.ts`.

### Lazy migration from 1:1 format
Existing threads that used the old 1:1 binding format (`acp_{chatId}_{threadId}` key) are migrated automatically on first access. The old key is read, converted to a single-entry sessions array under the new `acp_sessions_{chatId}_{threadId}` key, and the old key is deleted. No manual migration needed.

## Install

```bash
npm install paperclip-plugin-acp
```

Or register with your Paperclip instance directly:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"paperclip-plugin-acp"}'
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `enabledAgents` | `claude,codex,gemini,opencode` | Comma-separated list of enabled agents |
| `defaultAgent` | `claude` | Agent used when none specified |
| `defaultMode` | `persistent` | `persistent` (stays alive) or `oneshot` (single task) |
| `defaultCwd` | `/workspace` | Working directory for spawned agents |
| `sessionIdleTimeoutMs` | `1800000` | Close idle sessions after 30 min |
| `sessionMaxAgeMs` | `28800000` | Close sessions after 8 hours |
| `maxSessionsPerThread` | `5` | Max concurrent sessions per chat thread |

## Agent tools

The plugin exposes these tools to Paperclip agents:

| Tool | Description |
|------|-------------|
| `acp_spawn` | Start a new coding agent session (agent, mode, cwd, initial prompt) |
| `acp_status` | List active sessions with uptime, idle time, and binding info |
| `acp_send` | Send a prompt to an active session |
| `acp_cancel` | Cancel the current turn (SIGINT) |
| `acp_close` | Close a session and remove thread bindings |

## Sandbox isolation (v0.6.0+)

Each spawned agent subprocess runs inside a disposable host-isolation
sandbox so the operator's `~/.claude/` config, hooks, and shell env do
not bleed into the spawned agent.

What the sandbox enforces:

- **Isolated HOME** — every spawn gets its own temp dir under
  `/tmp/paperclip-acp-sandbox-<uuid>/`. `$HOME` inside the child points
  at `<sandbox>/HOME`, not the operator's real home directory.
- **Minimal `~/.claude/settings.json`** — the sandbox writes exactly
  `{"hooks":{}}` into the isolated HOME. The operator's PostToolUse,
  Stop, and other hooks cannot fire inside the spawned agent and
  therefore cannot inject `[Task Active]`-style marker text into its
  stdout.
- **Env allowlist + denylist** — the child env starts from `{}`. Only
  `HOME`, `PATH`, `LANG`, `LC_ALL`, `TERM`, and `ANTHROPIC_API_KEY` pass
  through. Anything matching `*TOKEN*`, `*SECRET*`, `*KEY*`,
  `CLAUDE_*`, `PAPERCLIP_*`, `OPENAI_*`, `SESSION_*`, `MCP_*`, or
  `KAIROS_*` is stripped. `ANTHROPIC_API_KEY` is the one explicit
  exception to the `*KEY*` pattern (required for `claude -p`).
- **Pinned PATH** — `/usr/bin:/bin:/usr/local/bin:<claude-bin-dir>`.
  The parent's PATH (which may include the operator's project bins,
  homebrew, etc.) does not leak through.
- **Cleanup on success / preservation on failure** — sandbox dirs are
  deleted when the agent exits with code 0 and preserved on non-zero
  exits so the operator can inspect what the child saw. A TTL sweeper
  removes any sandbox older than 24h on plugin startup and on each
  reaper tick (path-traversal-guarded — only directories under
  `/tmp/paperclip-acp-sandbox-` are eligible).

Source-of-truth reference: this is a TypeScript port of the kairos
`daemon/sandbox.py` design that closed the chat-bleed property class
identified in commit `dc9884a`. See `src/sandbox.ts` for the
implementation and `tests/sandbox.test.ts` for the unit-test contract.

## How it works

```
Chat message (Telegram/Discord/Slack)
    -> Chat plugin emits acp:spawn / acp:message event
    -> ACP plugin routes to bound session
    -> Coding agent subprocess (stdio, isolated HOME, scrubbed env)
    -> Agent output emitted as acp:output event
    -> Chat plugin sends response to thread
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

~50 tests covering session lifecycle, spawn/send/cancel/close flows, 1:N session support, idle timeout, max age, lazy migration, cross-plugin event routing, and error handling.

## Contributing

Issues and PRs welcome at [github.com/mvanhorn/paperclip-plugin-acp](https://github.com/mvanhorn/paperclip-plugin-acp).

Auto-publishes to npm on push to `main` via OIDC trusted publishing.

## Architecture reference

This plugin follows patterns from [OpenClaw's ACP implementation](https://github.com/openclaw/openclaw), which has extensive ACP support for Discord, Telegram, Slack, and Matrix with thread-bound sessions, agent spawning, and session lifecycle management.

## License

MIT
