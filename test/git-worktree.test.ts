import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  isGitWorkTree,
  ensureNamedWorktree,
  resolveWorktreeCwd,
  worktreeDestPath,
  listRepoWorktrees,
} from '../lib/git-worktree.js';

function mkGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-wt-src-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README'), 'hi\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

test('isGitWorkTree detects repos', () => {
  const repo = mkGitRepo();
  assert.equal(isGitWorkTree(repo), true);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-wt-bare-'));
  assert.equal(isGitWorkTree(bare), false);
});

test('ensureNamedWorktree creates an isolated checkout', () => {
  const repo = mkGitRepo();
  const name = `t-${Date.now().toString(36)}`;
  const dest = ensureNamedWorktree(repo, name);
  assert.ok(fs.existsSync(dest));
  assert.equal(isGitWorkTree(dest), true);
  assert.notEqual(path.resolve(dest), path.resolve(repo));
  // Reuse existing
  const again = ensureNamedWorktree(repo, name);
  assert.equal(again, dest);
  // Cleanup
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', dest], { stdio: 'ignore' });
  } catch { /* ignore */ }
});

test('resolveWorktreeCwd accepts absolute existing path', () => {
  const repo = mkGitRepo();
  const out = resolveWorktreeCwd(repo, repo);
  assert.equal(out, path.resolve(repo));
});

test('resolveWorktreeCwd creates from name', () => {
  const repo = mkGitRepo();
  const name = `n-${Date.now().toString(36)}`;
  const out = resolveWorktreeCwd(repo, name);
  assert.ok(out);
  assert.equal(out, worktreeDestPath(repo, name));
  assert.equal(isGitWorkTree(out!), true);
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', out!], { stdio: 'ignore' });
  } catch { /* ignore */ }
});

test('ensureNamedWorktree rejects non-git source', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-wt-nogit-'));
  assert.throws(() => ensureNamedWorktree(bare, 'x'), /git repository/);
});

test('listRepoWorktrees includes main and linked worktrees', () => {
  const repo = mkGitRepo();
  const name = `list-${Date.now().toString(36)}`;
  const dest = ensureNamedWorktree(repo, name);
  const list = listRepoWorktrees(repo);
  assert.ok(list.length >= 2);
  const real = (p: string) => {
    try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); }
  };
  assert.ok(list.some((w) => w.isMain && real(w.path) === real(repo)));
  assert.ok(list.some((w) => real(w.path) === real(dest) && !w.isMain));
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', dest], { stdio: 'ignore' });
  } catch { /* ignore */ }
});

test('listRepoWorktrees returns empty for non-git', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-wt-list-'));
  assert.deepEqual(listRepoWorktrees(bare), []);
});
