# paperclip-plugin-acp

[![npm](https://img.shields.io/npm/v/paperclip-plugin-acp)](https://www.npmjs.com/package/paperclip-plugin-acp)

ACP (Agent Client Protocol) runtime plugin for Paperclip. Run Claude Code, Codex, Gemini CLI, and other coding agents from any chat platform through thread-bound sessions.

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

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `enabledAgents` | `claude,codex,gemini,opencode` | Comma-separated list of enabled agents |
| `defaultAgent` | `claude` | Agent used when none specified |
| `defaultMode` | `persistent` | `persistent` (stays alive) or `oneshot` (single task) |
| `defaultCwd` | `/workspace` | Working directory for spawned agents |
| `sessionIdleTimeoutMs` | `1800000` | Close idle sessions after 30 min |
| `sessionMaxAgeMs` | `28800000` | Close sessions after 8 hours |

## Agent tools

The plugin exposes these tools to Paperclip agents:

- `acp_spawn` - Start a new coding agent session
- `acp_status` - List active sessions
- `acp_send` - Send a prompt to an active session
- `acp_cancel` - Cancel the current turn
- `acp_close` - Close a session and remove bindings

## Event bus

Chat plugins communicate with the ACP plugin via events:

- `acp:message` - Chat plugin sends a message to an ACP session
- `acp:output` - ACP plugin sends agent output back to the chat thread

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
