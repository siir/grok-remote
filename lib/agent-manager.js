// Registry of live AcpClient instances + per-agent SSE ring buffers and history.
//
// Persistence model:
//   ~/.grok-remote/agents/<id>/meta.json     - hydrated on startup
//   ~/.grok-remote/agents/<id>/history.jsonl - append-only event log
//   ~/.grok-remote/agents/<id>/cwd/...       - agent's working directory
//
// Lifecycle states:
//   starting   - process spawned, handshake in flight
//   idle       - connected, ready for prompts
//   running    - prompt in flight
//   disconnected - process killed, but record (history + meta) kept
//   errored    - failed handshake or fatal error
//
// Disconnecting an agent kills its grok process but keeps everything on disk.
// Sending a new prompt to a disconnected agent transparently respawns and
// attempts to resume the grok session via session/load.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { AcpClient } from './acp-client.js';
import { ensureAgentDirs, agentDir, append as historyAppend } from './history.js';
import { createRing } from './sse.js';

const SSE_RING_LIMIT = 200;
const AGENTS_ROOT = path.join(os.homedir(), '.grok-remote', 'agents');

function nowIso() { return new Date().toISOString(); }

function metaPath(id) {
  return path.join(agentDir(id), 'meta.json');
}

function readMetaFromDisk(id) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch { return null; }
}

function writeMeta(record) {
  try {
    fs.mkdirSync(agentDir(record.id), { recursive: true });
    const out = {
      id: record.id,
      name: record.name,
      autoNamed: !!record.autoNamed,
      modelHint: record.modelHint || null,
      cwd: record.cwd,
      createdAt: record.createdAt,
      lastSeen: record.lastSeen,
      lastSessionId: record.lastSessionId || null,
      lastError: record.lastError || null,
      starred: !!record.starred,
      archived: !!record.archived,
      archivedAt: record.archivedAt || null,
      settings: record.settings && typeof record.settings === 'object' ? record.settings : null,
    };
    fs.writeFileSync(metaPath(record.id), JSON.stringify(out, null, 2));
  } catch (err) {
    process.stderr.write(`[meta] write failed for ${record.id}: ${err.message}\n`);
  }
}

function listPersistedAgentIds() {
  try {
    return fs.readdirSync(AGENTS_ROOT).filter(name => {
      try {
        return fs.statSync(path.join(AGENTS_ROOT, name)).isDirectory()
            && fs.existsSync(path.join(AGENTS_ROOT, name, 'meta.json'));
      } catch { return false; }
    });
  } catch { return []; }
}

const MIME_EXT = {
  'image/png':  '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif':  '.gif',
  'image/svg+xml': '.svg',
};

function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 100);
}

