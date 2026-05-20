// sessions routes. Owned by its sub-agent. See docs/sessions.md.
//
// Wraps `grok sessions list` and `grok sessions search`. Both subcommands
// print plain text (a header line followed by space-separated rows). We
// parse what we can and always include the raw output so the UI can fall
// back to it.

import { send } from '../helpers.js';
import { runGrokText, errorToResponse } from '../../grok-cli.js';

export function register(add) {
  add('GET', '/api/system/sessions', listHandler);
}

function clampLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 20;
  if (n > 200) return 200;
  return n;
}

// Try to parse the text table grok prints. Format observed against
// grok 0.1.212:
//
//   (no label)
//   SESSION ID                            CREATED     UPDATED     STATUS      SUMMARY
//   <uuid>  <date>  <date>  <status>  <summary text possibly with spaces>
//
// We locate the header row (starts with "SESSION ID") and split each
// subsequent row on 2-or-more spaces so a multi-word summary stays whole.
// Anything we can't parse we drop, but the raw text is always returned.
function parseSessions(raw) {
  const items = [];
  if (!raw || typeof raw !== 'string') return items;
  const lines = raw.split('\n');
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^SESSION\s+ID/i.test(lines[i])) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return items;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = line.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
    if (!cols.length) continue;
    // Be permissive: first column should look like a UUID-ish session id.
    const sessionId = cols[0];
    if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) continue;
    items.push({
      sessionId,
      created: cols[1] || '',
      updated: cols[2] || '',
      status:  cols[3] || '',
      summary: cols.slice(4).join(' ') || '',
    });
  }
  return items;
}

async function listHandler(req, res, urlObj) {
  const q     = (urlObj.searchParams.get('q') || '').trim();
  const limit = clampLimit(urlObj.searchParams.get('limit'));

  const args = q
    ? ['sessions', 'search', '-n', String(limit), q]
    : ['sessions', 'list',   '-n', String(limit)];

  try {
    const raw = await runGrokText(args);
    const items = parseSessions(raw);
    send(res, 200, { ok: true, raw, items });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}
