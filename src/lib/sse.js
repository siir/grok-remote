// EventSource wrapper.
//
// Notes:
// - The browser's EventSource already handles Last-Event-ID automatically on
//   reconnect: it sends the value of the last `id:` field it observed.
// - We surface lifecycle hooks (open / error / event), allow registering
//   handlers per event name, and expose a close() that stops the connection.
// - The server is expected to emit named events (sessionUpdate discriminator)
//   plus our own lifecycle ones: agent_status, prompt_complete, error.

const KNOWN_EVENTS = [
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'tool_call_delta_chunk',
  'available_commands_update',
  'session_summary_generated',
  'agent_status',
  'prompt_complete',
  'error',
  'session_notification',
];

export function openStream(url, { onOpen, onError, onAny, on } = {}) {
  let es = null;
  let closed = false;

  const handlers = Object.assign({}, on || {});

  const attach = (source) => {
    source.addEventListener('open', () => {
      if (typeof onOpen === 'function') onOpen();
    });
    source.addEventListener('error', (ev) => {
      if (typeof onError === 'function') onError(ev);
    });
    for (const name of KNOWN_EVENTS) {
      source.addEventListener(name, (ev) => {
        let parsed = ev.data;
        try { parsed = JSON.parse(ev.data); } catch {}
        if (typeof onAny === 'function') onAny(name, parsed, ev);
        if (typeof handlers[name] === 'function') handlers[name](parsed, ev);
      });
    }
    // Catch unnamed default messages (server might not name everything).
    source.addEventListener('message', (ev) => {
      let parsed = ev.data;
      try { parsed = JSON.parse(ev.data); } catch {}
      if (typeof onAny === 'function') onAny('message', parsed, ev);
      if (typeof handlers.message === 'function') handlers.message(parsed, ev);
    });
  };

  try {
    es = new EventSource(url);
    attach(es);
  } catch (err) {
    if (typeof onError === 'function') onError(err);
  }

  return {
    close() {
      closed = true;
      if (es) {
        try { es.close(); } catch {}
        es = null;
      }
    },
    isClosed() { return closed; },
    readyState() { return es ? es.readyState : 2; },
  };
}
