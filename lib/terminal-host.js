// Spawns real shell processes on behalf of the agent and tracks their output
// buffers. Mirrors the methods listed in PROTOCOL.md.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const DEFAULT_LIMIT = 256 * 1024;

function envArrayToObject(envArray) {
  if (!Array.isArray(envArray)) return null;
  const out = {};
  for (const e of envArray) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.name === 'string') out[e.name] = String(e.value ?? '');
  }
  return out;
}

function rpcError(code, message) {
  const err = new Error(message);
  err.rpc = { code, message };
  return err;
}

export function createTerminalHost({ getCwd }) {
  const terminals = new Map();

  function append(t, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    t.buffer = Buffer.concat([t.buffer, buf]);
    if (t.buffer.length > t.limit) {
      // Trim oldest bytes; mark truncated.
      t.buffer = t.buffer.subarray(t.buffer.length - t.limit);
      t.truncated = true;
    }
  }

  function killTerm(t, signal = 'SIGKILL') {
    if (!t || !t.proc || t.exited) return;
    try { t.proc.kill(signal); } catch { /* ignore */ }
  }

  async function create(params) {
    const command = params?.command;
    if (typeof command !== 'string' || !command.length) {
      throw rpcError(-32602, 'terminal/create: command required');
    }
    const cwd = params?.cwd || getCwd() || process.cwd();
    const limit = typeof params?.outputByteLimit === 'number'
      ? params.outputByteLimit
      : DEFAULT_LIMIT;
    const envObj = envArrayToObject(params?.env);
    // Merge: start from a clean parent env so the agent's env wins predictably,
    // but still inherit PATH so /bin/bash, etc. resolve.
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...(envObj || {}) };

    // Args array form, when supplied, beats the bash-string form.
    let cmd, args;
    if (Array.isArray(params?.args) && params.args.length) {
      cmd = command;
      args = params.args.map(String);
    } else {
      cmd = '/bin/bash';
      args = ['-lc', command];
    }

    const proc = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const terminalId = `term-${randomUUID()}`;
    const t = {
      id: terminalId,
      proc,
      buffer: Buffer.alloc(0),
      truncated: false,
      limit,
      exited: false,
      exitStatus: null,
      waiters: [],
      command,
      cwd,
    };
    terminals.set(terminalId, t);

    proc.stdout?.on('data', (d) => append(t, d));
    proc.stderr?.on('data', (d) => append(t, d));
    proc.on('error', (err) => {
      append(t, `\n[terminal-host] spawn error: ${err.message}\n`);
    });
    proc.on('exit', (code, signal) => {
      t.exited = true;
      t.exitStatus = { exitCode: code, signal };
      for (const w of t.waiters.splice(0)) w({ exitStatus: t.exitStatus });
    });

    return { terminalId };
  }

  function getOrThrow(id) {
    const t = terminals.get(id);
    if (!t) throw rpcError(-32004, `unknown terminalId: ${id}`);
    return t;
  }

  async function output(params) {
    const t = getOrThrow(params?.terminalId);
    return {
      output: t.buffer.toString('utf8'),
      truncated: t.truncated,
      exitStatus: t.exitStatus,
    };
  }

  async function waitForExit(params) {
    const t = getOrThrow(params?.terminalId);
    if (t.exited) return { exitStatus: t.exitStatus };
    return new Promise((resolve) => t.waiters.push(resolve));
  }

  async function kill(params) {
    const t = getOrThrow(params?.terminalId);
    killTerm(t);
    return {};
  }

  async function release(params) {
    const t = terminals.get(params?.terminalId);
    if (t) {
      killTerm(t);
      terminals.delete(t.id);
    }
    return {};
  }

  function shutdownAll() {
    for (const t of terminals.values()) killTerm(t);
    terminals.clear();
  }

  return {
    create,
    output,
    waitForExit,
    kill,
    release,
    shutdownAll,
    _terminals: terminals,
  };
}
