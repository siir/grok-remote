// Self-update orchestration for grok-remote.
//
// Backs the /api/version/* endpoints in server.js:
//   - readCurrentVersion(): snapshot of the running build (pkg version, git
//     HEAD sha, branch, dirty flag, dist/ mtime).
//   - readLatestVersion(): fetches origin/main and reports ahead/behind plus
//     the remote package.json version.
//   - runUpdate(): SSE-friendly state machine that pulls, optionally
//     installs deps, builds, then asks pm2 to restart this very process.
//
// Everything shells out via spawn (never execSync) so we can stream stderr
// and stdout into the SSE response. A single in-process lock prevents
// concurrent updates; the lock is released on completion OR failure.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// In-process re-entry lock. true while an update is mid-flight.
let updateInProgress = false;

export function isUpdateInProgress() {
  return updateInProgress;
}

// Run a one-shot command and return { code, stdout, stderr }. Never throws
// on a non-zero exit; the caller decides what counts as failure.
function runCapture(cmd, args, { cwd = ROOT, timeoutMs = 30_000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outChunks = [];
    const errChunks = [];
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on('data', (b) => outChunks.push(b));
    child.stderr.on('data', (b) => errChunks.push(b));
    child.on('error', (err) => {
      clearTimeout(t);
      resolve({ code: -1, stdout: '', stderr: String(err && err.message || err) });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8') + (timedOut ? '\n[timeout]\n' : ''),
      });
    });
  });
}

function readPkgVersion() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch { return '0.0.0'; }
}

function readDistBuiltAt() {
  // dist/ mtime is the closest we have to "when this binary was built".
  try {
    const st = fs.statSync(path.join(ROOT, 'dist'));
    return st.mtime.toISOString();
  } catch { return null; }
}

export async function readCurrentVersion() {
  const version = readPkgVersion();
  const builtAt = readDistBuiltAt();

  const sha    = await runCapture('git', ['rev-parse', 'HEAD'], { timeoutMs: 5000 });
  const branch = await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 });
  const dirty  = await runCapture('git', ['status', '--porcelain'], { timeoutMs: 5000 });

  return {
    ok: true,
    version,
    gitSha: sha.code === 0 ? sha.stdout.trim() : null,
    gitShaShort: sha.code === 0 ? sha.stdout.trim().slice(0, 7) : null,
    gitBranch: branch.code === 0 ? branch.stdout.trim() : null,
    gitDirty: dirty.code === 0 ? dirty.stdout.trim().length > 0 : null,
    builtAt,
  };
}

export async function readLatestVersion() {
  // Fetch quietly. Failing here is fine. We surface the error so the UI can
  // say "could not reach origin" instead of silently claiming up-to-date.
  const fetched = await runCapture('git', ['fetch', 'origin', 'main', '--quiet'], { timeoutMs: 20_000 });
  if (fetched.code !== 0) {
    return {
      ok: false,
      error: 'git fetch failed',
      detail: (fetched.stderr || fetched.stdout || '').trim().slice(0, 1000),
    };
  }

  const counts = await runCapture(
    'git', ['rev-list', '--left-right', '--count', 'HEAD...origin/main'],
    { timeoutMs: 5000 },
  );
  let ahead = 0, behind = 0;
  if (counts.code === 0) {
    const m = counts.stdout.trim().split(/\s+/);
    ahead  = parseInt(m[0] || '0', 10) || 0;
    behind = parseInt(m[1] || '0', 10) || 0;
  }

  const remoteSha = await runCapture('git', ['rev-parse', 'origin/main'], { timeoutMs: 5000 });
  const remotePkg = await runCapture('git', ['show', 'origin/main:package.json'], { timeoutMs: 5000 });
  let latestVersion = null;
  if (remotePkg.code === 0) {
    try {
      const parsed = JSON.parse(remotePkg.stdout);
      if (parsed && typeof parsed.version === 'string') latestVersion = parsed.version;
    } catch { /* ignore */ }
  }

  return {
    ok: true,
    ahead,
    behind,
    latestSha: remoteSha.code === 0 ? remoteSha.stdout.trim() : null,
    latestShaShort: remoteSha.code === 0 ? remoteSha.stdout.trim().slice(0, 7) : null,
    latestVersion,
    fetchedAt: new Date().toISOString(),
  };
}

// Stream a `git diff` to the caller. Used when the working tree is dirty
// so the modal can show the user what would block the update.
export async function readDiff() {
  const r = await runCapture('git', ['diff', '--stat', 'HEAD'], { timeoutMs: 10_000 });
  const full = await runCapture('git', ['diff', 'HEAD'], { timeoutMs: 10_000, env: { ...process.env, GIT_PAGER: 'cat' } });
  return {
    ok: r.code === 0,
    stat: r.stdout || '',
    diff: (full.stdout || '').slice(0, 200_000),
    truncated: (full.stdout || '').length > 200_000,
  };
}

