// Persist server-side settings under ~/.grok-remote/settings.json.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), '.grok-remote');
const FILE = path.join(ROOT, 'settings.json');

const DEFAULTS = {
  defaultModel: null,
  defaultCwd: null,
  autoApprove: true,
  retentionDays: 30,
  theme: 'dark',
};

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true });
}

export function load() {
  ensureRoot();
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function save(next) {
  ensureRoot();
  const merged = { ...load(), ...next };
  fs.writeFileSync(FILE, JSON.stringify(merged, null, 2));
  return merged;
}

export function paths() {
  return { root: ROOT, file: FILE };
}
