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
