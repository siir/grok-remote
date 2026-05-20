# `grok memory`

Manage grok's cross-session memory. Memory is the persistent `MEMORY.md` files plus the per-session and global indices grok uses to remember context across runs. There is workspace memory (per-project) and global memory (per-user).

Captured from `grok memory --help` against grok 0.1.212.

## Shape

```
grok memory <COMMAND>
```

## Subcommands

| Command | Purpose |
|---|---|
| `clear` | Wipe memory files. Workspace by default. |

(More subcommands may land in newer grok releases; re-run `grok memory --help` to see.)

## `grok memory clear`

```
grok memory clear [OPTIONS]
```

| Flag | Description |
|---|---|
| `--workspace` | Clear workspace-scoped memory: `MEMORY.md`, `sessions/`, and `index.sqlite` for the current working directory. |
| `--global` | Clear the global `MEMORY.md`. |
| `--all` | Clear both workspace and global memory. |
| `-y, --yes` | Skip the confirmation prompt. Required for unattended scripts. |
| `-h, --help` | Print help. |

Default scope (no flag) is `--workspace`.

## Examples

```sh
# Reset memory for THIS project (with a confirmation prompt)
grok memory clear

# Reset global memory across all projects
grok memory clear --global -y

# Nuclear option: forget everything
grok memory clear --all -y
```

## Where memory lives

- **Workspace memory**: `<your-project>/.grok/MEMORY.md` plus `<your-project>/.grok/sessions/` and `<your-project>/.grok/index.sqlite`.
- **Global memory**: `~/.grok/memory/MEMORY.md` and friends.

`grok inspect` shows which memory files are active for the current invocation. Memory is also gated by the top-level `--no-memory` flag (disable) and `--experimental-memory` flag (force-enable for runs that don't pick it up by default).
