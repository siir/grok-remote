// worktrees routes. See docs/worktree.md.
//
// Registered routes:
//   GET    /api/system/worktrees                  -> list (with ?all, ?repo, ?type)
//   GET    /api/system/worktrees/db/stats         -> db stats text
//   GET    /api/system/worktrees/db/path          -> db path text
//   POST   /api/system/worktrees/db/rebuild       -> rebuild index
//   POST   /api/system/worktrees/gc               -> garbage collect
//   GET    /api/system/worktrees/:id              -> show one (text)
//   DELETE /api/system/worktrees/:id              -> rm one
//
// All grok invocations go through lib/grok-cli.js.

import { send, readJsonBody } from '../helpers.js';
import { runGrok, runGrokJson, runGrokText, errorToResponse } from '../../grok-cli.js';

export function register(add) {
  add('GET',    '/api/system/worktrees',              handleList);
  // Literal db endpoints registered with exact paths so the dispatcher's
  // exact-key lookup wins over the `:id` parameterized pattern.
  add('GET',    '/api/system/worktrees/db/stats',     handleDbStats);
  add('GET',    '/api/system/worktrees/db/path',      handleDbPath);
  add('POST',   '/api/system/worktrees/db/rebuild',   handleDbRebuild);
  add('POST',   '/api/system/worktrees/gc',           handleGc);
  add('GET',    '/api/system/worktrees/:id',          handleShow);
  add('DELETE', '/api/system/worktrees/:id',          handleRm);
}

async function handleList(req, res, url) {
  const args = ['worktree', 'list', '--json'];
  const params = url && url.searchParams ? url.searchParams : new URLSearchParams();
  if (params.get('all') === '1') args.push('--all');
  const repo = params.get('repo');
  if (repo) args.push('--repo', repo);
  const type = params.get('type');
  if (type) args.push('--type', type);
  try {
    const data = await runGrokJson(args);
    send(res, 200, { ok: true, data });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleShow(req, res, _url, params) {
  const id = (params && params.id) || '';
  if (!isValidId(id)) {
    send(res, 400, { ok: false, error: 'invalid worktree id' });
    return;
  }
  try {
    const output = await runGrokText(['worktree', 'show', id]);
    send(res, 200, { ok: true, output });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleRm(req, res, url, params) {
  const id = (params && params.id) || '';
  if (!isValidId(id)) {
    send(res, 400, { ok: false, error: 'invalid worktree id' });
    return;
  }
  const q = url && url.searchParams ? url.searchParams : new URLSearchParams();
  const args = ['worktree', 'rm'];
  if (q.get('force') === '1') args.push('-f');
  if (q.get('dryRun') === '1') args.push('--dry-run');
  args.push(id);
  try {
    const output = await runGrokText(args);
    send(res, 200, { ok: true, output });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleGc(req, res) {
  let body = {};
  try { body = await readJsonBody(req); }
  catch (err) { send(res, 400, { ok: false, error: err.message }); return; }

  const args = ['worktree', 'gc'];
  if (body && body.dryRun) args.push('--dry-run');
  if (body && body.force) args.push('-f');
  if (body && typeof body.maxAge === 'string' && body.maxAge.trim()) {
    if (!/^[0-9a-zA-Z]+$/.test(body.maxAge.trim())) {
      send(res, 400, { ok: false, error: 'maxAge must be alphanumeric (e.g. 7d, 48h)' });
      return;
    }
    args.push('--max-age', body.maxAge.trim());
  }

  try {
    const output = await runGrokText(args);
    send(res, 200, { ok: true, output });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleDbStats(req, res) {
  try {
    const output = await runGrokText(['worktree', 'db', 'stats']);
    send(res, 200, { ok: true, output });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleDbPath(req, res) {
  try {
    const output = await runGrokText(['worktree', 'db', 'path']);
    send(res, 200, { ok: true, output: output.trim() });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleDbRebuild(req, res) {
  try {
    const output = await runGrokText(['worktree', 'db', 'rebuild']);
    send(res, 200, { ok: true, output });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

function isValidId(s) {
  // Worktree ids are alphanumeric / underscore / dash (e.g. wt_01H...).
  // Also allow absolute paths since show/rm accept either; but reject
  // anything with shell metacharacters.
  if (typeof s !== 'string' || !s.length) return false;
  if (/[\s;&|`$<>"'\\]/.test(s)) return false;
  return true;
}
