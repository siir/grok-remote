// Registry of live AcpClient instances + per-agent SSE ring buffers and history.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { AcpClient } from './acp-client.js';
import { ensureAgentDirs, agentDir, append as historyAppend } from './history.js';
import { createRing } from './sse.js';

const SSE_RING_LIMIT = 200;

function nowIso() { return new Date().toISOString(); }

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
      status: a.client?.status || a.status || 'unknown',
      cwd: a.cwd,
      createdAt: a.createdAt,
      lastSeen: a.lastSeen,
      handshakeMeta: a.client?.handshake?._meta || null,
      agentCapabilities: a.client?.handshake?.agentCapabilities || null,
      sessionId: a.client?.sessionId || null,
      availableCommands: a.client?.availableCommands || [],
      lastError: a.client?.lastError || a.lastError || null,
      exitInfo: a.client?.exitInfo || null,
    };
  }

  async spawn({ name, model, cwd } = {}) {
    const id = randomUUID();
    ensureAgentDirs(id);
    const dir = agentDir(id);
    const workCwd = cwd && fs.existsSync(cwd) ? path.resolve(cwd) : path.join(dir, 'cwd');
    fs.mkdirSync(workCwd, { recursive: true });

    const client = new AcpClient({ cwd: workCwd, modelHint: model });
    const ring = createRing(SSE_RING_LIMIT);
    let eventCounter = 0;

    const record = {
      id,
      name: name || `agent-${id.slice(0, 8)}`,
      autoNamed: !name,
      modelHint: model || null,
      cwd: workCwd,
      createdAt: nowIso(),
      lastSeen: nowIso(),
      client,
      ring,
      status: 'starting',
      lastError: null,
    };
    this.agents.set(id, record);

    const emitEvent = (event, data) => {
      const eventId = `${Date.now()}-${++eventCounter}`;
      const wrapped = { id: eventId, event, data: { ...data, _t: Date.now() } };
      ring.push(wrapped);
      record.lastSeen = nowIso();
      historyAppend(id, { eventId, at: record.lastSeen, event, data });
      this.emit(`agent:${id}`, wrapped);
    };

    historyAppend(id, { at: nowIso(), event: 'agent_created', data: { id, name: record.name, cwd: workCwd } });
    emitEvent('agent_status', { status: 'starting' });

    client.on('status', (s) => {
      emitEvent('agent_status', s);
    });
    client.on('handshake', (h) => {
      emitEvent('handshake', { meta: h?._meta || null, agentCapabilities: h?.agentCapabilities || null });
    });
    client.on('session_ready', (s) => emitEvent('session_ready', s));
    client.on('update', (params) => {
      const u = params?.update || {};
      const event = u.sessionUpdate || 'update';
      emitEvent(event, { update: u, _meta: params?._meta || null, sessionId: params?.sessionId });
    });
    client.on('x_notification', (msg) => {
      // Forward x.ai/* notifications under a stable SSE event name.
      const method = msg.method || 'x_notification';
      emitEvent(method.replace(/^_/, ''), { method, params: msg.params });

      // Grok emits session_summary_generated wrapped in _x.ai/session_notification
      // after the first turn completes. Use it to auto-name the conversation.
      const upd = msg?.params?.update;
      if (upd && upd.sessionUpdate === 'session_summary_generated' && record.autoNamed) {
        const summary = String(upd.session_summary || '').trim();
        if (summary) {
          const prev = record.name;
          const next = summary.length > 60 ? summary.slice(0, 60).replace(/\s+\S*$/, '') + '...' : summary;
          if (next && next !== prev) {
            record.name = next;
            emitEvent('agent_renamed', { id, name: next, prevName: prev, source: 'auto', summary });
          }
        }
      }
    });
    client.on('prompt_complete', (params) => {
      emitEvent('prompt_complete', params);
    });
    client.on('prompt_result', (result) => {
      emitEvent('prompt_result', result);
    });
    client.on('error', (err) => {
      record.lastError = err?.message || String(err);
      emitEvent('error', { message: record.lastError });
    });
    client.on('exit', (info) => emitEvent('agent_exited', info));
    client.on('stderr', (chunk) => emitEvent('stderr', { chunk }));

    // Fire-and-forget start; handshake errors surface via 'status'/'error' events.
    client.start().catch((err) => {
      record.lastError = err?.message || String(err);
      emitEvent('error', { message: record.lastError });
    });

    return this._publicRecord(record);
  }

  async kill(id) {
    const a = this.agents.get(id);
    if (!a) return false;
    await a.client.shutdown('SIGTERM');
    this.agents.delete(id);
    return true;
  }

  async prompt(id, textOrOpts) {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
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
    return true;
  }

  async cancel(id) {
    const a = this.agents.get(id);
    if (!a) return false;
    await a.client.cancel();
    return true;
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
    const ids = [...this.agents.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
  }
}
