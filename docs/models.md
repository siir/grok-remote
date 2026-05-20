# `grok models`

Lists the models the CLI knows about and exits. Useful for picking a value for `-m, --model` or seeing what's defined in your `config.toml`.

Captured from `grok models --help` against grok 0.1.212.

## Shape

```
grok models
```

No options beyond `-h, --help`.

## Examples

```sh
# What can I pass to -m?
grok models

# Plug a model id directly into a one-shot
grok -p "summarize the readme" -m "$(grok models | head -2 | tail -1 | awk '{print $1}')"
```

## Notes

- The list reflects what's configured in your `~/.grok/config.toml` `[model.*]` sections plus what the active backend advertises. It is NOT a live query against the xAI API.
- `grok inspect` shows the *currently selected* model (`modelState.currentModelId`); `grok models` shows the *available* set.
- See [`grok.md`](./grok.md) for how `-m, --model` interacts with `--reasoning-effort` and `--effort`.
