# paperclip-plugin-acp

[![npm](https://img.shields.io/npm/v/paperclip-plugin-acp)](https://www.npmjs.com/package/paperclip-plugin-acp)

ACP (Agent Client Protocol) runtime plugin for Paperclip. Run Claude Code, Codex, Gemini CLI, and other coding agents from any chat platform through thread-bound sessions.

## Install

```bash
npm install paperclip-plugin-acp
```

Then register with your Paperclip instance:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"paperclip-plugin-acp"}'
```

## What is ACP?

[Agent Client Protocol](https://agentclientprotocol.com/) is a standard for connecting clients to AI coding agents. Created by Zed Industries, it's supported by Claude Code, Codex CLI, Gemini CLI, OpenCode, and 19+ others. This plugin brings ACP to Paperclip.

## How it works

```
Chat message (Telegram/Discord/Slack)
    -> Paperclip chat plugin emits acp:message event
    -> ACP plugin routes to bound session
    -> Coding agent (subprocess over stdio)
    -> Agent output emitted as acp:output event
    -> Chat plugin sends response to thread
```

Chat plugins (Telegram, Discord, Slack) bind threads/topics to ACP sessions via Paperclip's event bus. Each thread becomes a persistent workspace for a coding agent.

## Supported agents

| Agent | Command | Status |
|-------|---------|--------|
| Claude Code | `claude` | Supported |
| Codex CLI | `codex` | Supported |
| Gemini CLI | `gemini` | Supported |
| OpenCode | `opencode` | Supported |

Agents must be installed on the Paperclip server. The plugin spawns them as subprocesses.

## 1:N session support

A single chat thread can run up to 5 concurrent agent sessions (configurable via `maxSessionsPerThread`). Spawn multiple agents in the same thread - for example, Claude Code reviewing while Codex implements - and route messages to each by session ID.

Active sessions are stored per-thread as an array. Closed or errored sessions don't count toward the cap. The `acp_status` tool lists all active sessions with uptime, idle time, and binding info.

### Lazy migration from 1:1 format

Existing threads that used the old 1:1 binding format (`acp_{chatId}_{threadId}` key) are migrated automatically on first access. The old key is read, converted to a single-entry sessions array under the new `acp_sessions_{chatId}_{threadId}` key, and the old key is deleted. No manual migration needed.

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

- `acp_spawn` - Start a new coding agent session
- `acp_status` - List active sessions
- `acp_send` - Send a prompt to an active session
- `acp_cancel` - Cancel the current turn
- `acp_close` - Close a session and remove bindings

## Cross-plugin event system

Chat plugins communicate with the ACP plugin via namespaced events on Paperclip's event bus. Each platform plugin (Telegram, Slack, Discord) emits events under its own namespace:

```
plugin.paperclip-plugin-telegram.acp-spawn
plugin.paperclip-plugin-slack.acp-message
plugin.paperclip-plugin-discord.acp-close
```

### Inbound events (chat plugin -> ACP)

| Event suffix | Payload | Description |
|-------------|---------|-------------|
| `acp-spawn` | `{ agentName, chatId, threadId, companyId, cwd?, mode? }` | Spawn an agent session bound to a thread |
| `acp-message` | `{ sessionId, text }` | Send a prompt to a running session |
| `acp-cancel` | `{ sessionId }` | SIGINT the current turn |
| `acp-close` | `{ sessionId }` | SIGTERM and remove the session |

### Outbound events (ACP -> chat plugin)

| Event | Payload | Description |
|-------|---------|-------------|
| `output` | `{ sessionId, type, text?, error?, chatId, threadId }` | Agent output routed back to the originating thread |

The ACP plugin registers listeners for all three platforms on startup. Adding a new platform requires adding its plugin ID to `CHAT_PLATFORM_PLUGINS` in `constants.ts`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
```

Install locally on a Paperclip instance:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/path/to/paperclip-plugin-acp","isLocalPath":true}'
```

## Architecture reference

This plugin follows patterns from [OpenClaw's ACP implementation](https://github.com/openclaw/openclaw), which has extensive ACP support for Discord, Telegram, Slack, and Matrix with thread-bound sessions, agent spawning, and session lifecycle management.
