# `grok leader`

Inspect and control the shared "leader" backend process that multiple grok clients can attach to. The leader holds session state, MCP connections, skill caches, and the model conversation; with `[cli] use_leader = true` set in `config.toml`, every new `grok` and `grok agent` invocation attaches to it instead of spawning its own backend.

Captured from `grok leader --help` against grok 0.1.212.

## Shape

```
grok leader <COMMAND>
```

## Subcommands

| Command | Purpose |
|---|---|
| `list` | List running leader processes. |
| `info` | Show details for one leader. |
| `kill` | Stop all running leaders. |
| `profile` | Manage CPU profiling for a leader (`status` / `start` / `stop`). |

(There is a separate `grok agent leader` for *running* as a leader. This page is about *managing* already-running leaders.)

## `grok leader list`

```
grok leader list [--json]
```

| Flag | Description |
|---|---|
| `--json` | Machine-readable JSON output. |

Use this first to get the pids you need for `info` / `profile`.

## `grok leader info`

```
grok leader info [--pid <PID>] [--json]
```

| Flag | Description |
|---|---|
| `--pid <PID>` | Leader process id (from `grok leader list`). If omitted with multiple leaders running, grok errors out. |
| `--json` | Machine-readable JSON output. |

Reports working directory, model, attached clients, MCP server states, memory footprint, and uptime.

## `grok leader kill`

```
grok leader kill
```

No flags. Stops every running leader. Active sessions are preserved on disk; clients reconnecting will spawn fresh leaders if needed.

## `grok leader profile`

```
grok leader profile <COMMAND>
```

| Subcommand | Purpose |
|---|---|
| `status` | Show whether the leader is currently profiling. |
| `start [--frequency-hz N]` | Start CPU profiling (default sampling rate). |
| `stop --output <PATH>` | Stop profiling and write the pprof file. |

Useful for diagnosing wedged leaders or slow tool dispatch.

## Examples

```sh
# Who's running?
grok leader list

# Drill into one
PID=$(grok leader list --json | jq -r '.leaders[0].pid')
grok leader info --pid "$PID"

# Profile a slow leader for 30s
grok leader profile start --frequency-hz 100
sleep 30
grok leader profile stop --output /tmp/leader-30s.pprof
# open with: go tool pprof /tmp/leader-30s.pprof

# Kill everything if a leader gets wedged
grok leader kill
```
