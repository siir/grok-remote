// import routes. Owned by its sub-agent. See docs/import.md.
//
// Wraps `grok import`. Two endpoints:
//
//   GET  /api/system/import   -> `grok import --list --json`
//   POST /api/system/import   -> `grok import --json [targets...]`
//
// Both return parsed NDJSON (an array of events) so the UI can render
// "imported / skipped" rows without re-parsing on the client.

import { send, readJsonBody } from '../helpers.js';
import { runGrokJson, errorToResponse } from '../../grok-cli.js';

export function register(add) {
  add('GET',  '/api/system/import', listHandler);
  add('POST', '/api/system/import', importHandler);
}

function toArray(json) {
  if (Array.isArray(json)) return json;
  if (json === null || json === undefined) return [];
  // Single object (or scalar) -> wrap so the UI always sees an array.
  return [json];
}

async function listHandler(req, res) {
  try {
    const json = await runGrokJson(['import', '--list', '--json']);
    send(res, 200, { ok: true, available: toArray(json) });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}

// Allowable target shapes: a session id (UUID-ish) OR an absolute or
// home-relative path to a .jsonl file. We're not the security boundary
// here (grok itself decides what to read) but we do drop anything that
// looks like a flag or an empty string so a caller can't sneak `--help`
// or similar into the argv.
function sanitizeTarget(t) {
  if (typeof t !== 'string') return null;
  const s = t.trim();
  if (!s) return null;
  if (s.startsWith('-')) return null;
  return s;
}

async function importHandler(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    send(res, 400, { ok: false, error: err?.message || 'invalid body' });
    return;
  }

  const rawTargets = Array.isArray(body?.targets) ? body.targets : [];
  const targets = rawTargets.map(sanitizeTarget).filter(Boolean);

  const argv = ['import', '--json', ...targets];

  try {
    // `runGrokJson` already handles NDJSON: it parses each line and
    // returns an array of events. Empty stdout -> null -> [].
    const json = await runGrokJson(argv, { timeoutMs: 60_000 });
    send(res, 200, { ok: true, events: toArray(json) });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}
