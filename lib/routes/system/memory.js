// Memory routes. Surfaces grok's MEMORY.md files plus any sibling markdown
// notes in each memory root. See docs/memory.md.
//
// Memory roots (scopes), priority high to low:
//   workspace   <cwd>/.grok/memory                  (per project)
//   global      ~/.grok/memory                      (user-wide)
//
// Inside each root we list `.md` files in the top level only. Subdirectories
// (e.g. per-session caches under ~/.grok/memory) are ignored so the dashboard
// stays focused on hand-edited memory. MEMORY.md is always first if present.
//
// Endpoints:
//   GET    /api/system/memory                    structured listing (back-compat
//                                                with the prior shape: still
//                                                returns `workspace` + `global`
//                                                blocks for MEMORY.md).
//   POST   /api/system/memory/clear              clear the whole scope via the
//                                                grok CLI (unchanged behavior).
//   PUT    /api/system/memory/content            write a file's content
//                                                atomically. Path must resolve
//                                                inside a registered root.
//   POST   /api/system/memory/file               create a new file in a scope.
//   DELETE /api/system/memory/file?path=...      delete a file from a scope.
//
// All write/delete endpoints validate that the resolved absolute path lives
// under one of the registered memory roots before touching the disk.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { send, readJsonBody } from '../helpers.js';
import { runGrok, errorToResponse } from '../../grok-cli.js';

const SNIPPET_BYTES = 240;
const MAX_FILE_BYTES = 4 * 1024 * 1024; // hard cap for writes

export function register(add) {
  add('GET',    '/api/system/memory',         getHandler);
  add('GET',    '/api/system/memory/read',    readFileHandler);
  add('POST',   '/api/system/memory/clear',   clearHandler);
  add('PUT',    '/api/system/memory/content', saveContentHandler);
  add('POST',   '/api/system/memory/file',    createFileHandler);
  add('DELETE', '/api/system/memory/file',    deleteFileHandler);
}

// ---------- scope resolution ----------

function workspaceRoot() {
  return path.join(process.cwd(), '.grok', 'memory');
}

function globalRoot() {
  return path.join(os.homedir(), '.grok', 'memory');
}

// Returns the canonical list of memory roots. Both are always present in the
// list even if the directory hasn't been created yet (so the UI can offer
// "+ new" there and we'll mkdir on demand).
function allRoots() {
  return [
    { scope: 'workspace', dir: workspaceRoot() },
    { scope: 'global',    dir: globalRoot()    },
  ];
}

function rootForScope(scope) {
  const r = allRoots().find(x => x.scope === scope);
  return r ? r.dir : null;
}

// Path-safety check: an absolute resolved path must equal a root or live
// strictly under it (using path.sep so /foo/bar.archive does NOT match /foo).
function isUnderAnyRoot(resolved) {
  const roots = allRoots().map(r => path.resolve(r.dir));
  return roots.some(r => resolved === r || resolved.startsWith(r + path.sep));
}

// ---------- listing ----------

async function getHandler(req, res) {
  try {
    const roots = await Promise.all(allRoots().map(buildRootListing));
    // Back-compat: surface the MEMORY.md stat block at top-level keys so any
    // older clients that read `data.workspace` / `data.global` keep working.
    const compat = {};
    for (const r of roots) {
      compat[r.scope] = compatBlock(r);
    }
    send(res, 200, { ok: true, roots, ...compat });
  } catch (err) {
    send(res, 500, { ok: false, error: err?.message || String(err) });
  }
}

async function buildRootListing(root) {
  const out = {
    scope:   root.scope,
    dir:     root.dir,
    exists:  false,
    files:   [],
  };
  let entries;
  try {
    entries = await fsp.readdir(root.dir, { withFileTypes: true });
    out.exists = true;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return out;
    }
    out.error = err?.message || String(err);
    return out;
  }
  const fileEntries = entries.filter(e => e.isFile() && e.name.endsWith('.md'));
  const records = await Promise.all(fileEntries.map(async (e) => {
    const full = path.join(root.dir, e.name);
    return readFileMeta(full, e.name);
  }));
  // MEMORY.md first, then alpha.
  records.sort((a, b) => {
    if (a.name === 'MEMORY.md' && b.name !== 'MEMORY.md') return -1;
    if (b.name === 'MEMORY.md' && a.name !== 'MEMORY.md') return 1;
    return a.name.localeCompare(b.name);
  });
  out.files = records;
  return out;
}

async function readFileMeta(full, name) {
  const rec = { path: full, name, size: 0, mtimeMs: 0, snippet: '' };
  try {
    const st = await fsp.stat(full);
    rec.size    = st.size;
    rec.mtimeMs = st.mtimeMs;
    rec.mtime   = st.mtime.toISOString();
    // Read a short prefix for the snippet. We bound this so a huge memory
    // file doesn't slow the listing.
    if (st.size > 0) {
      const fh = await fsp.open(full, 'r');
      try {
        const buf = Buffer.alloc(Math.min(SNIPPET_BYTES, st.size));
        await fh.read(buf, 0, buf.length, 0);
        rec.snippet = buf.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 200);
      } finally {
        await fh.close().catch(() => {});
      }
    }
  } catch (err) {
    rec.error = err?.message || String(err);
  }
  return rec;
}

