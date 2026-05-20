// Run `grok trace <sessionId> --local` for an agent, unpack the resulting
// tar.gz, parse each of the 8 archive members, and return a single JSON
// payload the dashboard can render directly. Server-side extraction avoids
// pulling a tar/gzip library into the browser.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const GROK_BIN = process.env.GROK_BIN || 'grok';

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${cmd} exited ${code}: ${err || out}`));
    });
  });
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function readJsonlSafe(p) {
  try {
    const out = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return out;
  } catch { return []; }
}

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function fileSizeSafe(p) {
  try { return fs.statSync(p).size; } catch { return null; }
}

// Build the trace for a single agent record (the public shape returned by
// AgentManager.get / list, which carries .sessionId and .lastSessionId).
// .sessionId is set while the agent is live; .lastSessionId is set when
// the agent was disconnected. Either is fine to pass to `grok trace`.
export async function buildTrace(record) {
  const sessionId = record.sessionId || record.lastSessionId;
  if (!sessionId) {
    throw new Error('no sessionId yet (agent has not completed a handshake)');
  }
  return buildTraceForSessionId(sessionId, record.cwd);
}

// Build a trace for any raw session id (not just an AgentManager-tracked
// agent). Used by the sub-agent trace endpoint, which knows the child's
// sessionId from the parent's tool_call output but has no AgentManager
// record of its own. `cwd` is optional. `grok trace` resolves the session
// dir on its own; cwd is here for future use if the CLI ever needs it.
export async function buildTraceForSessionId(sessionId, cwd) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId required');
  }
  // cwd is reserved for future use (some `grok trace` variants prefer being
  // run from the originating cwd). Today the CLI resolves sessions by id
  // regardless, so we just ignore it.
  void cwd;
  const stamp = Date.now().toString(36) + '-' + randomUUID().slice(0, 8);
  const tmpRoot = path.join(os.tmpdir(), `grok-trace-${stamp}`);
  const archivePath = path.join(tmpRoot, 'trace.tar.gz');
  const extractDir  = path.join(tmpRoot, 'unpacked');
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    // 1. Export. --local avoids uploading to xAI. --json gives us a
    //    machine-readable status line on stdout.
    const exportOut = await runCmd(GROK_BIN, [
      'trace', sessionId, '--local', '--json', '-o', archivePath,
    ]);
    let exportStatus = null;
    try { exportStatus = JSON.parse(exportOut.stdout.trim().split('\n').pop()); } catch { /* ignore */ }

    // 2. Extract.
    await runCmd('tar', ['-xzf', archivePath, '-C', extractDir]);

    // 3. Find the inner session dir.
    const inner = fs.readdirSync(extractDir).map(n => path.join(extractDir, n))
      .find(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    if (!inner) throw new Error('trace archive contained no session directory');

    // 4. Parse every known member.
    const members = {
      summary:        path.join(inner, 'summary.json'),
      chatHistory:    path.join(inner, 'chat_history.jsonl'),
      events:         path.join(inner, 'events.jsonl'),
      updates:        path.join(inner, 'updates.jsonl'),
      systemPrompt:   path.join(inner, 'system_prompt.txt'),
      promptContext:  path.join(inner, 'prompt_context.json'),
      traceConfig:    path.join(inner, 'trace_config.json'),
      exportMetadata: path.join(inner, 'export_metadata.json'),
    };

    const data = {
      sessionId,
      generatedAt:    new Date().toISOString(),
      archiveBytes:   fileSizeSafe(archivePath),
      exportStatus,
      summary:        readJsonSafe(members.summary),
      chatHistory:    readJsonlSafe(members.chatHistory),
      events:         readJsonlSafe(members.events),
      updates:        readJsonlSafe(members.updates),
      systemPrompt:   readTextSafe(members.systemPrompt),
      promptContext:  readJsonSafe(members.promptContext),
      traceConfig:    readJsonSafe(members.traceConfig),
      exportMetadata: readJsonSafe(members.exportMetadata),
      // sizes for the Files tab in the UI
      memberSizes: Object.fromEntries(
        Object.entries(members).map(([k, p]) => [k, fileSizeSafe(p)])
      ),
    };

    return data;
  } finally {
    // Always clean up the tmp dir. The UI re-fetches every time the tab
    // is opened, so we never want stale archives on disk.
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
