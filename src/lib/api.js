// Small fetch wrapper for the REST endpoints described in PROTOCOL.md.
// No external deps. Throws on non-2xx with the parsed body if available.

async function request(method, path, body) {
  const opts = {
    method,
    headers: { accept: 'application/json' },
  };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  const txt = await r.text();
  let data = null;
  if (txt) {
    try { data = JSON.parse(txt); }
    catch { data = txt; }
  }
  if (!r.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.body = data;
    throw err;
  }
  return data;
}

export const api = {
  hello:    ()                => request('GET',    '/api/hello'),
  health:   ()                => request('GET',    '/api/health'),
  models:   ()                => request('GET',    '/api/models'),

  listAgents:   ()            => request('GET',    '/api/agents'),
  getAgent:     (id)          => request('GET',    `/api/agents/${encodeURIComponent(id)}`),
  createAgent:  (body)        => request('POST',   '/api/agents', body || {}),
  deleteAgent:  (id)          => request('DELETE', `/api/agents/${encodeURIComponent(id)}`),
  disconnect:   (id)          => request('POST',   `/api/agents/${encodeURIComponent(id)}/disconnect`),
  connect:      (id)          => request('POST',   `/api/agents/${encodeURIComponent(id)}/connect`),
  prompt:       (id, textOrOpts) => {
    // Backwards compat: a plain string still works.
    const body = (textOrOpts && typeof textOrOpts === 'object')
      ? {
          text: String(textOrOpts.text || ''),
          ...(Array.isArray(textOrOpts.attachments) && textOrOpts.attachments.length
            ? { attachments: textOrOpts.attachments }
            : {}),
        }
      : { text: String(textOrOpts || '') };
    return request('POST', `/api/agents/${encodeURIComponent(id)}/prompt`, body);
  },
  cancel:       (id)          => request('POST',   `/api/agents/${encodeURIComponent(id)}/cancel`),
  history:      async (id, opts) => {
    const { turns, all } = opts || {};
    const qs = new URLSearchParams();
    if (all) qs.set('all', '1');
    if (typeof turns === 'number' && turns > 0) qs.set('turns', String(turns));
    const url = `/api/agents/${encodeURIComponent(id)}/history${qs.toString() ? `?${qs}` : ''}`;
    const r = await fetch(url, { headers: { accept: 'application/x-ndjson' } });
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    const text = await r.text();
    const events = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { events.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
    }
    return {
      events,
      totalTurns:    parseInt(r.headers.get('X-Total-Turns')    || '0', 10) || 0,
      returnedTurns: parseInt(r.headers.get('X-Returned-Turns') || '0', 10) || 0,
    };
  },
  listFiles:    (id, path)    => request('GET',    `/api/agents/${encodeURIComponent(id)}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  readFile:     (id, path)    => request('GET',    `/api/agents/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`),
  fileRawUrl:   (id, p)       => `/api/agents/${encodeURIComponent(id)}/files/raw?path=${encodeURIComponent(p || '')}`,

  getSettings:  ()            => request('GET',    '/api/settings'),
  patchSettings:(body)        => request('PATCH',  '/api/settings', body),
};
