# grok CLI reference

Per-command docs for the `grok` binary, captured against:

```
grok 0.1.212 (b7b8204a484)
```

These are organized by top-level subcommand. Each page mirrors the `--help` output plus context and examples that the bare help text leaves out.

## Top-level

- [grok.md](./grok.md) - the root command (TUI + every flag inherited by subcommands)

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

## Refreshing the docs

When `grok` rev-bumps, the help text may change. Quick refresh loop:

```sh
# Pull help for every command into /tmp for review
for sub in agent import inspect leader login mcp memory models sessions setup share ssh trace update version worktree; do
  grok "$sub" --help > /tmp/grok-help/$sub.txt 2>&1
done
diff /tmp/grok-help/agent.txt <(cd /Users/dan/grok-remote/docs && grep -A0 'grok agent' agent.md)
```

Then update the corresponding `<command>.md` with the deltas. The version pinned at the top of `grok.md` should bump too.

## Notes

- Some commands have nested subcommands (e.g. `grok leader profile`, `grok worktree db`). Their pages document each layer inline.
- ACP (Agent Client Protocol) wire details are in [../PROTOCOL.md](../PROTOCOL.md), not here. This folder is just about the CLI surface.