function uniqueUploadName(dir, requestedName, mimeType) {
  let raw = sanitizeFilename(requestedName);
  if (!raw) {
    const ext = MIME_EXT[mimeType] || '';
    raw = `image-${Date.now()}${ext}`;
  }
  let candidate = raw;
  const ext = path.extname(raw);
  const stem = ext ? raw.slice(0, -ext.length) : raw;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${i++}${ext}`;
  }
  return candidate;
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '? bytes';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentLine(f) {
  // Keep the per-file line minimal and NEUTRAL.
  // Older versions appended hints like "your text-based Read tool cannot view
  // it" for images. That instruction was being parroted back by the model
  // even when the same prompt also carried an inline image block, causing
  // the agent to say "I can't view images" while sitting on a perfectly
  // valid image. The image content block (and the resource_link) already
  // tell the agent what to do; the text just identifies the file.
  const size = humanSize(f.size);
  return `- ${f.abs} (${f.mimeType || 'application/octet-stream'}, ${size})`;
}

export class AgentManager extends EventEmitter {
  constructor() {
    super();
    this.agents = new Map();
    this._hydrateFromDisk();
  }

  _hydrateFromDisk() {
    for (const id of listPersistedAgentIds()) {
      const meta = readMetaFromDisk(id);
      if (!meta || !meta.id) continue;
      const ring = createRing(SSE_RING_LIMIT);
      const record = {
        id: meta.id,
        name: meta.name || `agent-${meta.id.slice(0, 8)}`,
        autoNamed: !!meta.autoNamed,
        modelHint: meta.modelHint || null,
        cwd: meta.cwd || path.join(agentDir(meta.id), 'cwd'),
        createdAt: meta.createdAt || nowIso(),
        lastSeen: meta.lastSeen || nowIso(),
        lastSessionId: meta.lastSessionId || null,
        lastError: meta.lastError || null,
        starred: !!meta.starred,
        archived: !!meta.archived,
        archivedAt: meta.archivedAt || null,
        settings: meta.settings && typeof meta.settings === 'object' ? meta.settings : null,
        client: null,
        ring,
        status: 'disconnected',
        eventCounter: 0,
      };
      this.agents.set(record.id, record);
    }
  }

  list() {
    return [...this.agents.values()].map((a) => this._publicRecord(a));
  }

  get(id) {
    const a = this.agents.get(id);
    return a ? this._publicRecord(a) : null;
  }

  _publicRecord(a) {
    return {
      id: a.id,
      name: a.name,
      model: a.client?.modelId || a.modelHint || null,
      status: a.client?.status || a.status || 'disconnected',
      connected: !!a.client,
      cwd: a.cwd,
      createdAt: a.createdAt,
      lastSeen: a.lastSeen,
      lastSessionId: a.client?.sessionId || a.lastSessionId || null,
      handshakeMeta: a.client?.handshake?._meta || null,
      agentCapabilities: a.client?.handshake?.agentCapabilities || null,
      sessionId: a.client?.sessionId || a.lastSessionId || null,
      availableCommands: a.client?.availableCommands || [],
      lastError: a.client?.lastError || a.lastError || null,
      exitInfo: a.client?.exitInfo || null,
      starred:    !!a.starred,
      archived:   !!a.archived,
      archivedAt: a.archivedAt || null,
      settings:   a.settings && typeof a.settings === 'object' ? a.settings : null,
    };
  }

  async update(id, patch) {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    if (!patch || typeof patch !== 'object') throw new Error('invalid patch');
    let changed = false;
    if (typeof patch.name === 'string' && patch.name.trim()) {
      a.name = patch.name.trim().slice(0, 200);
      a.autoNamed = false;
      changed = true;
    }
    if (typeof patch.starred === 'boolean' && a.starred !== patch.starred) {
      a.starred = patch.starred;
      changed = true;
    }
    if (typeof patch.archived === 'boolean' && a.archived !== patch.archived) {
      a.archived = patch.archived;
      a.archivedAt = patch.archived ? nowIso() : null;
      changed = true;
      // Archiving a live agent disconnects it so resources free up. Restoring
      // does NOT auto-connect: the user can hit "connect" or just send a
      // message to wake it up.
      if (patch.archived && a.client) {
        try { await a.client.shutdown('SIGTERM'); } catch { /* ignore */ }
        a.client = null;
        a.status = 'disconnected';
      }
    }
    // settings: a flat object of grok top-level overrides. Pass `null` to clear.
    // We do a shallow merge so partial updates ("just change reasoningEffort")
    // don't clobber the rest.
    if (patch.settings === null) {
      if (a.settings != null) {
        a.settings = null;
        changed = true;
      }
    } else if (patch.settings && typeof patch.settings === 'object') {
      const next = { ...(a.settings || {}), ...patch.settings };
      // Strip null/undefined/empty-string values so the settings object stays
      // tidy (and so _buildArgv treats "cleared" fields as absent).
      for (const k of Object.keys(next)) {
        const v = next[k];
        if (v == null) { delete next[k]; continue; }
        if (typeof v === 'string' && v.length === 0) { delete next[k]; continue; }
        if (Array.isArray(v) && v.length === 0) { delete next[k]; continue; }
      }
      a.settings = Object.keys(next).length ? next : null;
      changed = true;
    }
    if (changed) {
      writeMeta(a);
      // Surface the change to any open SSE listeners so the UI can react.
      const emitEvent = this._emitEventFactory(a);
      emitEvent('agent_updated', {
        id: a.id,
        name: a.name,
        starred: !!a.starred,
        archived: !!a.archived,
      });
      this.emit('list_changed', { event: 'agent_updated', agent: this._publicRecord(a) });
    }
    return this._publicRecord(a);
  }

  _emitEventFactory(record) {
    return (event, data) => {
      record.eventCounter = (record.eventCounter || 0) + 1;
      const eventId = `${Date.now()}-${record.eventCounter}`;
      const wrapped = { id: eventId, event, data: { ...data, _t: Date.now() } };
      record.ring.push(wrapped);
      record.lastSeen = nowIso();
      // Fan out to subscribers first so SSE writes hit the wire before we
      // touch disk. setImmediate preserves emit order on a single fs queue.
      this.emit(`agent:${record.id}`, wrapped);
      const at = record.lastSeen;
      setImmediate(() => historyAppend(record.id, { eventId, at, event, data }));
    };
  }

  _wireClient(record) {
    const id = record.id;
    const emitEvent = this._emitEventFactory(record);
    const client = record.client;

    client.on('status', (s) => {
      emitEvent('agent_status', s);
      // Also surface on the global list_changed channel so consumers tracking
      // the whole agent set (sidebar, global flow) can update their pills
      // without subscribing to every per-agent stream.
      this.emit('list_changed', {
        event: 'agent_status',
        id: record.id,
        status: (s && s.status) || record.status,
      });
    });
    client.on('handshake', (h) => {
      emitEvent('handshake', { meta: h?._meta || null, agentCapabilities: h?.agentCapabilities || null });
    });
    client.on('session_ready', (s) => {
      // Stash sessionId on the record so subsequent reconnects can session/load.
      if (s && s.sessionId) {
        record.lastSessionId = s.sessionId;
        writeMeta(record);
      }
      emitEvent('session_ready', s);
    });
    client.on('update', (params) => {
      const u = params?.update || {};
      const event = u.sessionUpdate || 'update';
      emitEvent(event, { update: u, _meta: params?._meta || null, sessionId: params?.sessionId });
    });
    client.on('x_notification', (msg) => {
      const method = msg.method || 'x_notification';
      emitEvent(method.replace(/^_/, ''), { method, params: msg.params });

      // session_summary_generated is wrapped in _x.ai/session_notification.
      // Use it to auto-name the conversation on first turn.
      const upd = msg?.params?.update;
      if (upd && upd.sessionUpdate === 'session_summary_generated' && record.autoNamed) {
        const summary = String(upd.session_summary || '').trim();
        if (summary) {
          const prev = record.name;
          const next = summary.length > 60 ? summary.slice(0, 60).replace(/\s+\S*$/, '') + '...' : summary;
          if (next && next !== prev) {
            record.name = next;
            writeMeta(record);
            emitEvent('agent_renamed', { id, name: next, prevName: prev, source: 'auto', summary });
          }
        }
      }
    });
    client.on('prompt_complete', (params) => emitEvent('prompt_complete', params));
    client.on('prompt_result',  (result) => emitEvent('prompt_result', result));
    client.on('error', (err) => {
      record.lastError = err?.message || String(err);
      writeMeta(record);
      emitEvent('error', { message: record.lastError });
    });
    client.on('exit', (info) => {
      emitEvent('agent_exited', info);
      // Treat unexpected exits as transitions into "disconnected" so the
      // user can reconnect (rather than the record being stuck in 'exited').
      if (record.client === client) {
        record.client = null;
        record.status = 'disconnected';
        writeMeta(record);
        emitEvent('agent_status', { status: 'disconnected', reason: 'process_exit' });
        this.emit('list_changed', { event: 'agent_status', id: record.id, status: 'disconnected' });
      }
    });
    client.on('stderr', (chunk) => emitEvent('stderr', { chunk }));
  }

  async spawn({ name, model, cwd, settings } = {}) {
    const id = randomUUID();
    ensureAgentDirs(id);
    const dir = agentDir(id);
    const workCwd = cwd && fs.existsSync(cwd) ? path.resolve(cwd) : path.join(dir, 'cwd');
    fs.mkdirSync(workCwd, { recursive: true });

    const ring = createRing(SSE_RING_LIMIT);
    const record = {
      id,
      name: name || `agent-${id.slice(0, 8)}`,
      autoNamed: !name,
      modelHint: model || null,
      cwd: workCwd,
      createdAt: nowIso(),
      lastSeen: nowIso(),
      lastSessionId: null,
      lastError: null,
      settings: settings && typeof settings === 'object' ? settings : null,
      client: null,
      ring,
      status: 'starting',
      eventCounter: 0,
    };
    this.agents.set(id, record);
    writeMeta(record);

    historyAppend(id, { at: nowIso(), event: 'agent_created', data: { id, name: record.name, cwd: workCwd } });

    this._connectRecord(record);
    const pub = this._publicRecord(record);
    this.emit('list_changed', { event: 'agent_added', agent: pub });
    return pub;
  }

  _connectRecord(record) {
    if (record.client) return record.client;
    record.status = 'starting';
    const client = new AcpClient({
      cwd: record.cwd,
      modelHint: record.modelHint,
      settings: record.settings || null,
    });
    record.client = client;
    this._wireClient(record);
    const emitEvent = this._emitEventFactory(record);
    emitEvent('agent_status', { status: 'starting' });
    client.start({ resumeSessionId: record.lastSessionId || null }).catch((err) => {
      record.lastError = err?.message || String(err);
      writeMeta(record);
      emitEvent('error', { message: record.lastError });
    });
    return client;
  }

  async connect(id) {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    if (a.client) return this._publicRecord(a);
    this._connectRecord(a);
    return this._publicRecord(a);
  }

  async disconnect(id) {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    if (!a.client) return this._publicRecord(a);
    const client = a.client;
    a.client = null;
    a.status = 'disconnected';
    if (client.sessionId) a.lastSessionId = client.sessionId;
    writeMeta(a);
    try { await client.shutdown('SIGTERM'); } catch { /* ignore */ }
    const emitEvent = this._emitEventFactory(a);
    emitEvent('agent_status', { status: 'disconnected', reason: 'user_request' });
    this.emit('list_changed', { event: 'agent_status', id: a.id, status: 'disconnected' });
    return this._publicRecord(a);
  }

  async kill(id) {
    const a = this.agents.get(id);
    if (!a) return false;
    if (a.client) {
      try { await a.client.shutdown('SIGTERM'); } catch { /* ignore */ }
    }
    this.agents.delete(id);
    this.emit('list_changed', { event: 'agent_removed', id });
    // Hard delete: scrub the on-disk record. Guarded so we never recurse out
    // of the agents/ root.
    try {
      const dir = agentDir(id);
      if (dir.startsWith(AGENTS_ROOT + path.sep)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      process.stderr.write(`[kill] failed to remove ${id}: ${err.message}\n`);
    }
    return true;
  }

  async prompt(id, textOrOpts) {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');

    // Auto-reconnect if the agent was disconnected; wait briefly for the
    // session to be ready so we don't fire prompt against a half-built client.
    if (!a.client) {
      this._connectRecord(a);
      await this._waitForSession(a, 8000);
    } else if (!a.client.sessionId) {
      await this._waitForSession(a, 8000);
    }
    if (!a.client) throw new Error('reconnect failed');

    // Accept either a plain string (back-compat) or { text, attachments }.
    let text, attachments;
    if (textOrOpts && typeof textOrOpts === 'object' && !Array.isArray(textOrOpts)) {
      text = String(textOrOpts.text || '');
      attachments = Array.isArray(textOrOpts.attachments) ? textOrOpts.attachments : [];
    } else {
      text = String(textOrOpts || '');
      attachments = [];
    }

    // Save any attachments to <cwd>/uploads/ so the agent can read them via
    // its terminal / read_file tools. Then append a reference block to the
    // user text. We do not try to send images as ACP inline content blocks
    // because no current grok model advertises image input support; routing
    // through the agent's workspace works for every model.
    const savedFiles = [];
    if (attachments.length) {
      const uploadsDir = path.join(a.cwd, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      for (const att of attachments) {
        if (!att || typeof att.dataBase64 !== 'string' || !att.dataBase64) continue;
        const buf = Buffer.from(att.dataBase64, 'base64');
        const candidate = uniqueUploadName(uploadsDir, att.name, att.mimeType);
        const abs = path.join(uploadsDir, candidate);
        fs.writeFileSync(abs, buf);
        savedFiles.push({
          rel: path.posix.join('uploads', candidate),
          abs,
          mimeType: att.mimeType || null,
          size: buf.length,
        });
      }
    }

    // Compose the final user message. When files were saved, append a small
    // block listing them with absolute paths. We intentionally keep this
    // neutral: the inline image content block and the resource_link block
    // are what actually tell the agent how to use the file. Adding
    // instructional prose like "you cannot view this" gets parroted back
    // by the model even when the image is right there.
    const supportsImage = !!(a.client?.handshake?.agentCapabilities?.promptCapabilities?.image);
    let finalText = text;
    if (savedFiles.length) {
      const lines = savedFiles.map(f => attachmentLine(f));
      const refBlock = 'Attached files:\n' + lines.join('\n');
      finalText = text && text.length ? `${text}\n\n${refBlock}` : refBlock;
    }

    // Build the ACP prompt content blocks.
    // - text: the composed user message + the attachment block listing
    //   absolute paths and per-kind hints.
    // - image (when the attachment IS an image): inline base64 so the model
    //   can actually see pixels. The handshake's promptCapabilities.image
    //   flag is what the ACP layer advertises, but the underlying API will
    //   accept image blocks regardless on cloud models. Other clients (TUI)
    //   send images this way too.
    // - resource_link: when the agent advertises embeddedContext, also send
    //   formal ACP resource_link blocks so the agent has a first-class file
    //   reference (useful for non-image attachments and as a fallback).
    const embeddedContext = !!(a.client?.handshake?.agentCapabilities?.promptCapabilities?.embeddedContext);
    const blocks = [];
    if (finalText && finalText.length) blocks.push({ type: 'text', text: finalText });
    // Inline image blocks for any image attachment, regardless of the
    // capability flag. We read the bytes back from disk (we already wrote
    // them there) so the base64 doesn't have to be re-encoded from the
    // browser payload.
    for (let i = 0; i < savedFiles.length; i++) {
      const f = savedFiles[i];
      const mime = (f.mimeType || '').toLowerCase();
      if (!mime.startsWith('image/')) continue;
      try {
        const buf = fs.readFileSync(f.abs);
        blocks.push({
          type: 'image',
          mimeType: f.mimeType || 'image/png',
          data: buf.toString('base64'),
        });
      } catch { /* fall back to text+resource_link only */ }
    }
    if (embeddedContext) {
      for (const f of savedFiles) {
        blocks.push({
          type: 'resource_link',
          uri: 'file://' + f.abs,
          name: path.basename(f.abs),
          mimeType: f.mimeType || 'application/octet-stream',
          size: f.size,
        });
      }
    }
    if (!blocks.length) throw new Error('empty prompt');

    // Record the user message in history.
    const histAttachments = savedFiles.map(f => ({
      rel: f.rel, mimeType: f.mimeType, size: f.size,
    }));
    const histData = histAttachments.length
      ? { text: finalText, attachments: histAttachments }
      : { text: finalText };
    historyAppend(id, { at: nowIso(), event: 'user_message', data: histData });
    a.ring.push({
      id: `${Date.now()}-user`,
      event: 'user_message',
      data: { ...histData, _t: Date.now() },
    });
    this.emit(`agent:${id}`, {
      id: `${Date.now()}-user`,
      event: 'user_message',
      data: { ...histData, _t: Date.now() },
    });
    // Don't await; the prompt resolution flows via prompt_result event.
    a.client.prompt(blocks).catch(() => { /* error already emitted */ });
    return {
      ok: true,
      debug: {
        sessionId: a.client?.sessionId || null,
        composedText: finalText,
        promptBlocks: blocks,
        savedFiles: savedFiles.map(f => ({
          abs: f.abs, rel: f.rel, mimeType: f.mimeType, size: f.size,
        })),
        supportsImage,
      },
    };
  }

  async cancel(id) {
    const a = this.agents.get(id);
    if (!a) return false;
    if (!a.client) return false;
    await a.client.cancel();
    return true;
  }

  async _waitForSession(record, timeoutMs) {
    if (record.client && record.client.sessionId) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (record.client && record.client.sessionId) return;
      if (record.client && record.client.status === 'errored') {
        throw new Error(record.client.lastError || 'agent errored during reconnect');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timed out waiting for session');
  }

  ring(id) {
    const a = this.agents.get(id);
    return a ? a.ring : null;
  }

  subscribe(id, listener) {
    this.on(`agent:${id}`, listener);
    return () => this.off(`agent:${id}`, listener);
  }

  async shutdownAll() {
    // Disconnect (not delete) every agent so processes are killed cleanly
    // but their meta + history survive the server restart.
    const ids = [...this.agents.keys()];
    await Promise.all(ids.map((id) => this.disconnect(id).catch(() => {})));
  }
}
