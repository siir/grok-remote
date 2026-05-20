# `grok worktree`

Manage the git worktrees grok spins up when you pass `-w` or `--worktree` to a top-level `grok` invocation. Each worktree is an isolated checkout of the same repo, so a long agent session can edit / commit aggressively without polluting your main checkout. Grok keeps a small index of worktrees in a local SQLite db so it can clean up after itself.

Captured from `grok worktree --help` against grok 0.1.212.

## Shape

```
grok worktree <COMMAND>
```

## Subcommands

| Command | Purpose |
|---|---|
| `list` | List tracked worktrees. |
| `show` | Show details for a specific worktree. |
| `rm` | Remove worktrees. |
| `gc` | Garbage-collect orphaned / stale worktrees. |
| `db` | Database maintenance (rebuild / stats / path). |

## `grok worktree list`

```
grok worktree list [OPTIONS]
```

| Flag | Description |
|---|---|
| `--repo <REPO>` | Filter by source repo path. |
| `--type <TYPE>` | Filter by type (e.g. fork, scratch). |
| `--json` | Machine-readable output. |
| `--all` | Include worktrees grok has marked stale. |

## `grok worktree show`

```
grok worktree show <ID_OR_PATH>
```

| Arg | Description |
|---|---|
| `<ID_OR_PATH>` | Worktree id from `list`, or an absolute path. |

Reports source repo, branch, age, the session id that created it, and any uncommitted changes.

## `grok worktree rm`

```
grok worktree rm [OPTIONS] <IDS>...
```

| Flag | Description |
|---|---|
| `<IDS>...` | One or more worktree ids. |
| `-f, --force` | Remove even if there are uncommitted changes. |
| `--dry-run` | Show what would happen without doing anything. |

## `grok worktree gc`

```
grok worktree gc [OPTIONS]
```

| Flag | Description |
|---|---|
| `--dry-run` | Show what would be collected. |
| `--max-age <MAX_AGE>` | Override the age threshold (e.g. `7d`, `48h`). |
| `-f, --force` | Skip the confirmation prompt. |

## `grok worktree db`

```
grok worktree db <COMMAND>
```

Database maintenance for the local worktree index:

| Subcommand | Purpose |
|---|---|
| `rebuild` | Rebuild the index by scanning the filesystem. |
| `stats` | Print db stats (rows, last update, file size). |
| `path` | Print the db file path. |

## Examples

```sh
# What worktrees do I have around?
grok worktree list

# Drill into one
grok worktree show wt_01H...

# Manual cleanup
grok worktree rm wt_01H... -f

# Sweep anything older than 3 days
grok worktree gc --max-age 3d

# Find the index db so you can poke at it manually
sqlite3 "$(grok worktree db path)" ".tables"

# Recover after deleting worktrees outside grok's knowledge
grok worktree db rebuild
```

## Notes

- Each worktree lives next to your main checkout (or wherever git puts it; see `git worktree add` for the default).
- `grok worktree gc` is conservative: it won't remove a worktree with uncommitted changes unless `--force`.
- If you delete worktrees with `git worktree remove` or `rm -rf` directly, grok's index will be stale until the next `db rebuild` or `gc`.
