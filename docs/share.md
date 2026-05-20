# `grok share`

Publishes a session and prints a shareable URL. The receiver can view the conversation (prompts, tool calls, assistant messages) in a browser without needing the grok CLI.

Captured from `grok share --help` against grok 0.1.212.

## Shape

```
grok share <SESSION_ID>
```

## Arguments

| Arg | Description |
|---|---|
| `<SESSION_ID>` | The session to publish. Get it from `grok sessions list` or from the `--output-format json` response of any headless run. |

## Examples

```sh
# Publish the most recent session
SID=$(grok sessions list -n 1 | awk 'NR==2{print $1}')
grok share "$SID"
# -> prints https://grok.com/share/<token>

# Or in one line
grok share "$(grok sessions list -n 1 | awk 'NR==2{print $1}')"

# Pipe the URL into the clipboard on macOS
grok share "$SID" | pbcopy
```

## Notes

- The publish target is operated by xAI. Once published, the share URL is essentially permanent until you revoke it (revocation flow not exposed via the CLI yet).
- Sharing uploads the session content. If your session contains private code, tokens, or other secrets, **do not share it.**
- See [`trace.md`](./trace.md) for a local-first alternative that emits an archive instead of a public link.
