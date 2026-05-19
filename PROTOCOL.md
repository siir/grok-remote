# grok-remote internal protocol notes

What the backend has to speak, and what the frontend has to render. Captured from probing `grok agent stdio` (ACP / JSON-RPC) against grok 0.1.212.

Raw experiment logs are in `experiments/exp1.log` (simple text reply) and `experiments/exp2.log` (tool-call attempt). `experiments/probe.js` is the test harness.

---

## Transport

`grok agent --no-leader --always-approve stdio` — JSON-RPC 2.0 over stdin/stdout, newline-delimited, UTF-8. One JSON object per line.

Pass `--always-approve` so the agent does not block on permission prompts (we still need to implement the callbacks correctly).

`--no-leader` keeps each agent process independent so we can manage many in parallel.

## Handshake

Client → Agent:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":1,
  "clientCapabilities":{
    "fs":{"readTextFile":true,"writeTextFile":true},
    "terminal":true
  }
}}
```

Agent → Client (response):

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":1,
  "agentCapabilities":{
    "loadSession":true,
    "promptCapabilities":{"image":false,"audio":false,"embeddedContext":true},
    "mcpCapabilities":{"http":true,"sse":true},
    "_meta":{"x.ai/fs_notify":true}
  },
  "authMethods":[...],
  "_meta":{
    "grokShell":true,
    "currentWorkingDirectory":"...",
    "agentVersion":"0.1.212",
    "agentId":"<uuid>",
    "agentInstanceId":"<uuid>",
    "hostname":"...",
    "modelState":{"currentModelId":"grok-build","availableModels":[...]},
    "availableCommands":[
      {"name":"compact","description":"...","input":{"hint":"..."}},
      {"name":"always-approve","description":"...","input":{"hint":"on|off"}},
      {"name":"context","description":"...","input":null},
      {"name":"session-info","description":"...","input":null}
    ]
  }
}}
```

The `_meta` block is gold for the dashboard: agent ID, model, working dir, hostname, available slash commands.

## Session lifecycle

```
initialize        →  agent ready
session/new       →  { sessionId }
session/prompt    →  starts a turn; agent streams session/update notifications; resolves with stopReason + token usage
session/load      →  resume an existing session (agentCapabilities.loadSession=true)
session/cancel    →  cancel an in-flight prompt (assumed; verify in implementation)
```

### session/new params

```json
{"cwd":"<absolute path>","mcpServers":[]}
```

### session/prompt params

```json
{"sessionId":"<id>","prompt":[{"type":"text","text":"..."}]}
```

Prompts are an array of content blocks. `type:"text"` is the basic one. The handshake's `promptCapabilities` reveals whether `image`/`audio`/`embeddedContext` are accepted.

### session/prompt response

```json
{"stopReason":"end_turn","_meta":{
  "sessionId":"...","requestId":"...","promptId":"...",
  "totalTokens":17382,"modelId":"grok-build",
  "inputTokens":17324,"outputTokens":58,
  "cachedReadTokens":128,"reasoningTokens":57
}}
```

Other stopReasons we should expect: `max_tokens`, `cancelled`, `error`, `tool_use` (TBD — verify when seen).

## Streaming events (Agent → Client notifications)

All sent as `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{...},"_meta":{...}}}`.

Discriminator: `params.update.sessionUpdate`.

| sessionUpdate                  | Payload                                                                 | UI rendering                                              |
| ------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `agent_message_chunk`          | `content: {type:"text", text:"..."}`                                    | Append to assistant message buffer.                       |
| `agent_thought_chunk`          | `content: {type:"text", text:"..."}`                                    | Render in a collapsible "thinking" pane.                  |
| `tool_call`                    | `toolCallId, title, rawInput{...}` + `_meta.updateParams{kind,status}`  | Start a tool-call card. Status: `Pending`.                |
| `tool_call_update`             | `toolCallId, kind, title, content[], locations[], rawInput, _meta.updateParams.status` | Patch the existing card (title, status, output).         |
| `tool_call_delta_chunk`        | Incremental chunks (TBD shape; treat as append-to-most-recent-tool)     | Stream output into the current tool card.                 |
| `available_commands_update`    | Updated `availableCommands` list                                        | Refresh the slash-command palette.                        |
| `session_summary_generated`    | Compaction summary text                                                 | Show a "context compacted" pill.                          |

`_meta` on every update carries: `totalTokens, eventId, agentTimestampMs, promptId, streamStartMs, turnStartMs, updateType, updateParams`. Use these for ordering, timing, and live token-usage display.

### Tool call lifecycle (observed)

1. `tool_call` (status `Pending`) — agent decided to call a tool. `rawInput` has the args (e.g. `{command, timeout, description}` for shell).
2. Agent sends `terminal/create` (or `fs/...`) as a JSON-RPC **request** back to us (the client). We MUST execute it and reply, or the tool fails.
3. `tool_call_update` — status transitions to `Running`, then `Completed` or `Failed`. `content[]` may carry text output, locations, etc.
4. Multiple `tool_call_delta_chunk` may stream between 2 and 3 for live output (e.g. long-running terminals).

## Agent → Client requests (we MUST handle)

The agent calls back into the client to do real work. Observed in exp2 — when we returned `{}` for `terminal/create`, all tool calls failed.

