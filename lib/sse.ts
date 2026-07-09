// SSE helpers for the agent stream endpoint.

import type { ServerResponse } from 'node:http';

export interface SseEvent {
  id?: string | number | null;
  event?: string;
  data: unknown;
}

export interface SseRingEntry {
  id: string | number;
  [key: string]: unknown;
}

export function writeHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Disable Nagle on the underlying socket so each event ships immediately
  // instead of waiting for the ~200ms TCP coalescing window. EventSource
  // chunks are tiny so the bandwidth cost is negligible.
  try { res.socket && res.socket.setNoDelay(true); } catch { /* ignore */ }
  // Push headers to the client right away so EventSource transitions out of
  // CONNECTING as soon as the route handler accepts the request.
  try { if (typeof res.flushHeaders === 'function') res.flushHeaders(); } catch { /* ignore */ }
  res.write('retry: 5000\n\n');
}

export function writeEvent(res: ServerResponse, { id, event, data }: SseEvent): boolean {
  if (res.writableEnded || res.destroyed) return false;
  let chunk = '';
  if (id != null) chunk += `id: ${id}\n`;
  if (event) chunk += `event: ${event}\n`;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  // Support multi-line data per the SSE spec.
  for (const line of payload.split('\n')) chunk += `data: ${line}\n`;
  chunk += '\n';
  return res.write(chunk);
}

export function writePing(res: ServerResponse): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(': ping\n\n');
}

export interface SseRing<T extends SseRingEntry> {
  push(item: T): void;
  /**
   * Events after `lastId`. Empty lastId → empty (caller must not dump the
   * whole ring on a fresh chat open). Unknown lastId → empty too so a
   * rotated ring never re-applies 200 stale chunks on top of history.
   */
  since(lastId: string | number | null | undefined): T[];
  /** Full buffer (debug / tests). Prefer `since` for gap-fill. */
  all(): T[];
  size(): number;
  latestId(): string | number | null;
}

// Ring buffer to support Last-Event-ID / ?since= cursor gap-fill.
export function createRing<T extends SseRingEntry>(limit = 200): SseRing<T> {
  const buf: T[] = [];
  return {
    push(item: T): void {
      buf.push(item);
      if (buf.length > limit) buf.splice(0, buf.length - limit);
    },
    since(lastId: string | number | null | undefined): T[] {
      if (lastId == null || lastId === '') return [];
      const idx = buf.findIndex((e) => String(e.id) === String(lastId));
      if (idx < 0) return [];
      return buf.slice(idx + 1);
    },
    all(): T[] { return buf.slice(); },
    size(): number { return buf.length; },
    latestId(): string | number | null {
      if (!buf.length) return null;
      return buf[buf.length - 1]!.id;
    },
  };
}
