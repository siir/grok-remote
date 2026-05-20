# `grok trace`

Export or upload session trace data. Trace data is the full record of a session (prompts, tool calls + their inputs/outputs, model events, timing). Useful for debugging, reproducing issues, or attaching to a bug report.

Captured from `grok trace --help` against grok 0.1.212.

## Shape

```
grok trace [OPTIONS] <SESSION_ID>
```

## Arguments

| Arg | Description |
|---|---|
| `<SESSION_ID>` | Session to trace. |

## Options

| Flag | Description |
|---|---|
| `--local` | Save locally only; skip the remote upload. |
| `-o, --output <PATH>` | Output archive path. Default: `~/.grok/trace-exports/<session-id>.tar.gz`. |
| `--json` | Machine-readable JSON output. |
| `-h, --help` | Print help. |

## Examples

```sh
# Default: tar.gz under ~/.grok/trace-exports + upload to xAI for support
grok trace 019e4056-7a38-7e72-9922-685b5b582549

# Local only, custom path (no upload)
grok trace 019e4056 --local -o /tmp/issue-1234.tar.gz

# Pipe JSON output for further processing
grok trace 019e4056 --json | jq '.archive_path'
```

## Trace vs share vs export

| Command | Output | Visibility |
|---|---|---|
| `grok trace --local` | `tar.gz` on your disk | private |
| `grok trace` (default) | `tar.gz` + upload to xAI | shared with xAI for support |
| `grok share` | hosted web page on grok.com | public (anyone with the URL) |
| `grok sessions list` / `import` | jsonl on your disk | private |

## Notes

- Use `--local` if the session has secrets you do not want on xAI's servers.
- The remote-upload path is intended for support cases; the upload returns a reference id you can attach to a ticket.
- Trace archives contain the full conversation including tool outputs. If you ran shell commands that printed credentials, those appear in the trace verbatim. Inspect before sharing.
