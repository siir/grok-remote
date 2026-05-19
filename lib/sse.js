// SSE helpers for the agent stream endpoint.

export function writeHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
}

export function writeEvent(res, { id, event, data }) {
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

export function writePing(res) {
  if (res.writableEnded || res.destroyed) return;
  res.write(': ping\n\n');
}

// Ring buffer to support Last-Event-ID replay.
export function createRing(limit = 200) {
  const buf = [];
  return {
    push(item) {
      buf.push(item);
      if (buf.length > limit) buf.splice(0, buf.length - limit);
    },
    since(lastId) {
      if (lastId == null || lastId === '') return buf.slice();
      const idx = buf.findIndex((e) => String(e.id) === String(lastId));
      if (idx < 0) return buf.slice();
      return buf.slice(idx + 1);
    },
    all() { return buf.slice(); },
    size() { return buf.length; },
  };
}
