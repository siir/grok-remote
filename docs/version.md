# `grok version`

Prints version information. Alias of `grok v`. Same data is available with the top-level `grok -v` / `grok --version`, but the subcommand form supports `--json` for scripting.

Captured from `grok version --help` against grok 0.1.212.

## Shape

```
grok version [OPTIONS]
```

## Options

| Flag | Description |
|---|---|
| `--json` | Machine-readable JSON output. |
| `-h, --help` | Print help. |

## Examples

```sh
# Human-readable
grok version

# Script-friendly
grok version --json | jq -r '.version'

# Equivalent short forms
grok v
grok -v
grok --version
```

## Output

The plain form looks like `grok 0.1.212 (b7b8204a484)` (semver + git short hash). The JSON form includes that plus a build timestamp, channel (stable / alpha), and binary path.
