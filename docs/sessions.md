# `grok sessions`

List, search, or restore past sessions. Useful for finding a session id to pass to `grok --resume`, `grok share`, or `grok trace`.

Captured from `grok sessions --help` against grok 0.1.212.

## Shape

```
grok sessions <COMMAND>
```

## Subcommands

| Command | Purpose |
|---|---|
| `list` | List recent sessions (same as `search` with no query). |
| `search` | Search sessions by keyword. |

## `grok sessions list`

```
grok sessions list [-n <LIMIT>]
```

| Flag | Description |
|---|---|
| `-n, --limit <LIMIT>` | Max sessions to show. Default 20. |

Output: each row is `session-id  date  summary  cwd`.

## `grok sessions search`

```
grok sessions search [-n <LIMIT>] <QUERY>
```

| Arg | Description |
|---|---|
| `<QUERY>` | Phrase searched against summaries and first prompts. |
| `-n, --limit <LIMIT>` | Max results. Default 20. |

## Examples

```sh
# What did I do recently?
grok sessions list

# Show the last 5
grok sessions list -n 5

# Find sessions about a specific topic
grok sessions search "auth refactor"

# Pull the most recent matching session id straight into --resume
SID=$(grok sessions search "auth refactor" -n 1 | awk 'NR==2{print $1}')
grok --resume "$SID"
```

## Notes

- "First prompt" is whatever you typed (or piped) on turn 1; it powers the search index.
- The session id format is a UUIDv7 (time-sortable), so `list -n N` returns the N most recent.
- Sessions are stored under `~/.grok/sessions/<id>.jsonl`. See [`import.md`](./import.md) for getting sessions in/out and [`share.md`](./share.md) for publishing one.
