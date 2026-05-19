// One ACP client per grok agent stdio process.
//
// Responsibilities:
//   - Spawn `grok agent --no-leader --always-approve stdio`.
//   - Drive the handshake (initialize + session/new).
//   - Read stdout line by line as JSON-RPC frames.
//   - Resolve responses to our outgoing requests.
//   - Dispatch agent->client requests to the host modules (terminal/fs/permission).
//   - Emit high-level events: 'handshake', 'notification', 'update', 'request',
//     'response', 'prompt_complete', 'exit', 'error', 'rpc_send', 'rpc_recv'.
//
// Concurrency: client-originated request ids are strings ("c-<n>") so they
// never collide with the numeric ids the agent uses for its own requests.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

import { createTerminalHost } from './terminal-host.js';
import { createFsHost } from './fs-host.js';
import { createPermissionHost } from './permission-host.js';

const GROK_BIN = process.env.GROK_BIN || 'grok';

export class AcpClient extends EventEmitter {
  constructor({ cwd, env, modelHint } = {}) {
    super();
    this.cwd = cwd;
    this.env = env || process.env;
    this.modelHint = modelHint || null;

    this.proc = null;
    this.sessionId = null;
    this.handshake = null;
    this.modelId = null;
    this.availableCommands = [];
    this.status = 'starting';
    this.lastError = null;
    this.exitInfo = null;

    this._pending = new Map(); // our outgoing requests
    this._nextId = 1;
    this._closing = false;
    this._activePromptId = null;

    this.terminalHost = createTerminalHost({ getCwd: () => this.cwd });
    this.fsHost = createFsHost({ getCwd: () => this.cwd });
    this.permissionHost = createPermissionHost();
  }

  setStatus(s, extra) {
    this.status = s;
    this.emit('status', { status: s, ...(extra || {}) });
  }

