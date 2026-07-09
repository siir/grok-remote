// Host filesystem browse helper for the new-session folder picker.
// Lists directories (not file contents) so the UI can choose a cwd.
// Paths are clamped under the security jail (default $HOME).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { clampBrowsePath, jailRoot, pathInsideRoot } from './security.js';

export interface BrowseEntry {
  name: string;
  path: string;
  type: 'directory';
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  home: string;
  entries: BrowseEntry[];
  error?: string;
}

/** Resolve a user-supplied path for browsing. Empty → home. Jailed. */
export function resolveBrowsePath(
  raw: unknown,
  home: string = os.homedir(),
  jail: string = jailRoot(),
): string {
  const { path: p } = clampBrowsePath(raw, home, jail);
  return p;
}

export function browseDirectory(
  rawPath: unknown,
  opts: {
    home?: string;
    jail?: string;
    readdir?: typeof fs.readdirSync;
    stat?: typeof fs.statSync;
  } = {},
): BrowseResult {
  const home = path.resolve(opts.home || os.homedir());
  const jail = opts.jail !== undefined ? opts.jail : jailRoot();
  const readdir = opts.readdir || fs.readdirSync;
  const stat = opts.stat || fs.statSync;
  const clamped = clampBrowsePath(rawPath, home, jail);
  const target = clamped.path;

  let parent = path.dirname(target) === target ? null : path.dirname(target);
  // Do not offer parent navigation outside the jail.
  if (parent && jail && !pathInsideRoot(jail, parent)) parent = null;

  if (clamped.error) {
    return { path: target, parent, home, entries: [], error: clamped.error };
  }

  let st: fs.Stats;
  try {
    st = stat(target);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path: target, parent, home, entries: [], error: msg };
  }
  if (!st.isDirectory()) {
    return { path: target, parent, home, entries: [], error: 'not a directory' };
  }

  let names: string[];
  try {
    names = readdir(target) as string[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path: target, parent, home, entries: [], error: msg };
  }

  const entries: BrowseEntry[] = [];
  for (const name of names) {
    if (!name || name === '.' || name === '..') continue;
    // Skip hidden by default in the picker (less noise). Dotfiles still
    // reachable by typing the path manually.
    if (name.startsWith('.')) continue;
    const full = path.join(target, name);
    if (jail && !pathInsideRoot(jail, full)) continue;
    try {
      const est = stat(full);
      if (est.isDirectory()) {
        entries.push({ name, path: full, type: 'directory' });
      }
    } catch {
      /* unreadable entry — skip */
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return { path: target, parent, home, entries };
}
