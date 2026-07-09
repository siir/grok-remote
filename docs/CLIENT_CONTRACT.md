# Client contract (frozen)

**Product role:** grok-remote is a **multi-agent control plane** on a machine.  
First-class clients: **dashboard (phone/desktop)** and **agent-fleet** (`LAUNCH_MODE=remote`).

Changes that break this contract require coordination with **agent-fleet** (bus: fleetdev / agent-watch).

---

## Environment

| Variable | Default | Client |
|----------|---------|--------|
| `GROK_REMOTE_URL` | `http://localhost:7910` | agent-fleet |
| `GROK_REMOTE_TIMEOUT` | `30` (seconds) | agent-fleet |
| `GROK_REMOTE_TOKEN` | unset | optional shared secret (see Auth) |

---

## Frozen HTTP API (agent-fleet)

Used by `estate/agent-watch/watch-engine.sh` when `LAUNCH_MODE=remote`:

| Method | Path | Request | Success |
|--------|------|---------|---------|
| `GET` | `/api/health` | — | `200` (body optional; fleet only checks success) |
| `GET` | `/api/agents/:id` | — | `200` JSON including at least `id`, `inFlight` (number) |
| `POST` | `/api/agents` | JSON `{ name, cwd, model?, settings: { alwaysApprove: true } }` | `201` JSON with **`id`** string |
| `POST` | `/api/agents/:id/prompt` | JSON `{ text: string }` | `202` (fleet ignores body) |

### Create body (fleet)

```json
{
  "name": "review-pr-123",
  "cwd": "/absolute/path/to/repo",
  "model": "optional-model-id",
  "settings": { "alwaysApprove": true }
}
```

- `cwd` must exist and be a directory under the host jail (default: `$HOME`).
- Fleet runs on the **same machine** via loopback by default → **no token required**.

### Auth rules (Wave C)

| Caller | Rule |
|--------|------|
| **Loopback** (`127.0.0.1`, `::1`) | Always allowed (agent-fleet, local tools) |
| **Non-loopback** (tailnet / LAN) | If `GROK_REMOTE_TOKEN` is set, require `Authorization: Bearer <token>` **or** `X-Grok-Remote-Token: <token>` |
| Token unset | Non-loopback still allowed (legacy); server logs a startup warning |

Phone / PWA over Tailscale: set the same token in env and in the browser (settings / future UI) when you enable it.

---

## Non-goals for this contract

- Attach to an interactive Grok Build TUI session  
- Breaking renames of the routes above without a fleet PR  
- Requiring auth on localhost for fleet

---

## Compatibility tests

Prefer a small smoke (manual or CI) against a running host:

```sh
curl -sf "$GROK_REMOTE_URL/api/health"
curl -sf -X POST "$GROK_REMOTE_URL/api/agents" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"contract-smoke\",\"cwd\":\"$HOME\",\"settings\":{\"alwaysApprove\":true}}"
```
