// Per-agent append-only JSONL history at ~/.grok-remote/agents/<id>/history.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), '.grok-remote', 'agents');

export function agentDir(agentId) {
  return path.join(ROOT, agentId);
}

export function historyPath(agentId) {
  return path.join(agentDir(agentId), 'history.jsonl');
}

export function ensureAgentDirs(agentId) {
  const dir = agentDir(agentId);
  fs.mkdirSync(path.join(dir, 'cwd'), { recursive: true });
  return dir;
}

export function append(agentId, event) {
  try {
    ensureAgentDirs(agentId);
    fs.appendFileSync(historyPath(agentId), JSON.stringify(event) + '\n');
  } catch (err) {
    // Don't let history failures break the live stream.
    process.stderr.write(`[history] append failed for ${agentId}: ${err.message}\n`);
  }
}

export function readAll(agentId) {
  try {
    return fs.readFileSync(historyPath(agentId), 'utf8');
  } catch {
    return '';
  }
}
