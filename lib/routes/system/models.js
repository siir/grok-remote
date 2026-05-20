// Models routes. Wraps `grok models` (plain-text output) so the dashboard
// can list the model ids the CLI knows about. See docs/models.md.

import { send } from '../helpers.js';
import { runGrokText, errorToResponse } from '../../grok-cli.js';

export function register(add) {
  add('GET', '/api/system/models', getHandler);
}

// Best-effort parser. `grok models` has no `--json`, and the human format
// changes between versions, so we keep this forgiving: if nothing matches,
// items come back empty and the UI falls back to showing raw.
//
// Observed shapes:
//
//   (a) Table form
//       ID                                 NAME
//       grok-4-fast                        Grok 4 Fast
//
//   (b) Bullet form
//       Available models:
//         * grok-build (default)
//         * grok-4-fast      Grok 4 Fast
//
// Strategy: prefer bullet lines (`* id ...` or `- id ...`); fall back to
// the table form only if we see a header line that contains "ID".
function parseModels(raw) {
  const items = [];
  if (typeof raw !== 'string' || !raw.trim()) return items;

  const lines = raw.split('\n').map(l => l.replace(/\s+$/, ''));

  // Pass 1: bullet form.
  for (const line of lines) {
    const m = line.match(/^\s*[*\-]\s+(\S+)(.*)$/);
    if (!m) continue;
    const id = m[1];
    let name = (m[2] || '').trim();
    // Strip a trailing "(default)" marker so it doesn't look like the name.
    name = name.replace(/^\(default\)\s*/i, '').trim();
    if (!id) continue;
    items.push({ id, name });
  }
  if (items.length) return items;

  // Pass 2: header-led table form.
  let inTable = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!inTable) {
      const upper = line.toUpperCase();
      if (upper.includes('ID') && (upper.includes('NAME') || upper.includes('MODEL'))) {
        inTable = true;
      }
      continue;
    }
    const m = line.match(/^\s*(\S+)\s*(.*)$/);
    if (!m) continue;
    const id = m[1];
    const name = (m[2] || '').trim();
    if (!id) continue;
    items.push({ id, name });
  }

  return items;
}

async function getHandler(req, res) {
  try {
    const raw = await runGrokText(['models']);
    const items = parseModels(raw);
    send(res, 200, { ok: true, raw, items });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}