// Stream every step of an update as SSE events on `emit`. Resolves when
// the pm2 restart command has been launched (the process may die mid-emit).
export async function runUpdate({ emit, restart = true } = {}) {
  if (updateInProgress) {
    throw Object.assign(new Error('update already in progress'), { code: 'IN_PROGRESS' });
  }
  updateInProgress = true;

  function step(name, status, detail) {
    try { emit({ step: name, status, detail }); } catch { /* socket may be gone */ }
  }

  // Stream a child process's stdout/stderr into emit as chunks under the
  // given step name. Resolves with the exit code. Each chunk gets its own
  // SSE event so the client can render a live log without buffering.
  function streamStep(name, cmd, args, opts = {}) {
    return new Promise((resolve) => {
      step(name, 'start', `$ ${cmd} ${args.join(' ')}`);
      const child = spawn(cmd, args, {
        cwd: opts.cwd || ROOT,
        env: opts.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let timer = null;
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          step(name, 'log', '[grok-remote] step timeout; killing.');
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
        }, opts.timeoutMs);
      }
      child.stdout.on('data', (b) => step(name, 'log', b.toString('utf8')));
      child.stderr.on('data', (b) => step(name, 'log', b.toString('utf8')));
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        step(name, 'fail', String(err && err.message || err));
        resolve(-1);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if ((code ?? -1) === 0) step(name, 'ok', `exit 0`);
        else step(name, 'fail', `exit ${code}`);
        resolve(code ?? -1);
      });
    });
  }

  try {
    // ── PREFLIGHT ───────────────────────────────────────────────────────
    step('preflight', 'start', 'checking repo state');

    const branch = await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 });
    if (branch.code !== 0) {
      step('preflight', 'fail', `git branch lookup failed: ${branch.stderr.trim()}`);
      return;
    }
    if (branch.stdout.trim() !== 'main') {
      step('preflight', 'fail', `refusing to self-update from branch "${branch.stdout.trim()}". switch to main first.`);
      return;
    }

    const dirty = await runCapture('git', ['status', '--porcelain'], { timeoutMs: 5000 });
    if (dirty.code !== 0) {
      step('preflight', 'fail', `git status failed: ${dirty.stderr.trim()}`);
      return;
    }
    if (dirty.stdout.trim().length > 0) {
      step('preflight', 'fail', 'working tree is dirty. commit or stash your changes, then retry.');
      step('preflight', 'log', dirty.stdout);
      return;
    }
    step('preflight', 'ok', 'clean working tree on main');

    // ── FETCH ──────────────────────────────────────────────────────────
    const fetchCode = await streamStep('fetch', 'git', ['fetch', 'origin', 'main', '--quiet'], { timeoutMs: 60_000 });
    if (fetchCode !== 0) return;

    // Recompute behind to decide whether there's anything to pull.
    const counts = await runCapture('git', ['rev-list', '--left-right', '--count', 'HEAD...origin/main'], { timeoutMs: 5000 });
    const behind = counts.code === 0 ? (parseInt(counts.stdout.trim().split(/\s+/)[1] || '0', 10) || 0) : 0;
    if (behind === 0) {
      step('fetch', 'log', 'already up to date.');
      step('preflight', 'log', 'no commits to pull. exiting without restart.');
      step('done', 'ok', 'no update needed');
      return;
    }

    // Capture pre-pull HEAD so we can diff lockfiles after.
    const preSha = await runCapture('git', ['rev-parse', 'HEAD'], { timeoutMs: 5000 });
    const preHead = preSha.code === 0 ? preSha.stdout.trim() : null;

    // ── PULL ───────────────────────────────────────────────────────────
    // --ff-only refuses if the pull would create a merge commit. That's
    // exactly what we want: refuse and tell the user to resolve manually.
    const pullCode = await streamStep('pull', 'git', ['pull', '--ff-only', 'origin', 'main'], { timeoutMs: 60_000 });
    if (pullCode !== 0) {
      step('pull', 'log', 'fast-forward refused. the local branch likely diverged. resolve manually then retry.');
      return;
    }

    // ── INSTALL (conditional) ──────────────────────────────────────────
    let depsChanged = false;
    if (preHead) {
      const diff = await runCapture('git', ['diff', '--name-only', `${preHead}..HEAD`], { timeoutMs: 5000 });
      if (diff.code === 0) {
        depsChanged = /(^|\n)(package\.json|package-lock\.json)\b/.test(diff.stdout);
      }
    }
    if (depsChanged) {
      const installCode = await streamStep('install', 'npm', ['install', '--no-audit', '--no-fund'], { timeoutMs: 5 * 60_000 });
      if (installCode !== 0) return;
    } else {
      step('install', 'skip', 'package.json and package-lock.json unchanged; skipping npm install.');
    }

    // ── BUILD ──────────────────────────────────────────────────────────
    const buildCode = await streamStep('build', 'npm', ['run', 'build'], { timeoutMs: 5 * 60_000 });
    if (buildCode !== 0) return;

    // ── RESTART ────────────────────────────────────────────────────────
    // pm2 restart will kill THIS process. The SSE connection dies; the
    // frontend polls /api/health until the new instance answers.
    step('restart', 'start', 'asking pm2 to restart grok-remote');
    if (!restart) {
      step('restart', 'skip', 'restart=false; not restarting.');
      step('done', 'ok', 'update applied; restart was skipped.');
      return;
    }

    // Spawn detached so the kill propagates cleanly even after we exit.
    const restartChild = spawn('pm2', ['restart', 'grok-remote', '--update-env'], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    restartChild.stdout.on('data', (b) => step('restart', 'log', b.toString('utf8')));
    restartChild.stderr.on('data', (b) => step('restart', 'log', b.toString('utf8')));
    restartChild.on('error', (err) => {
      step('restart', 'fail', `pm2 spawn failed: ${err.message}`);
    });
    restartChild.unref();
    // We deliberately do not await the pm2 child: the SSE writer should
    // flush the "start" event before pm2 SIGTERMs us a moment later.
  } finally {
    updateInProgress = false;
  }
}