// Reduce a root listing back to the old `{ path, exists, size, mtime }` shape
// for the canonical MEMORY.md inside it. If the dir or MEMORY.md is missing
// we still report the expected path so existing callers can show it.
function compatBlock(root) {
  const mdPath = path.join(root.dir, 'MEMORY.md');
  const rec = (root.files || []).find(f => f.name === 'MEMORY.md');
  if (!rec) {
    return { path: mdPath, exists: false, size: 0, mtime: null };
  }
  return {
    path:   rec.path,
    exists: true,
    size:   rec.size,
    mtime:  rec.mtime || null,
  };
}

// ---------- read one file ----------

function readFileHandler(req, res) {
  const urlObj = new URL(req.url, 'http://x');
  const target = urlObj.searchParams.get('path') || '';
  if (!target) return send(res, 400, { ok: false, error: 'path required' });
  const resolved = path.resolve(target);
  if (!isUnderAnyRoot(resolved)) {
    return send(res, 400, { ok: false, error: 'path is outside any memory root' });
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

// ---------- clear (unchanged) ----------

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
    const roots = await Promise.all(allRoots().map(buildRootListing));
    const compat = {};
    for (const r of roots) compat[r.scope] = compatBlock(r);
    send(res, 200, { ok: true, roots, ...compat });
  } catch (err) {
    send(res, 200, { ok: true, warning: err?.message || String(err) });
  }
}

// ---------- save content ----------

async function saveContentHandler(req, res) {
  let body;
  try {
    body = await readJsonBody(req, MAX_FILE_BYTES);
  } catch (err) {
    return send(res, 400, { ok: false, error: err?.message || 'invalid body' });
  }
  const target = typeof body.path === 'string' ? body.path : '';
  const content = body.content;
  if (!target) return send(res, 400, { ok: false, error: 'path required' });
  if (typeof content !== 'string') {
    return send(res, 400, { ok: false, error: 'content must be a string' });
  }
  const resolved = path.resolve(target);
  if (!isUnderAnyRoot(resolved)) {
    return send(res, 400, { ok: false, error: 'path is outside any memory root' });
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

function atomicWrite(targetPath, content) {
  const tmp = targetPath + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, targetPath);
}

// ---------- create file ----------

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

  // Normalize: kebab-case-or-dotted, must end with .md (add it if missing).
  const name = nameIn.endsWith('.md') ? nameIn : (nameIn + '.md');
  if (!safeFileName(name)) {
    return send(res, 400, { ok: false, error: 'invalid name (kebab-case .md only)' });
  }

  const full = path.resolve(path.join(rootDir, name));
  if (!isUnderAnyRoot(full)) {
    return send(res, 400, { ok: false, error: 'resolved path is outside the memory root' });
  }
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full)) {
      return send(res, 409, { ok: false, error: 'file already exists' });
    }
    atomicWrite(full, content);
    const st = fs.statSync(full);
    send(res, 200, {
      ok: true,
      scope,
      path: full,
      name,
      size: st.size,
      mtime: st.mtime.toISOString(),
    });
  } catch (err) {
    send(res, 500, { ok: false, error: err?.message || String(err) });
  }
}

// ---------- delete file ----------

async function deleteFileHandler(req, res) {
  const urlObj = new URL(req.url, 'http://x');
  const target = urlObj.searchParams.get('path') || '';
  if (!target) return send(res, 400, { ok: false, error: 'path required' });
  const resolved = path.resolve(target);
  if (!isUnderAnyRoot(resolved)) {
    return send(res, 400, { ok: false, error: 'path is outside any memory root' });
  }
  // Refuse to delete the root dir itself.
  if (allRoots().some(r => path.resolve(r.dir) === resolved)) {
    return send(res, 400, { ok: false, error: 'cannot delete the memory root' });
  }
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) {
      return send(res, 400, { ok: false, error: 'target is not a file' });
    }
    fs.unlinkSync(resolved);
    send(res, 200, { ok: true, path: resolved });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return send(res, 404, { ok: false, error: 'file not found' });
    }
    send(res, 500, { ok: false, error: err?.message || String(err) });
  }
}

// ---------- helpers ----------

// Reject anything that could escape the parent (slashes, ..) or start with a
// dot. Allows MEMORY.md plus kebab/underscore/digit/dot filenames.
function safeFileName(name) {
  if (typeof name !== 'string') return false;
  if (!name) return false;
  if (name === '.' || name === '..') return false;
  if (name.startsWith('.')) return false;
  if (/[\/\\]/.test(name)) return false;
  if (name.length > 200) return false;
  // Allow letters, digits, dot, dash, underscore. Must end with .md.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name)) return false;
  return true;
}
