// Agents (subagents) routes.
//
// Subagents are pre-defined worker profiles users can spawn from inside a
// conversation via the `Agent` tool. Each is a markdown file with YAML
// frontmatter (name, description, model, tools, ...) followed by the
// system prompt body. They live under:
//
//   <cwd>/.grok/agents/<name>.md         workspace scope
//   ~/.grok/agents/<name>.md             user scope
//
// Built-in subagents (e.g. general-purpose, explore, plan) live inside
// the grok binary and are read-only. This module only manages the .md
// files on disk; built-ins are listed via `grok inspect --json` and the
// dashboard never tries to edit them.
//
// Endpoints:
//   GET    /api/system/agents/read?path=...        read a single .md file.
//   PUT    /api/system/agents/content              write a .md file (atomic).
//   POST   /api/system/agents/file                 create a new .md file.
//   DELETE /api/system/agents/file?path=...        delete a user-scoped .md file.
//
// All write/delete endpoints validate that the resolved absolute path
// lives strictly inside one of the registered agent roots before
// touching the disk.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { send, readJsonBody } from '../helpers.js';

const MAX_FILE_BYTES = 1 * 1024 * 1024;

export function register(add) {
  add('GET',    '/api/system/agents/read',    readFileHandler);
  add('PUT',    '/api/system/agents/content', saveContentHandler);
  add('POST',   '/api/system/agents/file',    createFileHandler);
  add('DELETE', '/api/system/agents/file',    deleteFileHandler);
}

function workspaceRoot() {
  return path.join(process.cwd(), '.grok', 'agents');
}
function userRoot() {
  return path.join(os.homedir(), '.grok', 'agents');
}
function allRoots() {
  return [
    { scope: 'workspace', dir: workspaceRoot() },
    { scope: 'user',      dir: userRoot()      },
  ];
}
function rootForScope(scope) {
  const r = allRoots().find(x => x.scope === scope);
  return r ? r.dir : null;
}

function isUnderAnyRoot(resolved) {
  const roots = allRoots().map(r => path.resolve(r.dir));
  return roots.some(r => resolved === r || resolved.startsWith(r + path.sep));
}

function readFileHandler(req, res) {
  const urlObj = new URL(req.url, 'http://x');
  const target = urlObj.searchParams.get('path') || '';
  if (!target) return send(res, 400, { ok: false, error: 'path required' });
  const resolved = path.resolve(target);
  if (!isUnderAnyRoot(resolved)) {
    return send(res, 400, { ok: false, error: 'path is outside any agents root' });
  }
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) return send(res, 400, { ok: false, error: 'target is not a file' });
    if (st.size > MAX_FILE_BYTES) {
      return send(res, 413, { ok: false, error: 'file too large for inline read' });
    }
    const content = fs.readFileSync(resolved, 'utf8');
    send(res, 200, {
      ok: true,
      path: resolved,
      size: st.size,
      mtime: st.mtime.toISOString(),
      content,
    });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return send(res, 404, { ok: false, error: 'file not found' });
    }
    send(res, 500, { ok: false, error: err?.message || String(err) });
  }
}

async function saveContentHandler(req, res) {
  let body;
  try { body = await readJsonBody(req, MAX_FILE_BYTES); }
  catch (err) { return send(res, 400, { ok: false, error: err?.message || 'invalid body' }); }
  const target = typeof body.path === 'string' ? body.path : '';
  const content = body.content;
  if (!target) return send(res, 400, { ok: false, error: 'path required' });
  if (typeof content !== 'string') {
    return send(res, 400, { ok: false, error: 'content must be a string' });
  }
  const resolved = path.resolve(target);
  if (!isUnderAnyRoot(resolved)) {
    return send(res, 400, { ok: false, error: 'path is outside any agents root' });
  }
  if (!resolved.endsWith('.md')) {
    return send(res, 400, { ok: false, error: 'only .md files can be written' });
  }
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    atomicWrite(resolved, content);
    const st = fs.statSync(resolved);
    send(res, 200, {
      ok: true,
      path: resolved,
      size: st.size,
      mtime: st.mtime.toISOString(),
    });
  } catch (err) {
    send(res, 500, { ok: false, error: err?.message || String(err) });
  }
}

async function createFileHandler(req, res) {
  let body;
  try { body = await readJsonBody(req, MAX_FILE_BYTES); }
  catch (err) { return send(res, 400, { ok: false, error: err?.message || 'invalid body' }); }
  const scope = typeof body.scope === 'string' ? body.scope : '';
  const nameIn = typeof body.name === 'string' ? body.name : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (!scope || !nameIn) {
    return send(res, 400, { ok: false, error: 'scope and name required' });
  }
  const rootDir = rootForScope(scope);
  if (!rootDir) return send(res, 400, { ok: false, error: `unknown scope: ${scope}` });

  const name = nameIn.endsWith('.md') ? nameIn : (nameIn + '.md');
  if (!safeFileName(name)) {
    return send(res, 400, { ok: false, error: 'invalid name (use letters, digits, dash, underscore, dot)' });
  }
  const full = path.resolve(path.join(rootDir, name));
  if (!isUnderAnyRoot(full)) {
    return send(res, 400, { ok: false, error: 'resolved path is outside agents root' });
  }
  const stem = name.replace(/\.md$/, '');
  const finalContent = content || stubAgentBody(stem);
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full)) {
      return send(res, 409, { ok: false, error: 'file already exists' });
    }
    atomicWrite(full, finalContent);
    const st = fs.statSync(full);
    send(res, 200, {
      ok: true, scope, name, path: full,
      size: st.size, mtime: st.mtime.toISOString(),
    });
  } catch (err) {
    send(res, 500, { ok: false, error: err?.message || String(err) });
  }
}

async function deleteFileHandler(req, res) {
  const urlObj = new URL(req.url, 'http://x');
  const target = urlObj.searchParams.get('path') || '';
  if (!target) return send(res, 400, { ok: false, error: 'path required' });
  const resolved = path.resolve(target);
  if (!isUnderAnyRoot(resolved)) {
    return send(res, 400, { ok: false, error: 'path is outside any agents root' });
  }
  // Refuse the root itself.
  if (allRoots().some(r => path.resolve(r.dir) === resolved)) {
    return send(res, 400, { ok: false, error: 'cannot delete the agents root' });
  }
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) return send(res, 400, { ok: false, error: 'target is not a file' });
    fs.unlinkSync(resolved);
    send(res, 200, { ok: true, path: resolved });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return send(res, 404, { ok: false, error: 'file not found' });
    }
    send(res, 500, { ok: false, error: err?.message || String(err) });
  }
}

function atomicWrite(targetPath, content) {
  const tmp = targetPath + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, targetPath);
}

function safeFileName(name) {
  if (typeof name !== 'string') return false;
  if (!name) return false;
  if (name === '.' || name === '..') return false;
  if (name.startsWith('.')) return false;
  if (/[\/\\]/.test(name)) return false;
  if (name.length > 128) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name)) return false;
  return true;
}

function stubAgentBody(stem) {
  return [
    '---',
    `name: ${stem}`,
    `description: TODO describe what this subagent is for and when to use it.`,
    `model: inherit`,
    `tools: ["*"]`,
    '---',
    '',
    `You are a focused subagent named "${stem}".`,
    '',
    'Describe the subagent\'s job, the inputs it receives, and the format of',
    'its final reply. Keep this section tight; the parent agent only sees',
    'what you produce at the end.',
    '',
  ].join('\n');
}
