// Periodic cleanup of stale agent directories under ~/.grok-remote/agents/.
//
// Triggered by settings.retentionDays (0 disables). Honors starred + archived
// flags (never auto-prune a starred agent). Skips agents currently connected.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const AGENTS_ROOT = path.join(os.homedir(), '.grok-remote', 'agents');

function readMeta(id) {
  try {
    const raw = fs.readFileSync(path.join(AGENTS_ROOT, id, 'meta.json'), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

function dirMtimeMs(id) {
  try { return fs.statSync(path.join(AGENTS_ROOT, id)).mtimeMs; }
  catch { return 0; }
}

export function sweepOnce({ days, manager, now = Date.now() } = {}) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return { scanned: 0, removed: 0, skipped: 0 };
  const cutoffMs = now - n * 24 * 60 * 60 * 1000;

  let entries;
  try { entries = fs.readdirSync(AGENTS_ROOT); }
  catch { return { scanned: 0, removed: 0, skipped: 0 }; }

  let scanned = 0, removed = 0, skipped = 0;
  const active = manager ? new Map(manager.list().map(r => [r.id, r])) : new Map();

  for (const id of entries) {
    const metaPath = path.join(AGENTS_ROOT, id, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    scanned++;
    const meta = readMeta(id) || {};
    if (meta.starred) { skipped++; continue; }
    const live = active.get(id);
    if (live && live.status && live.status !== 'disconnected') { skipped++; continue; }
    const t = Date.parse(meta.lastSeen || meta.updatedAt || meta.createdAt || '');
    const lastMs = Number.isFinite(t) ? t : dirMtimeMs(id);
    if (lastMs >= cutoffMs) { skipped++; continue; }

    try {
      if (manager) {
        manager.kill(id).catch(() => {});
      } else {
        const dir = path.join(AGENTS_ROOT, id);
        if (dir.startsWith(AGENTS_ROOT + path.sep)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      removed++;
    } catch {
      skipped++;
    }
  }
  return { scanned, removed, skipped };
}

// Start a daily sweep timer. Returns a stop() handle.
export function startRetentionTimer({ getSettings, manager, intervalMs = 24 * 60 * 60 * 1000 } = {}) {
  const tick = () => {
    try {
      const s = typeof getSettings === 'function' ? getSettings() : {};
      const days = Number(s && s.retentionDays);
      if (Number.isFinite(days) && days > 0) {
        const r = sweepOnce({ days, manager });
        if (r.removed > 0) {
          process.stderr.write(`[retention] swept: removed=${r.removed} scanned=${r.scanned} skipped=${r.skipped}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[retention] sweep failed: ${err && err.message}\n`);
    }
  };
  // Run once at startup (after a 30s delay so the server is settled), then daily.
  const initial = setTimeout(tick, 30_000);
  const handle = setInterval(tick, intervalMs);
  return {
    stop() { clearTimeout(initial); clearInterval(handle); },
    tick,
  };
}
