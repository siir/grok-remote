import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveBrowsePath, browseDirectory } from '../lib/fs-browse.js';

test('resolveBrowsePath: empty and ~ go to home', () => {
  const home = '/Users/chad';
  const jail = home;
  assert.equal(resolveBrowsePath('', home, jail), home);
  assert.equal(resolveBrowsePath(null, home, jail), home);
  assert.equal(resolveBrowsePath('~', home, jail), home);
  assert.equal(resolveBrowsePath('~/src', home, jail), path.resolve(home, 'src'));
});

test('resolveBrowsePath: absolute under jail resolves; outside clamps', () => {
  const home = '/Users/chad';
  const jail = home;
  assert.equal(resolveBrowsePath('/Users/chad/work', home, jail), path.resolve('/Users/chad/work'));
  // Outside jail → clamp to jail root
  assert.equal(resolveBrowsePath('/tmp/work', home, jail), path.resolve(jail));
});

test('browseDirectory lists only non-hidden directories', () => {
  const tree: Record<string, string[]> = {
    '/home/u': ['Projects', 'notes.txt', '.secret', 'docs'],
    '/home/u/Projects': [],
    '/home/u/docs': [],
  };
  const dirs = new Set(['/home/u', '/home/u/Projects', '/home/u/docs']);
  const readdir = ((p: string) => {
    if (!(p in tree)) throw new Error('ENOENT');
    return tree[p];
  }) as typeof import('node:fs').readdirSync;
  const stat = ((p: string) => {
    if (p.endsWith('notes.txt') || p.endsWith('.secret')) {
      return { isDirectory: () => false } as import('node:fs').Stats;
    }
    if (dirs.has(p)) return { isDirectory: () => true } as import('node:fs').Stats;
    const base = path.basename(p);
    if (base === 'notes.txt' || base === '.secret') {
      return { isDirectory: () => false } as import('node:fs').Stats;
    }
    if (base === 'Projects' || base === 'docs') {
      return { isDirectory: () => true } as import('node:fs').Stats;
    }
    throw new Error('ENOENT ' + p);
  }) as typeof import('node:fs').statSync;

  const result = browseDirectory('/home/u', { home: '/home/u', jail: '/home/u', readdir, stat });
  assert.equal(result.error, undefined);
  assert.equal(result.path, '/home/u');
  assert.deepEqual(result.entries.map((e) => e.name), ['docs', 'Projects'].sort((a, b) => a.localeCompare(b)));
  assert.ok(result.entries.every((e) => e.type === 'directory'));
});

test('browseDirectory returns error for missing path', () => {
  const readdir = (() => { throw new Error('ENOENT'); }) as typeof import('node:fs').readdirSync;
  const stat = (() => { throw new Error('ENOENT: no such file'); }) as typeof import('node:fs').statSync;
  const result = browseDirectory('/home/u/nope', {
    home: '/home/u',
    jail: '/home/u',
    readdir,
    stat,
  });
  assert.ok(result.error);
  assert.equal(result.entries.length, 0);
});

test('browseDirectory rejects paths outside jail', () => {
  const result = browseDirectory('/etc', { home: '/home/u', jail: '/home/u' });
  assert.ok(result.error);
  assert.match(result.error || '', /outside allowed jail/);
});
