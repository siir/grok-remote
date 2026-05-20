# `grok mcp`

Manage MCP (Model Context Protocol) server configurations. MCP servers extend grok with extra tools (filesystem, search engines, internal APIs) by registering a stdio process or an HTTP/SSE endpoint that grok can call.

Captured from `grok mcp --help` against grok 0.1.212.

## Shape

```
grok mcp <COMMAND>
```

## Subcommands

| Command | Purpose |
|---|---|
| `list` | List configured MCP servers. |
| `add` | Add or update an MCP server. |
| `remove` | Remove an MCP server by name. |
| `doctor` | Diagnose connectivity / configuration for one or all servers. |

## `grok mcp list`

```
grok mcp list [--json]
```

Shows each server's name, transport (stdio / http / sse), command-or-url, and configured args/env.

## `grok mcp add`

```
grok mcp add [OPTIONS] <NAME>
```

| Flag | Description |
|---|---|
| `<NAME>` | Server name; becomes the key under `[mcp.<name>]` in `config.toml`. |
| `--command <COMMAND>` | Executable for stdio transport. |
| `--args <ARGS>...` | Arguments passed to the command. |
| `--env <KEY=VALUE>...` | Environment variables passed to the command. |
| `--url <URL>` | URL for HTTP / SSE transport. |
| `--type <TRANSPORT_TYPE>` | Transport type for HTTP servers (e.g. `sse`). |

Either `--command` (stdio) or `--url` (network) is required. Re-running `add` with the same name updates the config in place.

### Examples

```sh
# A local stdio server, e.g. the official filesystem MCP
grok mcp add fs \
  --command "uvx" \
  --args "mcp-server-filesystem" "/Users/dan/workspace"

# Environment vars passed through
grok mcp add gh \
  --command "npx" --args "-y" "@modelcontextprotocol/server-github" \
  --env "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_..."

# An HTTP-streamed server
grok mcp add my-team \
  --url "https://mcp.internal.example.com/v1" --type http

# A Server-Sent-Events server
grok mcp add events \
  --url "https://events.example.com/mcp" --type sse
```

## `grok mcp remove`

```
grok mcp remove <NAME>
```

Drops the server's entry from `config.toml`.

## `grok mcp doctor`

```
grok mcp doctor [NAME] [--json]
```

| Flag | Description |
|---|---|
| `[NAME]` | If supplied, check only this server. Otherwise check all configured servers. |
| `--json` | Machine-readable output. |

For each server, attempts the configured transport, lists discovered tools, and reports errors (auth failure, bad command, transport mismatch). Run this first when an MCP server doesn't show up in a session.

## Notes

- Per-server config ends up in your `config.toml` under `[mcp.<name>]`. You can also edit that file directly; `grok mcp list` is just a pretty view of it.
- Stdio servers run as child processes of the leader / agent. They inherit the working directory you launched grok from unless your tool defines otherwise.
- `grok inspect` shows which MCP servers are *currently active* in a session, separate from what's *configured*.