  async start({ resumeSessionId = null } = {}) {
    this.proc = spawn(
      GROK_BIN,
      ['agent', '--no-leader', '--always-approve', 'stdio'],
      { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    this.proc.on('error', (err) => {
      this.lastError = err.message;
      this.setStatus('errored', { error: err.message });
      this.emit('error', err);
    });

    this.proc.on('exit', (code, signal) => {
      this.exitInfo = { code, signal, at: Date.now() };
      this.setStatus('exited', { code, signal });
      this.emit('exit', this.exitInfo);
      this.terminalHost.shutdownAll();
      for (const [, pending] of this._pending) {
        pending.reject(new Error('agent exited'));
      }
      this._pending.clear();
    });

    this.proc.stderr?.on('data', (b) => {
      this.emit('stderr', b.toString('utf8'));
    });

    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this._onLine(line));

    // Run handshake; surface failures via the event/status, not by throwing.
    try {
      await this._handshake(resumeSessionId);
      this.setStatus('idle');
    } catch (err) {
      this.lastError = err.message;
      this.setStatus('errored', { error: err.message });
      this.emit('error', err);
    }
  }

  async _handshake(resumeSessionId) {
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
    this.handshake = init;
    const meta = init?._meta || {};
    this.modelId = meta?.modelState?.currentModelId || null;
    this.availableCommands = meta?.availableCommands || [];
    this.emit('handshake', init);

    // If a prior sessionId is supplied AND the agent advertises load support,
    // try session/load first. On failure (session expired, unknown id, ...)
    // fall back to a fresh session/new so the user can keep going.
    const canLoad = !!init?.agentCapabilities?.loadSession;
    let loaded = false;
    if (resumeSessionId && canLoad) {
      try {
        await this.request('session/load', {
          sessionId: resumeSessionId,
          cwd: this.cwd,
          mcpServers: [],
        });
        this.sessionId = resumeSessionId;
        loaded = true;
        this.emit('session_ready', { sessionId: this.sessionId, resumed: true });
      } catch (err) {
        this.emit('stderr', `session/load failed (${err.message}); starting fresh session\n`);
      }
    }
    if (!loaded) {
      const ns = await this.request('session/new', {
        cwd: this.cwd,
        mcpServers: [],
      });
      if (!ns?.sessionId) throw new Error('session/new did not return sessionId');
      this.sessionId = ns.sessionId;
      this.emit('session_ready', { sessionId: this.sessionId, resumed: false });
    }
  }

  _send(msg) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error('agent stdin not writable');
    }
    this.emit('rpc_send', msg);
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params) {
    const id = `c-${this._nextId++}`;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  async _onLine(line) {
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch {
      this.emit('error', new Error(`non-json frame: ${line.slice(0, 120)}`));
      return;
    }
    this.emit('rpc_recv', msg);

    // Response to one of our outgoing requests.
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this._pending.get(msg.id);
      if (p) {
        this._pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'rpc error'), { rpc: msg.error }));
        else p.resolve(msg.result);
      }
      return;
    }

    // Request from the agent back to us.
    if (msg.id != null && msg.method) {
      this.emit('request', msg);
      try {
        const result = await this._dispatch(msg.method, msg.params);
        this._send({ jsonrpc: '2.0', id: msg.id, result });
      } catch (err) {
        const rpc = err?.rpc && typeof err.rpc === 'object' ? err.rpc : { code: -32603, message: err?.message || 'internal error' };
        this._send({ jsonrpc: '2.0', id: msg.id, error: rpc });
      }
      return;
    }

    // Notification (no id) - streaming event.
    if (msg.method) {
      this.emit('notification', msg);
      if (msg.method === 'session/update') {
        this.emit('update', msg.params);
      } else if (msg.method === '_x.ai/session/prompt_complete') {
        this.emit('prompt_complete', msg.params);
      } else if (msg.method.startsWith('_x.ai/')) {
        this.emit('x_notification', msg);
      }
    }
  }

  async _dispatch(method, params) {
    switch (method) {
      case 'terminal/create':       return this.terminalHost.create(params);
      case 'terminal/output':       return this.terminalHost.output(params);
      case 'terminal/wait_for_exit':return this.terminalHost.waitForExit(params);
      case 'terminal/kill':         return this.terminalHost.kill(params);
      case 'terminal/release':      return this.terminalHost.release(params);
      case 'fs/read_text_file':     return this.fsHost.readTextFile(params);
      case 'fs/write_text_file':    return this.fsHost.writeTextFile(params);
      case 'session/request_permission': return this.permissionHost.requestPermission(params);
      default: {
        const err = new Error(`Method not found: ${method}`);
        err.rpc = { code: -32601, message: `Method not found: ${method}` };
        throw err;
      }
    }
  }

  async prompt(textOrBlocks) {
    if (!this.sessionId) throw new Error('session not ready');
    // Accept either a plain string (back-compat) or an array of content
    // blocks already shaped for ACP, e.g.
    //   [{type:"text",text:"..."}, {type:"image",mimeType:"image/png",data:"..."}]
    let prompt;
    if (Array.isArray(textOrBlocks)) {
      prompt = textOrBlocks;
    } else {
      prompt = [{ type: 'text', text: String(textOrBlocks) }];
    }
    this.setStatus('running');
    try {
      const result = await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt,
      });
      this.setStatus('idle');
      this.emit('prompt_result', result);
      return result;
    } catch (err) {
      this.setStatus('errored', { error: err.message });
      throw err;
    }
  }

  async cancel() {
    if (!this.sessionId) return { cancelled: false, reason: 'no session' };
    try {
      const result = await this.request('session/cancel', { sessionId: this.sessionId });
      return { cancelled: true, result };
    } catch (err) {
      // session/cancel may not exist; fall back to a notification.
      try {
        this.notify('session/cancel', { sessionId: this.sessionId });
      } catch { /* ignore */ }
      return { cancelled: true, fallback: 'notification', error: err.message };
    }
  }

  async shutdown(signal = 'SIGTERM') {
    if (this._closing) return;
    this._closing = true;
    this.terminalHost.shutdownAll();
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(signal); } catch { /* ignore */ }
      // Hard kill after 2s.
      const proc = this.proc;
      setTimeout(() => {
        if (proc.exitCode == null && !proc.killed) {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 2000).unref?.();
    }
  }
}