| method                  | Purpose                                                            | Minimal response                              |
| ----------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| `terminal/create`       | Spawn a shell command; capture output; return a terminal ID        | `{terminalId:"..."}` + actually run the cmd   |
| `terminal/output`       | Read accumulated output                                            | `{output:"...", truncated:false}`             |
| `terminal/wait_for_exit`| Block until exit                                                   | `{exitStatus:{exitCode:N, signal:null}}`      |
| `terminal/kill`         | SIGKILL                                                            | `{}`                                          |
| `terminal/release`      | Cleanup                                                            | `{}`                                          |
| `fs/read_text_file`     | Read a file                                                        | `{content:"..."}`                             |
| `fs/write_text_file`    | Write a file                                                       | `{}`                                          |
| `session/request_permission` | Ask user to approve a tool call (skipped under `--always-approve`) | `{outcome:{outcome:"selected",optionId:"allow_always"}}` |

Notes:
- The `terminal/create` request includes a full `env` array, `cwd`, `outputByteLimit`. Respect those when we spawn.
- We run commands in the agent's working directory, NOT the backend's. Get cwd from the handshake `_meta.currentWorkingDirectory` and the per-session cwd from `session/new`.
- For multi-agent isolation: each agent process gets its own working directory (a per-agent dir under `~/.grok-remote/agents/<id>/cwd/`).

## x.ai/* notifications (Agent → Client, no response required)

| method                         | Purpose                                          | UI |
| ------------------------------ | ------------------------------------------------ | -- |
| `_x.ai/session_notification`   | Auto-compact, retry state, diff review            | Toast / pill in the conversation. |
| `_x.ai/git_head_changed`       | HEAD moved (relevant if agent has a git worktree) | Update a small VCS indicator.     |
| `_x.ai/models/update`          | Model list / current model changed                | Refresh model picker.             |
| `_x.ai/session/prompt_complete`| Turn fully complete (after the response message). | Mark turn as final.               |

There are 72 `x.ai/*` extension methods total per the docs (fs, git, search, terminal, code, session, auth, telemetry). We start by handling only what the agent calls during normal operation and add others as we see them.

---

# Backend HTTP API (server.js)

Everything is JSON. All URLs are relative to the server root.

## Agents

| Method | Path                     | Purpose                                              |
| ------ | ------------------------ | ---------------------------------------------------- |
| GET    | `/api/agents`            | List agents (id, name, model, status, cwd, lastSeen) |
| POST   | `/api/agents`            | Spawn a new agent. Body: `{name?, model?, cwd?}`     |
| GET    | `/api/agents/:id`        | Agent details + handshake info                       |
| DELETE | `/api/agents/:id`        | Kill the process, remove from registry               |
| POST   | `/api/agents/:id/prompt` | Send a `session/prompt`. Body: `{text}`              |
| POST   | `/api/agents/:id/cancel` | Cancel the in-flight prompt                          |
| GET    | `/api/agents/:id/history`| Conversation history (in-memory)                     |

## Streaming

| Path                     | Transport | Payload                                                          |
| ------------------------ | --------- | ---------------------------------------------------------------- |
| `/api/agents/:id/stream` | SSE       | Every `session/update` + lifecycle events forwarded as SSE events |

SSE event names mirror the upstream discriminator: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `tool_call_delta_chunk`, `available_commands_update`, `session_summary_generated`, plus our own `agent_status` (lifecycle), `prompt_complete` (after the prompt result), and `error`.

Each SSE event's `data` is JSON: the unwrapped `update` object plus a `_t` timestamp.

Reconnect logic: client sends `Last-Event-ID`. Server buffers the last N events (e.g. 200) per agent and replays.

## Settings

| Method | Path           | Body                                                                  |
| ------ | -------------- | --------------------------------------------------------------------- |
| GET    | `/api/settings`| Returns the merged settings                                           |
| PATCH  | `/api/settings`| Merge in `{defaultModel, defaultCwd, autoApprove, ...}`               |

Persist to `~/.grok-remote/settings.json`.

## Other

| Method | Path             | Notes                                                              |
| ------ | ---------------- | ------------------------------------------------------------------ |
| GET    | `/api/hello`     | Existing health-y endpoint, also returns tailscale identity        |
| GET    | `/api/health`    | Liveness                                                           |
| GET    | `/api/models`    | List installed models (from agent handshake or `grok models list`) |

---

# Frontend rendering rules (src/)

Per agent conversation, render a stream as a sequence of turns. Each turn has a chronological list of blocks:

1. **User message** — the prompt text.
2. **Thought** (collapsed by default) — concatenated `agent_thought_chunk.content.text`.
3. **Tool call** card — created on `tool_call`, patched by `tool_call_update`/`tool_call_delta_chunk`. Show: title, status pill (Pending/Running/Completed/Failed), expandable rawInput, expandable output stream.
4. **Assistant message** — concatenated `agent_message_chunk.content.text`.
5. **Footer chip** — token usage from the `prompt_complete` event (input/output/cached/reasoning + cost estimate).

Sidebar shows the agent list with:
- name (editable)
- model
- status dot (idle / running / errored / killed)
- last activity time
- "send message" affordance

Settings view: default model, default cwd, auto-approve toggle, agent retention policy (keep history N days), color theme.

---

# Open questions to revisit during implementation

- Exact shape of `tool_call_delta_chunk` — never observed in exp1; only when terminal streams output. Capture in a follow-up experiment once we wire `terminal/create` correctly.
- Does `session/cancel` exist? Verify by sending one and watching the response.
- How does `session/load` work for resuming? `agentCapabilities.loadSession=true` means yes, but the shape needs probing.
- MCP server config in `session/new` — leave empty for v1; expose UI later.
