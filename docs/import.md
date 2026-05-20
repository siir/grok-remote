# `grok import`

Imports sessions into grok's local store from `.jsonl` files or remote IDs. Useful when restoring from a backup, pulling sessions captured by another machine, or seeding a fresh install.

Captured from `grok import --help` against grok 0.1.212.

## Shape

```
grok import [OPTIONS] [TARGETS]...
```

`[TARGETS]...` is a list of session IDs or paths to `.jsonl` files. Omit the list to import every available session it can find.

## Options

| Flag | Description |
|---|---|
| `--list` | List available sessions without importing anything. |
| `--json` | NDJSON output to stdout (one event per line). |
| `-h, --help` | Print help. |

## Examples

```sh
# See what would be imported, do nothing
grok import --list

# Import everything available
grok import

# Import a specific session by id (or .jsonl path)
grok import 019e4056-7a38-7e72-9922-685b5b582549
grok import ~/backups/session-019e4056.jsonl

# Pipe JSON output into jq for scripting
grok import --json | jq -c 'select(.event=="imported")'
```

## Notes

- IDs are matched against grok's session storage; paths are read directly.
- Already-imported sessions are skipped (or reported as such with `--json`).
- See [`sessions.md`](./sessions.md) to list/search after import.
