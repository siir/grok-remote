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

function attachmentLine(f, modelSupportsImage) {
  const mime = (f.mimeType || '').toLowerCase();
  const size = humanSize(f.size);
  const path = f.abs;
  let hint = '';
  if (mime.startsWith('image/')) {
    if (modelSupportsImage) {
      hint = 'image; you can view it directly via your image-capable tools.';
    } else {
      hint =
        'image; your text-based Read tool cannot view it. Use shell tools ' +
        '(file, sips, identify) for metadata. To know what the image shows, ' +
        'ask the user to describe it.';
    }
  } else if (mime.startsWith('video/')) {
    hint = 'video; cannot be viewed inline. Use `file` or `ffprobe` (if installed) for metadata.';
  } else if (mime.startsWith('audio/')) {
    hint = 'audio; cannot be played inline. Use `file` or `ffprobe` (if installed) for metadata.';
  } else if (mime === 'application/pdf') {
    hint = 'PDF; binary. Use `pdftotext` (if installed) to extract text, or describe with the user.';
  } else if (mime === 'application/zip' || /\.(zip|tar|gz|tgz|bz2|7z|rar)$/i.test(path)) {
    hint = 'archive; binary. Use shell tools (`unzip -l`, `tar -tf`) to inspect contents.';
  } else if (/^(text\/|application\/(json|xml|x-yaml|javascript|sh))/.test(mime) ||
             /\.(txt|md|json|yaml|yml|csv|tsv|js|ts|py|sh|rs|go|c|cpp|java|html|css|xml|toml|ini|conf|log)$/i.test(path)) {
    hint = 'text; use your Read tool to view its contents.';
  } else {
    hint = 'binary; inspect via shell tools rather than Read.';
  }
  return `- ${path} (${f.mimeType || 'application/octet-stream'}, ${size}) - ${hint}`;
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
    };
  }

  _emitEventFactory(record) {
    return (event, data) => {
      record.eventCounter = (record.eventCounter || 0) + 1;
      const eventId = `${Date.now()}-${record.eventCounter}`;
      const wrapped = { id: eventId, event, data: { ...data, _t: Date.now() } };
      record.ring.push(wrapped);
      record.lastSeen = nowIso();
      historyAppend(record.id, { eventId, at: record.lastSeen, event, data });
      this.emit(`agent:${record.id}`, wrapped);
    };
  }

  _wireClient(record) {
    const id = record.id;
    const emitEvent = this._emitEventFactory(record);
    const client = record.client;

    client.on('status', (s) => {
      emitEvent('agent_status', s);
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
      }
    });
    client.on('stderr', (chunk) => emitEvent('stderr', { chunk }));
  }

  async spawn({ name, model, cwd } = {}) {
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
      client: null,
      ring,
      status: 'starting',
      eventCounter: 0,
    };
    this.agents.set(id, record);
    writeMeta(record);

    historyAppend(id, { at: nowIso(), event: 'agent_created', data: { id, name: record.name, cwd: workCwd } });

    this._connectRecord(record);
    return this._publicRecord(record);
  }

  _connectRecord(record) {
    if (record.client) return record.client;
    record.status = 'starting';
    const client = new AcpClient({ cwd: record.cwd, modelHint: record.modelHint });
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
    return this._publicRecord(a);
  }

  async kill(id) {
    const a = this.agents.get(id);
    if (!a) return false;
    if (a.client) {
      try { await a.client.shutdown('SIGTERM'); } catch { /* ignore */ }
    }
    this.agents.delete(id);
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

    // Compose the final user message. When files were saved, append a block
    // with absolute paths and per-file hints so the agent picks the right
    // tool first instead of wasting turns. The Read tool refuses binaries,
    // so flag images and other binary types up front.
    const supportsImage = !!(a.client?.handshake?.agentCapabilities?.promptCapabilities?.image);
    let finalText = text;
    if (savedFiles.length) {
      const lines = savedFiles.map(f => attachmentLine(f, supportsImage));
      const refBlock =
        'The user attached the following files to this message. They are saved ' +
        'on disk; use the absolute paths below directly (no need to search). ' +
        'Pick the right tool for each kind, do not call your text Read on ' +
        'binary files - it will reject them.\n' +
        lines.join('\n');
      finalText = text && text.length ? `${text}\n\n${refBlock}` : refBlock;
    }

    // Build the ACP prompt content blocks (text only; uploads live on disk).
    const blocks = [];
    if (finalText && finalText.length) blocks.push({ type: 'text', text: finalText });
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
