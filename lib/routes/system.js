// Dispatcher for /api/system/* routes. Each system page lives in its own
// file under lib/routes/system/<feature>.js and registers itself here.
//
// All handlers receive (req, res, urlObj) where urlObj is the parsed URL.
// Handlers MUST end the response themselves; the dispatcher never falls
// through.
//
// We register handlers by exact "<METHOD> /api/system/<path>" key. The
// path may include placeholder segments (we keep this routing flat by
// design; system endpoints are not deeply nested).

import * as mcpRoutes        from './system/mcp.js';
import * as leadersRoutes    from './system/leaders.js';
import * as worktreesRoutes  from './system/worktrees.js';
import * as memoryRoutes     from './system/memory.js';
import * as modelsRoutes     from './system/models.js';
import * as healthRoutes     from './system/health.js';
import * as sessionsRoutes   from './system/sessions.js';
import * as importRoutes     from './system/import.js';
import * as setupRoutes      from './system/setup.js';
import * as skillsRoutes     from './system/skills.js';
import * as agentsRoutes     from './system/agents.js';

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// Each module's `register(routes)` function adds its handlers to the
// global table below. We keep a tiny manual registry rather than reaching
// for an Express-style router so the dependency surface stays empty.
const ROUTES = new Map();
function add(method, path, handler) {
  ROUTES.set(`${method} ${path}`, handler);
}

const REGISTRARS = [
  mcpRoutes, leadersRoutes, worktreesRoutes, memoryRoutes,
  modelsRoutes, healthRoutes, sessionsRoutes, importRoutes,
  setupRoutes, skillsRoutes, agentsRoutes,
];
for (const mod of REGISTRARS) {
  if (mod && typeof mod.register === 'function') mod.register(add);
}

export async function handleSystem(req, res, url) {
  // Stripped of any query string by the caller. Match exactly first;
  // then try simple prefix matches (for parameterized paths like
  // /api/system/mcp/<name>/doctor).
  const method = req.method || 'GET';
  const exact = ROUTES.get(`${method} ${url}`);
  if (exact) {
    try {
      const urlObj = new URL(req.url, 'http://x');
      await exact(req, res, urlObj);
    } catch (err) {
      if (!res.headersSent) {
        send(res, 500, { ok: false, error: err?.message || String(err) });
      }
    }
    return true;
  }

  // Parameterized fallback: walk the registered patterns and try a
  // segment-by-segment match where `:name` placeholders accept anything.
  for (const [key, handler] of ROUTES) {
    const [m, pattern] = splitKey(key);
    if (m !== method) continue;
    const params = matchPattern(pattern, url);
    if (params) {
      try {
        const urlObj = new URL(req.url, 'http://x');
        urlObj.searchParams; // touch to keep node happy
        await handler(req, res, urlObj, params);
      } catch (err) {
        if (!res.headersSent) {
          send(res, 500, { ok: false, error: err?.message || String(err) });
        }
      }
      return true;
    }
  }

  // Nothing matched.
  send(res, 404, { ok: false, error: `unknown system route: ${method} ${url}` });
  return true;
}

function splitKey(k) {
  const i = k.indexOf(' ');
  return [k.slice(0, i), k.slice(i + 1)];
}

function matchPattern(pattern, url) {
  if (!pattern.includes(':')) return null;
  const p = pattern.split('/');
  const u = url.split('/');
  if (p.length !== u.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) {
      params[p[i].slice(1)] = decodeURIComponent(u[i]);
    } else if (p[i] !== u[i]) {
      return null;
    }
  }
  return params;
}
