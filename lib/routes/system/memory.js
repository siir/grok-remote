// Memory routes. Surfaces the workspace + global MEMORY.md files and the
// `grok memory clear` action. See docs/memory.md.
//
// There is no `grok memory list`, so we read the file metadata directly
// with node fs. The clear action goes through the CLI so we get its
// confirmation handling and consistent error messages.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { send, readJsonBody } from '../helpers.js';
import { runGrok, errorToResponse } from '../../grok-cli.js';

export function register(add) {
  add('GET',  '/api/system/memory',       getHandler);
  add('POST', '/api/system/memory/clear', clearHandler);
}

function globalPath() {
  return path.join(os.homedir(), '.grok', 'memory', 'MEMORY.md');
}

function workspacePath() {
  return path.join(process.cwd(), '.grok', 'memory', 'MEMORY.md');
}

async function statBlock(p) {
  try {
    const st = await fs.stat(p);
    return {
      path:   p,
      exists: true,
      size:   st.size,
      mtime:  st.mtime.toISOString(),
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { path: p, exists: false, size: 0, mtime: null };
    }
    return { path: p, exists: false, size: 0, mtime: null, error: err?.message || String(err) };
  }
}

async function readAll() {
  const [global, workspace] = await Promise.all([
    statBlock(globalPath()),
    statBlock(workspacePath()),
  ]);
  return { global, workspace };
}

async function getHandler(req, res) {
  try {
    const data = await readAll();
    send(res, 200, { ok: true, ...data });
  } catch (err) {
    send(res, 500, { ok: false, error: err?.message || String(err) });
  }
}

async function clearHandler(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    send(res, 400, { ok: false, error: err?.message || 'invalid body' });
    return;
  }

  const scope = typeof body.scope === 'string' ? body.scope : '';
  let scopeFlag = null;
  if (scope === 'workspace') scopeFlag = '--workspace';
  else if (scope === 'global') scopeFlag = '--global';
  else if (scope === 'all') scopeFlag = '--all';
  else {
    send(res, 400, { ok: false, error: 'scope must be one of workspace, global, all' });
    return;
  }

  try {
    await runGrok(['memory', 'clear', scopeFlag, '-y']);
  } catch (err) {
    send(res, 500, errorToResponse(err));
    return;
  }

  try {
    const data = await readAll();
    send(res, 200, { ok: true, ...data });
  } catch (err) {
    // Clear succeeded but the follow-up stat failed.
    send(res, 200, { ok: true, warning: err?.message || String(err) });
  }
}
