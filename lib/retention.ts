// Periodic cleanup of stale agent directories under ~/.grok-remote/agents/.
//
// Triggered by settings.retentionDays (0 disables). Honors starred + archived
// flags (never auto-prune those). Skips agents currently connected.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const AGENTS_ROOT = path.join(os.homedir(), '.grok-remote', 'agents');

export interface AgentMeta {
  starred?: boolean;
  archived?: boolean;
  lastSeen?: string;
  updatedAt?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface AgentLiveRecord {
  id: string;
  status?: string;
  [key: string]: unknown;
}

export interface AgentManagerLike {
  list(): AgentLiveRecord[];
  kill(id: string): Promise<unknown> | unknown;
}

export interface SweepInputs {
  days?: number;
  manager?: AgentManagerLike | null;
  now?: number;
  /** Override agents root (tests). */
  agentsRoot?: string;
}

export interface SweepResult {
  scanned: number;
  removed: number;
  skipped: number;
}

export interface RetentionTimerInputs {
  getSettings?: () => { retentionDays?: number } | null | undefined;
  manager?: AgentManagerLike | null;
  intervalMs?: number;
}

export interface RetentionTimer {
  stop(): void;
  tick(): void;
}

function readMeta(root: string, id: string): AgentMeta | null {
  try {
    const raw = fs.readFileSync(path.join(root, id, 'meta.json'), 'utf8');
    return JSON.parse(raw) as AgentMeta;
  } catch { return null; }
}

function dirMtimeMs(root: string, id: string): number {
  try { return fs.statSync(path.join(root, id)).mtimeMs; }
  catch { return 0; }
}

/** Prefer history.jsonl mtime (real activity) over stale meta.lastSeen. */
function activityMs(root: string, id: string, meta: AgentMeta): number {
  let histMs = 0;
  try { histMs = fs.statSync(path.join(root, id, 'history.jsonl')).mtimeMs; }
  catch { /* no history yet */ }
  const t = Date.parse(meta.lastSeen || meta.updatedAt || meta.createdAt || '');
  const metaMs = Number.isFinite(t) ? t : 0;
  const dirMs = dirMtimeMs(root, id);
  return Math.max(histMs, metaMs, dirMs);
}

/**
 * Synchronous sweep. When `manager` is provided, kill is fire-and-forget
 * for backward compatibility — prefer `sweepOnceAsync` in the timer path.
 */
export function sweepOnce(
  { days, manager, now = Date.now(), agentsRoot = AGENTS_ROOT }: SweepInputs = {},
): SweepResult {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return { scanned: 0, removed: 0, skipped: 0 };
  const cutoffMs = now - n * 24 * 60 * 60 * 1000;

  let entries: string[];
  try { entries = fs.readdirSync(agentsRoot); }
  catch { return { scanned: 0, removed: 0, skipped: 0 }; }

  let scanned = 0, removed = 0, skipped = 0;
  const active = manager
    ? new Map<string, AgentLiveRecord>(manager.list().map((r) => [r.id, r]))
    : new Map<string, AgentLiveRecord>();

  for (const id of entries) {
    const metaPath = path.join(agentsRoot, id, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    scanned++;
    const meta = readMeta(agentsRoot, id) || {};
    if (meta.starred || meta.archived) { skipped++; continue; }
    const live = active.get(id);
    if (live && live.status && live.status !== 'disconnected' && live.status !== 'errored') {
      skipped++;
      continue;
    }
    const lastMs = activityMs(agentsRoot, id, meta);
    if (lastMs >= cutoffMs) { skipped++; continue; }

    try {
      if (manager) {
        // Sync API cannot await; timer path should use sweepOnceAsync.
        Promise.resolve(manager.kill(id)).catch(() => { /* ignore */ });
        removed++;
      } else {
        const dir = path.join(agentsRoot, id);
        if (dir.startsWith(agentsRoot + path.sep) || dir === agentsRoot) {
          fs.rmSync(dir, { recursive: true, force: true });
          removed++;
        } else {
          skipped++;
        }
      }
    } catch {
      skipped++;
    }
  }
  return { scanned, removed, skipped };
}

/** Await each kill and only count successful removals. */
export async function sweepOnceAsync(
  { days, manager, now = Date.now(), agentsRoot = AGENTS_ROOT }: SweepInputs = {},
): Promise<SweepResult> {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return { scanned: 0, removed: 0, skipped: 0 };
  const cutoffMs = now - n * 24 * 60 * 60 * 1000;

  let entries: string[];
  try { entries = fs.readdirSync(agentsRoot); }
  catch { return { scanned: 0, removed: 0, skipped: 0 }; }

  let scanned = 0, removed = 0, skipped = 0;
  const active = manager
    ? new Map<string, AgentLiveRecord>(manager.list().map((r) => [r.id, r]))
    : new Map<string, AgentLiveRecord>();

  for (const id of entries) {
    const metaPath = path.join(agentsRoot, id, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    scanned++;
    const meta = readMeta(agentsRoot, id) || {};
    if (meta.starred || meta.archived) { skipped++; continue; }
    const live = active.get(id);
    if (live && live.status && live.status !== 'disconnected' && live.status !== 'errored') {
      skipped++;
      continue;
    }
    const lastMs = activityMs(agentsRoot, id, meta);
    if (lastMs >= cutoffMs) { skipped++; continue; }

    try {
      if (manager) {
        await Promise.resolve(manager.kill(id));
        // kill should have removed the dir; if not, force-remove.
        const dir = path.join(agentsRoot, id);
        if (fs.existsSync(dir) && (dir.startsWith(agentsRoot + path.sep) || dir === agentsRoot)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        removed++;
      } else {
        const dir = path.join(agentsRoot, id);
        if (dir.startsWith(agentsRoot + path.sep) || dir === agentsRoot) {
          fs.rmSync(dir, { recursive: true, force: true });
          removed++;
        } else {
          skipped++;
        }
      }
    } catch {
      skipped++;
    }
  }
  return { scanned, removed, skipped };
}

// Start a daily sweep timer. Returns a stop() handle.
export function startRetentionTimer(
  { getSettings, manager, intervalMs = 24 * 60 * 60 * 1000 }: RetentionTimerInputs = {},
): RetentionTimer {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        const s = typeof getSettings === 'function' ? getSettings() : null;
        const days = Number(s && s.retentionDays);
        if (Number.isFinite(days) && days > 0) {
          const r = await sweepOnceAsync({ days, manager });
          if (r.removed > 0) {
            process.stderr.write(`[retention] swept: removed=${r.removed} scanned=${r.scanned} skipped=${r.skipped}\n`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[retention] sweep failed: ${msg}\n`);
      } finally {
        running = false;
      }
    })();
  };
  const initial = setTimeout(tick, 30_000);
  const handle = setInterval(tick, intervalMs);
  return {
    stop(): void { clearTimeout(initial); clearInterval(handle); },
    tick,
  };
}
