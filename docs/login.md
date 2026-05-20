# `grok login`

Sign in to grok. Default is a browser-based flow; flags switch to OAuth via x.ai or device-code authentication for headless boxes.

Captured from `grok login --help` against grok 0.1.212.

## Shape

```
grok login [OPTIONS]
```

## Options

| Flag | Description |
|---|---|
| `--oauth` | Use Grok OAuth via `auth.x.ai`. |
| `--device-auth` | Use device-code auth. Prints a code + URL; useful when there is no browser on the box (SSH, headless CI). |
| `-h, --help` | Print help. |

## Examples

```sh
# Default browser-based login on a desktop
grok login

# OAuth via x.ai
grok login --oauth

# Headless / SSH: device code in a terminal you can see
grok login --device-auth
# Open the URL it prints on your phone, type the code.
```

## Notes

- Credentials are persisted in `~/.grok/auth.json` (locked while in use via `auth.json.lock`).
- To re-authenticate without losing other config, run `grok login` again or pass `--reauth` to `grok agent`.
- `XAI_API_KEY` env var is honored for headless runs and bypasses this flow.
