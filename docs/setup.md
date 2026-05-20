# `grok setup`

Fetches and installs managed deployment configuration. Designed for org-wide rollouts where IT pushes the same `config.toml`, `[mcp.*]` entries, agent profiles, and permission rules to every developer.

Captured from `grok setup --help` against grok 0.1.212.

## Shape

```
grok setup
```

No options beyond `-h, --help`.

## What it does

- Looks up the deployment configuration grok is bound to (configured server-side by xAI / your admin).
- Downloads the managed bundle (config + agent profiles + MCP servers + skill definitions).
- Merges it into your local config, preserving user-only fields.
- Re-runs auth if the deployment requires it.

If you are an individual user, `grok setup` typically does nothing (no managed deployment to fetch).

## Examples

```sh
# Pull the latest org deployment
grok setup

# Inspect what changed
grok inspect
```

## Notes

- Re-running is idempotent: the same managed bundle won't be reapplied.
- See [`update.md`](./update.md) for binary updates (different concept).
