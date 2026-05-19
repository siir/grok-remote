#!/usr/bin/env node
// Probe the grok agent stdio (ACP) protocol.
// Usage: node probe.js "<prompt>" [log-file]
//
// Talks to `grok agent stdio` via JSON-RPC, captures every line to disk,
// and exits when the prompt turn completes.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, appendFileSync } from 'node:fs';

const promptText = process.argv[2] || "Reply with the word 'ack' and nothing else.";
const logPath = process.argv[3] || './probe.log';
writeFileSync(logPath, '');

const proc = spawn('grok', ['agent', '--no-leader', '--always-approve', 'stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

const log = (label, obj) => appendFileSync(logPath, `=== ${label} === ${JSON.stringify(obj)}\n`);
const raw = (line) => appendFileSync(logPath, `RAW ${line}\n`);

let nextId = 1;
const pending = new Map();
const send = (msg) => {
  log('SEND', msg);
  proc.stdin.write(JSON.stringify(msg) + '\n');
};
const request = (method, params) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
};

proc.stderr.on('data', (b) => appendFileSync(logPath, `[stderr] ${b.toString()}`));

const rl = createInterface({ input: proc.stdout });
rl.on('line', (line) => {
  raw(line);
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // Response to one of our requests
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  // Request from server back to us
  if (msg.id != null && msg.method) {
    // Reply empty/null for permission/fs calls so the agent keeps going
    const m = msg.method || '';
    let result = null;
    if (m.endsWith('request_permission') || m === 'session/request_permission') {
      result = { outcome: { outcome: 'selected', optionId: 'allow_always' } };
    } else if (m.startsWith('x.ai/fs/') || m.startsWith('fs/')) {
      result = {}; // best-effort empty reply
    } else {
      result = {};
    }
    send({ jsonrpc: '2.0', id: msg.id, result });
    return;
  }
  // Notification (no id) - stream event
  // Already logged via RAW.
});

(async () => {
  try {
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
    log('INIT_RESULT', init);

    const ns = await request('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    });
    log('SESSION_NEW_RESULT', ns);
    const sessionId = ns?.sessionId;
    if (!sessionId) throw new Error('no sessionId in session/new result');

    const pr = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: promptText }],
    });
    log('PROMPT_RESULT', pr);

    // Give it a beat for any trailing notifications.
    setTimeout(() => { proc.kill(); process.exit(0); }, 300);
  } catch (e) {
    log('ERROR', { message: e.message });
    proc.kill();
    process.exit(1);
  }
})();
