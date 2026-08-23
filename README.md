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
plugin.paperclip-plugin-line.acp-spawn
```

**Inbound events (chat plugin -> ACP)**

| Event suffix | Payload | Description |
|-------------|---------|-------------|
| `acp-spawn` | `{ sessionId?, agentName, chatId, threadId, companyId, cwd?, mode? }` | Spawn an agent session bound to a thread. If `sessionId` is supplied, ACP uses it so chat bridges can route follow-up messages and output deterministically. |
| `acp-message` | `{ sessionId, text }` | Send a prompt to a running session |
| `acp-cancel` | `{ sessionId }` | SIGINT the current turn |
| `acp-close` | `{ sessionId }` | SIGTERM and remove the session |

**Outbound events (ACP -> chat plugin)**

| Event | Payload | Description |
|-------|---------|-------------|
| `output` | `{ sessionId, type, text?, error?, chatId, threadId }` | Agent output routed back to the originating thread |

The ACP plugin registers listeners for Telegram, Slack, Discord, and LINE on startup. Adding a new platform requires adding its plugin ID to `CHAT_PLATFORM_PLUGINS` in `constants.ts`.

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

## Troubleshooting: confirm your Paperclip host

If spawns or sessions fail, first confirm which Paperclip host this plugin is registered against. Run `paperclipai plugin target` ([#8575](https://github.com/paperclipai/paperclip/pull/8575)) — it prints the resolved API URL plus the server's status, version, deploymentMode, and deploymentExposure *before* anything is installed. A server version older than this plugin expects is the most common cause of activation and session-spawn errors that look like plugin bugs but aren't. If the URL or version is wrong, point Paperclip at the right host — or update the server — before opening an issue.

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

### Host compatibility and config delivery

Paperclip **v2026.720.0** and newer require a company scope for every plugin
configuration read ([paperclipai/paperclip#9557](https://github.com/paperclipai/paperclip/pull/9557)).
A plugin worker starts outside any company invocation, so it cannot read its own
configuration at startup on those hosts.

This plugin is built for that: the worker always starts on its built-in
defaults, registers its tools and event listeners, and adopts a company's
configuration as soon as one becomes reachable — from the host's config
delivery, from a startup walk over the companies it can see, or from the first
company-scoped event or tool call. It never fails activation because a
configuration is unavailable.

| Paperclip version | Behaviour |
|-------------------|-----------|
| >= v2026.817.0 | The worker reads the stored configuration at boot for companies that already have one, and picks up later saves without a restart. |
| v2026.720.0 - v2026.722.0 | Worker-initiated config reads are denied. The runtime picks up your settings when the host delivers them: **save the plugin configuration once after installing** and the worker adopts it in place, no restart needed. |
| < v2026.720.0 | Unaffected; the worker runs on whatever configuration the host delivers. |

Until a company configuration has been adopted, the plugin runs on the defaults
in the table above — it is fully functional, just untuned. The plugin health
panel shows where the active configuration came from (`configSource`) and, if
the host refused a read, the exact host error.

The plugin runs a **single company's configuration** per worker. The first
company whose configuration resolves owns the runtime; a later save for that
same company refreshes it. Serving several companies from one worker is a
possible follow-up, not current behaviour.

## Agent tools

The plugin exposes these tools to Paperclip agents:

| Tool | Description |
|------|-------------|
| `acp_spawn` | Start a new coding agent session (agent, mode, cwd, initial prompt) |
| `acp_status` | List active sessions with uptime, idle time, and binding info |
| `acp_send` | Send a prompt to an active session |
| `acp_cancel` | Cancel the current turn (SIGINT) |
| `acp_close` | Close a session and remove thread bindings |

## How it works

```
Chat message (Telegram/Discord/Slack)
    -> Chat plugin emits acp:spawn / acp:message event
    -> ACP plugin routes to bound session
    -> Coding agent subprocess (stdio)
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

241 tests covering session lifecycle, spawn/send/cancel/close flows, 1:N session support, idle timeout, max age, lazy migration, cross-plugin event routing, orchestration guards, webhook hooks, attachments, the company-scoped config host matrix, and error handling.

## Contributing

Issues and PRs welcome at [github.com/mvanhorn/paperclip-plugin-acp](https://github.com/mvanhorn/paperclip-plugin-acp).

Auto-publishes to npm on push to `main` via OIDC trusted publishing.

## Architecture reference

This plugin follows patterns from [OpenClaw's ACP implementation](https://github.com/openclaw/openclaw), which has extensive ACP support for Discord, Telegram, Slack, and Matrix with thread-bound sessions, agent spawning, and session lifecycle management.

## License

MIT
