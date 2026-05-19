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
  history:      (id)          => request('GET',    `/api/agents/${encodeURIComponent(id)}/history`),
  listFiles:    (id, path)    => request('GET',    `/api/agents/${encodeURIComponent(id)}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  readFile:     (id, path)    => request('GET',    `/api/agents/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`),
  fileRawUrl:   (id, p)       => `/api/agents/${encodeURIComponent(id)}/files/raw?path=${encodeURIComponent(p || '')}`,

  getSettings:  ()            => request('GET',    '/api/settings'),
  patchSettings:(body)        => request('PATCH',  '/api/settings', body),
};
