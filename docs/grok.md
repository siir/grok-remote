# `grok` top-level reference

The interactive TUI plus the umbrella for every subcommand. Run without args to open the TUI in `$PWD`; pass a subcommand for non-interactive work.

Captured from `grok --help` against:

```
grok 0.1.212 (b7b8204a484)
```

## Top-level shape

```
grok [OPTIONS] [COMMAND]
```

Without `[COMMAND]` you get the TUI. With a command (`agent`, `mcp`, `leader`, etc.) the top-level options still apply as defaults.

## Options

| Flag | Description |
|---|---|
| `--agent <NAME>` | Agent name or path to an agent profile file. Picks a non-default persona / toolset. |
| `--agents <JSON>` | Inline subagent definitions as JSON. Useful for headless pipelines. |
| `--allow <RULE>` | Permission allow rule, e.g. `Bash(npm*)`. Repeatable. |
| `--always-approve` | Auto-approve every tool call. Equivalent of YOLO mode. |
| `--best-of-n <N>` | Run the task N ways in parallel and pick the best. Headless only. |
| `-c, --continue` | Continue the most recent session in this cwd. |
| `--check` | Append a self-verification loop to the prompt. Headless only. |
| `--cwd <CWD>` | Working directory for the session. Defaults to `$PWD`. |
| `--deny <RULE>` | Permission deny rule, e.g. `Bash(rm*)`. Repeatable. Deny wins over allow. |
| `--disable-web-search` | Disable the `web_search` and `web_fetch` tools. |
| `--disallowed-tools <TOOLS>` | Comma-separated tool names to remove, e.g. `web_search,run_terminal_cmd`. Supports `Agent` / `Agent(explore)` to limit subagent spawning. |
| `--effort <LEVEL>` | Effort level: `low`, `medium`, `high`, `xhigh`, `max`. Headless only. |
| `--experimental-memory` | Enable cross-session memory for this run. |
| `-h, --help` | Print help. |
| `-m, --model <MODEL>` | Model ID, e.g. `grok-build`. |
| `--max-turns <N>` | Cap the number of agent turns. Headless only. |
| `--no-alt-screen` | Run inline instead of using the terminal alternate screen. Useful inside tmux / screen. |
| `--no-memory` | Disable cross-session memory for this session. |
| `--no-plan` | Disable plan mode. |
| `--no-subagents` | Disable subagent spawning. |
| `--oauth` | Use OAuth on the welcome screen when authentication starts. |
| `--output-format <FMT>` | Headless output format: `plain` (default), `json`, `streaming-json`. |
| `-p, --single <PROMPT>` | Single-turn prompt; prints the response and exits (headless mode). |
| `--permission-mode <MODE>` | Permission mode: `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`. |
| `--prompt-file <PATH>` | Single-turn prompt read from a file. |
| `--prompt-json <JSON>` | Single-turn prompt as JSON content blocks (used for image + text). |
| `-r, --resume [<SESSION_ID>]` | Resume a session by ID. Omit ID to resume the most recent. |
| `--reasoning-effort <EFFORT>` | Reasoning effort for reasoning models: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `--restore-code` | When resuming, check out the original session's commit. |
| `--rules <RULES>` | Extra rules appended to the system prompt. |
| `--sandbox <PROFILE>` | Sandbox profile name. `GROK_SANDBOX` env honored. |
| `--system-prompt-override <PROMPT>` | Replace the agent's system prompt entirely. |
| `--tools <TOOLS>` | Comma-separated allowlist of built-in tools (disables default tool injection). |
| `-v, --version` | Print version. |
| `--verbatim` | Send the prompt exactly as given (no implicit wrapping). |
| `-w, --worktree [<NAME>]` | Start the session inside a new git worktree, optionally named. |

## Subcommands

| Command | Purpose | Doc |
|---|---|---|
| `agent` | Run grok without the interactive UI. | [agent.md](./agent.md) |
| `import` | Import sessions into grok. | [import.md](./import.md) |
| `inspect` | Show the configuration grok discovers for this directory. | [inspect.md](./inspect.md) |
| `leader` | Manage running leader processes. | [leader.md](./leader.md) |
| `login` | Sign in to grok. | [login.md](./login.md) |
| `mcp` | Manage MCP server configurations. | [mcp.md](./mcp.md) |
| `memory` | Manage cross-session memory. | [memory.md](./memory.md) |
| `models` | List available models and exit. | [models.md](./models.md) |
| `sessions` | List, search, or restore sessions. | [sessions.md](./sessions.md) |
| `setup` | Fetch and install managed deployment configuration. | [setup.md](./setup.md) |
| `share` | Share a session and print the share URL. | [share.md](./share.md) |
| `ssh` | Run ssh with local clipboard support. | [ssh.md](./ssh.md) |
| `trace` | Export or upload session trace data. | [trace.md](./trace.md) |
| `update` | Check for updates or install a specific version. | [update.md](./update.md) |
| `version` | Print version information. | [version.md](./version.md) |
| `worktree` | Manage git worktrees. | [worktree.md](./worktree.md) |

## Typical invocations

```sh
# Interactive TUI in the current dir
grok

# One-shot prompt, headless, machine-readable output
grok -p "summarize the readme" --output-format json

# Resume the latest session from this dir
grok -c

# Resume a specific session
grok --resume 019e4056-7a38-7e72-9922-685b5b582549

# Locked-down headless run: only read-only tools, max 5 turns
grok -p "audit deps" --tools "read_file,grep,list_dir" --max-turns 5 --yolo

# Start in a fresh git worktree so messy edits stay contained
grok -w experiment-1
```

## Notes on flag interactions

- `--tools` and `--disallowed-tools` are headless-only (`-p`); they are ignored with a warning inside the TUI.
- `--effort` and `--max-turns` are headless-only too.
- `--allow` / `--deny` work in both TUI and headless. Deny rules beat allow rules.
- `--always-approve` is the same as the YOLO permission mode but spelled out; useful for unattended runs.
- `--system-prompt-override` and `--rules` are mutually compatible: `--rules` appends to whatever system prompt is active (overridden or default).
