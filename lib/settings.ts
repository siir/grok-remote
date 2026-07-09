// Persist server-side settings under ~/.grok-remote/settings.json.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), '.grok-remote');
const FILE = path.join(ROOT, 'settings.json');

export interface Settings {
  defaultModel: string | null;
  defaultCwd:   string | null;
  autoApprove:  boolean;
  retentionDays: number;
  theme:        string;
  debug:        boolean;
  /**
   * After the control plane starts, reconnect agents that have a
   * lastSessionId (session/load). Default on — keeps fleet/phone sessions
   * warm across host restarts without requiring a new user message.
   */
  autoReconnectAgents: boolean;
  /**
   * Preferred "start at login" flag. OS install state is reported separately
   * via boot-autostart status; PATCH may enable/disable the LaunchAgent.
   */
  startOnLogin: boolean;
  [key: string]: unknown;
}

const DEFAULTS: Settings = {
  defaultModel: null,
  defaultCwd: null,
  autoApprove: true,
  retentionDays: 30,
  theme: 'dark',
  debug: false,
  autoReconnectAgents: true,
  startOnLogin: false,
};

function ensureRoot(): void {
  fs.mkdirSync(ROOT, { recursive: true });
}

export function load(): Settings {
  ensureRoot();
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function save(next: Partial<Settings>): Settings {
  ensureRoot();
  const merged: Settings = { ...load(), ...next };
  fs.writeFileSync(FILE, JSON.stringify(merged, null, 2));
  return merged;
}

export function paths(): { root: string; file: string } {
  return { root: ROOT, file: FILE };
}
