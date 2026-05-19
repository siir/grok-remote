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

  async prompt(id, text) {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    // record the user message in history immediately
    historyAppend(id, { at: nowIso(), event: 'user_message', data: { text } });
    a.ring.push({
      id: `${Date.now()}-user`,
      event: 'user_message',
      data: { text, _t: Date.now() },
    });
    this.emit(`agent:${id}`, {
      id: `${Date.now()}-user`,
      event: 'user_message',
      data: { text, _t: Date.now() },
    });
    // Don't await; the prompt resolution flows via prompt_result event.
    a.client.prompt(text).catch(() => { /* error already emitted */ });
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
