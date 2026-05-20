# `grok update`

Check for grok updates, install a specific version, or flip between the stable and alpha channels.

Captured from `grok update --help` against grok 0.1.212.

## Shape

```
grok update [OPTIONS]
```

## Options

| Flag | Description |
|---|---|
| `--check` | Check for updates without installing. Pair with `--json` to script it. |
| `--json` | Machine-readable JSON output for `--check`. |
| `--force-reinstall` | Re-download and install even if you're already on the target version. |
| `--version <VERSION>` | Install a specific version, e.g. `0.1.150` or `0.1.151-alpha.2`. |
| `--alpha` | Switch the release channel to alpha (faster releases, may regress). |
| `--stable` | Switch the release channel to stable (default, weekly releases). |
| `-h, --help` | Print help. |

## Examples

```sh
# Just tell me if there's something new
grok update --check

# Same, scriptable
grok update --check --json | jq '.available'

# Latest in the current channel
grok update

# Pin to a known-good version
grok update --version 0.1.211

# Force a re-download (corrupt binary etc.)
grok update --force-reinstall

# Try alpha for a couple weeks
grok update --alpha
# ...regret it, flip back
grok update --stable
```

## Notes

- The update mechanism replaces `~/.grok/bin/grok` (or wherever your binary lives) atomically; running sessions are unaffected.
- A leader process (see [`leader.md`](./leader.md)) checks for updates periodically and self-restarts when idle if a new version is available; you can disable that with `--no-auto-update` when running `grok agent leader`.
- Channel preference is persisted; you don't need to pass `--alpha` / `--stable` on every run, only when switching.
