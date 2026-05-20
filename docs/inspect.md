# `grok inspect`

Prints the configuration grok would use if you ran it in the current directory. Resolves every config layer (workspace `config.toml`, user config, env vars, defaults) and tells you what's actually active, what's overridden, and where each value comes from. The first thing to run when grok "doesn't pick up my setting".

Captured from `grok inspect --help` against grok 0.1.212.

## Shape

```
grok inspect [OPTIONS]
```

## Options

| Flag | Description |
|---|---|
| `--json` | Emit machine-readable JSON instead of the human-readable table. |
| `-h, --help` | Print help. |

## Examples

```sh
# What model, what tools, what permission rules apply right here?
grok inspect

# Pipe into jq to extract one value
grok inspect --json | jq -r '.model.currentModelId'

# Diff between two directories
diff <(cd ~/proj-a && grok inspect --json) <(cd ~/proj-b && grok inspect --json)
```

## What you'll see

The non-JSON form is grouped: `model`, `tools`, `permissions`, `agent`, `memory`, `mcp servers`, `subagents`, plus the resolved `workspace`, `home`, and any active overrides. Each line is annotated with the source layer (default / workspace / env / cli flag).
