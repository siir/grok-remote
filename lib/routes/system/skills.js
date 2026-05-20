// Skills routes.
//
// Discovers grok skills from disk and exposes them to the dashboard.
// Doc reference: ~/.grok/docs/user-guide/08-skills.md.
//
// Skill discovery layers (priority order high → low):
//   <cwd>/.grok/skills/                     - local (current directory)
//   <repo-root>/.grok/skills/               - shared per repo
//   ~/.grok/skills/                         - user-wide
//   ~/.claude/skills/                       - Claude Code compatibility
//
// We don't dedupe across layers here; that's grok's job at runtime. We
// just report what's on disk so the dashboard can show the source of
// truth for each scope.
//
// SKILL.md frontmatter is a tiny YAML subset (name + description plus an
// optional metadata block). We parse it without a dep using a small line
// reader so we don't pull js-yaml in just for this.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { send } from '../helpers.js';

export function register(add) {
  add('GET', '/api/system/skills',         listHandler);
  add('GET', '/api/system/skills/read',    readHandler);
}

function listHandler(req, res) {
  const cwd = process.cwd();
  const home = os.homedir();
  const sources = [
    { scope: 'cwd',       dir: path.join(cwd, '.grok', 'skills') },
    { scope: 'repo',      dir: findRepoRoot(cwd) ? path.join(findRepoRoot(cwd), '.grok', 'skills') : null },
    { scope: 'user-grok', dir: path.join(home, '.grok', 'skills') },
    { scope: 'user-claude', dir: path.join(home, '.claude', 'skills') },
  ].filter(s => s.dir && safeIsDir(s.dir))
   // Dedupe same dir referenced twice (cwd === repo-root).
   .filter((s, i, arr) => arr.findIndex(x => path.resolve(x.dir) === path.resolve(s.dir)) === i);

  const skills = [];
  for (const { scope, dir } of sources) {
    for (const name of safeReaddir(dir)) {
      const skillDir = path.join(dir, name);
      try {
        if (!fs.statSync(skillDir).isDirectory()) continue;
      } catch { continue; }
      const mdPath = path.join(skillDir, 'SKILL.md');
      if (!safeIsFile(mdPath)) continue;
      const parsed = parseSkillHeader(mdPath);
      skills.push({
        scope,
        name,
        dir: skillDir,
        mdPath,
        title:         parsed.name || name,
        description:   parsed.description || '',
        shortDescription: parsed.shortDescription || '',
        otherFiles: safeReaddir(skillDir).filter(f => f !== 'SKILL.md'),
        mtime: safeMtime(mdPath),
      });
    }
  }
  send(res, 200, { ok: true, skills, sources: sources.map(s => ({ scope: s.scope, dir: s.dir })) });
}

function readHandler(req, res) {
  // body: ?path=<abs>. Only allowed if the resolved file is under one of
  // the known skill source directories — we don't let an arbitrary file
  // be read through this endpoint.
  const urlObj = new URL(req.url, 'http://x');
  const target = urlObj.searchParams.get('path') || '';
  if (!target) return send(res, 400, { ok: false, error: 'path required' });
  const resolved = path.resolve(target);

  const home = os.homedir();
  const allowedRoots = [
    path.resolve(process.cwd(), '.grok', 'skills'),
    findRepoRoot(process.cwd()) ? path.resolve(findRepoRoot(process.cwd()), '.grok', 'skills') : null,
    path.join(home, '.grok', 'skills'),
    path.join(home, '.claude', 'skills'),
  ].filter(Boolean);

  const allowed = allowedRoots.some(root => resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep));
  if (!allowed) return send(res, 400, { ok: false, error: 'path is outside any skill directory' });

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return send(res, 400, { ok: false, error: 'target is not a file' });
    if (stat.size > 1024 * 1024) return send(res, 413, { ok: false, error: 'file too large for inline read (>1MB)' });
    const content = fs.readFileSync(resolved, 'utf8');
    send(res, 200, { ok: true, path: resolved, size: stat.size, mtime: stat.mtime.toISOString(), content });
  } catch (err) {
    send(res, 404, { ok: false, error: err.message });
  }
}

// --- helpers ---

function findRepoRoot(start) {
  let cur = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function safeIsDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function safeIsFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function safeReaddir(p) { try { return fs.readdirSync(p); } catch { return []; } }
function safeMtime(p) { try { return fs.statSync(p).mtime.toISOString(); } catch { return null; } }

// Minimal SKILL.md frontmatter parser. We only need name + description (and
// metadata.short-description if present). Frontmatter looks like:
//
//   ---
//   name: foo
//   description: >
//     multi-line
//     wrapped lines
//   metadata:
//     short-description: "..."
//   ---
//
// We support folded scalars (`>` and `|`) and inline values. Quoted values
// have their outer quotes stripped.
function parseSkillHeader(mdPath) {
  let text = '';
  try { text = fs.readFileSync(mdPath, 'utf8'); }
  catch { return {}; }

  // Slice out frontmatter block. Must start with `---\n`.
  if (!text.startsWith('---')) return {};
  const after = text.indexOf('\n', 3);
  if (after === -1) return {};
  const end = text.indexOf('\n---', after);
  if (end === -1) return {};
  const fm = text.slice(after + 1, end);

  const lines = fm.split('\n');
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    let val = m[2].trim();

    if (key === 'metadata' && (val === '' || val === undefined)) {
      // Block: next indented lines are sub-keys we care about.
      i++;
      while (i < lines.length && /^\s+/.test(lines[i])) {
        const subm = lines[i].match(/^\s+([A-Za-z][\w-]*)\s*:\s*(.*)$/);
        if (subm) {
          const subKey = subm[1];
          let subVal = subm[2].trim();
          subVal = unquote(subVal);
          if (subKey === 'short-description') out.shortDescription = subVal;
        }
        i++;
      }
      continue;
    }

    if (val === '>' || val === '|') {
      // Folded / literal scalar. Indented continuation lines.
      const collected = [];
      i++;
      while (i < lines.length && /^\s+/.test(lines[i])) {
        collected.push(lines[i].replace(/^\s+/, ''));
        i++;
      }
      val = val === '>' ? collected.join(' ') : collected.join('\n');
    } else {
      val = unquote(val);
      i++;
    }

    if (key === 'name') out.name = val;
    else if (key === 'description') out.description = val;
  }
  return out;
}

function unquote(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
