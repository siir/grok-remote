// Create / resolve git worktrees for agent spawn.
//
// `grok agent … stdio` ignores top-level `-w/--worktree` (the process stays in
// the source checkout, and session/new is also given that cwd). We materialize
// a real `git worktree` ourselves and point the agent cwd at it.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

function runGit(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function isGitWorkTree(dir: string): boolean {
  try {
    const out = runGit(['-C', dir, 'rev-parse', '--is-inside-work-tree']);
    return out === 'true';
  } catch {
    return false;
  }
}

/** Absolute path of the main checkout for a path inside a git worktree/repo. */
export function gitCommonTopLevel(dir: string): string | null {
  try {
    // --show-toplevel is the worktree root; for linked worktrees we want the
    // main tree when listing siblings, but for `worktree add` the cwd may be
    // any worktree of the same repo.
    const top = runGit(['-C', dir, 'rev-parse', '--show-toplevel']);
    return top || null;
  } catch {
    return null;
  }
}

export interface ListedWorktree {
  path: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  /** True for the primary checkout (first entry from `git worktree list`). */
  isMain: boolean;
  /** Short chip label. */
  label: string;
}

function branchShort(ref: string | null): string | null {
  if (!ref) return null;
  return ref.replace(/^refs\/heads\//, '');
}

function worktreeLabel(wtPath: string, branch: string | null, isMain: boolean, detached: boolean): string {
  const base = path.basename(wtPath);
  if (isMain) return branch ? `main · ${branch}` : 'main';
  if (branch) return `${base} · ${branch}`;
  if (detached) return `${base} · detached`;
  return base;
}

/**
 * List git worktrees for the repo that contains `cwd`.
 * Uses `git worktree list --porcelain` and also surfaces checkouts under
 * `~/.grok/worktrees/<repo>/` that belong to the same repo.
 */
export function listRepoWorktrees(cwd: string): ListedWorktree[] {
  const resolved = path.resolve(cwd);
  if (!isGitWorkTree(resolved)) return [];

  let porcelain = '';
  try {
    porcelain = runGit(['-C', resolved, 'worktree', 'list', '--porcelain']);
  } catch {
    return [];
  }

  const out: ListedWorktree[] = [];
  const seen = new Set<string>();
  let current: Partial<ListedWorktree> & { path?: string } = {};
  let first = true;

  const real = (p: string): string => {
    try { return fs.realpathSync(path.resolve(p)); }
    catch { return path.resolve(p); }
  };

  const flush = () => {
    if (!current.path) return;
    const abs = real(current.path);
    if (seen.has(abs)) return;
    seen.add(abs);
    const branch = branchShort(current.branch ?? null);
    const isMain = !!current.isMain || first;
    first = false;
    out.push({
      path: abs,
      branch,
      bare: !!current.bare,
      detached: !!current.detached,
      isMain,
      label: worktreeLabel(abs, branch, isMain, !!current.detached),
    });
    current = {};
  };

  for (const line of porcelain.split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      current.path = line.slice('worktree '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    }
  }
  flush();

  // Mark first porcelain entry as main if none flagged.
  if (out.length && !out.some((w) => w.isMain)) {
    out[0]!.isMain = true;
    out[0]!.label = worktreeLabel(out[0]!.path, out[0]!.branch, true, out[0]!.detached);
  }

  // Discover grok-remote-managed worktrees not yet listed (same common dir).
  try {
    const top = gitCommonTopLevel(resolved);
    if (top) {
      const repoName = path.basename(top);
      const managedRoot = path.join(os.homedir(), '.grok', 'worktrees', repoName);
      if (fs.existsSync(managedRoot)) {
        for (const name of fs.readdirSync(managedRoot)) {
          const p = real(path.join(managedRoot, name));
          if (seen.has(p)) continue;
          if (!isGitWorkTree(p)) continue;
          // Same repo? compare absolute git-common-dir.
          try {
            const a = runGit(['-C', top, 'rev-parse', '--git-common-dir']);
            const b = runGit(['-C', p, 'rev-parse', '--git-common-dir']);
            const aAbs = path.isAbsolute(a) ? path.resolve(a) : path.resolve(top, a);
            const bAbs = path.isAbsolute(b) ? path.resolve(b) : path.resolve(p, b);
            if (aAbs !== bAbs) continue;
          } catch {
            continue;
          }
          let branch: string | null = null;
          let detached = false;
          try {
            branch = runGit(['-C', p, 'branch', '--show-current']) || null;
            if (!branch) detached = true;
          } catch { /* ignore */ }
          seen.add(p);
          out.push({
            path: p,
            branch,
            bare: false,
            detached,
            isMain: false,
            label: worktreeLabel(p, branch, false, detached),
          });
        }
      }
    }
  } catch { /* ignore scan errors */ }

  return out;
}

function sanitizeName(name: string): string {
  const s = String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s || 'wt';
}

/**
 * Destination directory for a named worktree of `sourceCwd`'s repo.
 * Layout: ~/.grok/worktrees/<repoBasename>/<name>
 */
export function worktreeDestPath(sourceCwd: string, name: string): string {
  const safe = sanitizeName(name);
  const top = gitCommonTopLevel(sourceCwd) || path.resolve(sourceCwd);
  const repoName = path.basename(top) || 'repo';
  return path.join(os.homedir(), '.grok', 'worktrees', repoName, safe);
}

/**
 * Ensure a named worktree exists for the git repo at `sourceCwd`.
 * Returns the absolute path of the worktree checkout.
 */
export function ensureNamedWorktree(sourceCwd: string, name: string): string {
  const src = path.resolve(sourceCwd);
  if (!isGitWorkTree(src)) {
    throw new Error(
      `create worktree requires a git repository cwd (got ${src}). Pick the repo folder first, then enable create worktree.`,
    );
  }
  const dest = worktreeDestPath(src, name);
  if (fs.existsSync(dest)) {
    if (isGitWorkTree(dest)) return dest;
    throw new Error(`worktree path exists but is not a git checkout: ${dest}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const branch = `grok-wt/${sanitizeName(name)}`;
  // Prefer a new branch off HEAD. If the branch already exists, attach it;
  // if that fails too, detached HEAD is still an isolated tree.
  try {
    runGit(['-C', src, 'worktree', 'add', '-b', branch, dest, 'HEAD']);
  } catch {
    try {
      runGit(['-C', src, 'worktree', 'add', dest, branch]);
    } catch {
      runGit(['-C', src, 'worktree', 'add', '--detach', dest, 'HEAD']);
    }
  }
  return dest;
}

/**
 * Resolve a worktree setting into a concrete cwd.
 *  - absolute / ~/ path that exists → use as cwd (select existing)
 *  - name slug → create (or reuse) a named worktree under ~/.grok/worktrees
 * Returns null when setting is empty.
 */
export function resolveWorktreeCwd(
  sourceCwd: string,
  worktree: string | boolean | undefined | null,
): string | null {
  if (worktree === true) {
    // Unnamed auto worktree — generate a short slug.
    const slug = `auto-${Date.now().toString(36)}`;
    return ensureNamedWorktree(sourceCwd, slug);
  }
  if (typeof worktree !== 'string') return null;
  const raw = worktree.trim();
  if (!raw) return null;

  // Existing path (absolute or ~).
  if (raw.startsWith('~/') || raw === '~' || path.isAbsolute(raw)) {
    const expanded = raw.startsWith('~')
      ? path.join(os.homedir(), raw.slice(1).replace(/^\//, ''))
      : raw;
    const resolved = path.resolve(expanded);
    if (!fs.existsSync(resolved)) {
      throw new Error(`worktree path not found: ${resolved}`);
    }
    if (!isGitWorkTree(resolved)) {
      throw new Error(`path is not a git worktree/checkout: ${resolved}`);
    }
    return resolved;
  }

  // Name → create / reuse under ~/.grok/worktrees
  return ensureNamedWorktree(sourceCwd, raw);
}
