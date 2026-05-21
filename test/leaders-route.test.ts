import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeLeader, normalizeLeaderList } from '../lib/routes/system/leaders.js';

test('normalizeLeader maps pidFromLock to pid and keeps other fields', () => {
  const raw = {
    pidFromLock: 35461,
    classification: 'Reachable',
    socketPath: '/Users/dan/.grok/leader.sock',
    lockPath: '/Users/dan/.grok/leader.lock',
    wsUrlSuffix: '',
  };
  const n = normalizeLeader(raw);
  assert.ok(n);
  assert.equal(n!['pid'], 35461);
  assert.equal(n!['classification'], 'Reachable');
  assert.equal(n!['socketPath'], '/Users/dan/.grok/leader.sock');
  assert.equal(n!['lockPath'], '/Users/dan/.grok/leader.lock');
});

test('normalizeLeader prefers an explicit pid over pidFromLock', () => {
  const n = normalizeLeader({ pid: 42, pidFromLock: 99 });
  assert.ok(n);
  assert.equal(n!['pid'], 42);
});

test('normalizeLeader returns null when no pid is present', () => {
  assert.equal(normalizeLeader({}), null);
  assert.equal(normalizeLeader(null), null);
  assert.equal(normalizeLeader('nope'), null);
});

test('normalizeLeaderList unwraps the real grok-cli array shape', () => {
  // This is the actual JSON shape from `grok leader list --json` as of
  // grok 0.1.212. If grok ever changes it, the dashboard table goes blank
  // and we want this test to break.
  const raw = [
    {
      pidFromLock: 35461,
      classification: 'Reachable',
      socketPath: '/Users/dan/.grok/leader.sock',
      lockPath: '/Users/dan/.grok/leader.lock',
      wsUrlSuffix: '',
    },
  ];
  const rows = normalizeLeaderList(raw);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!['pid'], 35461);
});

test('normalizeLeaderList accepts a wrapped { leaders: [...] } shape', () => {
  const rows = normalizeLeaderList({ leaders: [{ pidFromLock: 1 }, { pidFromLock: 2 }] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!['pid'], 1);
  assert.equal(rows[1]!['pid'], 2);
});

test('normalizeLeaderList returns [] for null / non-array / empty input', () => {
  assert.deepEqual(normalizeLeaderList(null), []);
  assert.deepEqual(normalizeLeaderList([]), []);
  assert.deepEqual(normalizeLeaderList({ something: 'else' }), []);
});

test('normalizeLeaderList skips entries with no pid', () => {
  const rows = normalizeLeaderList([{ pidFromLock: 1 }, { classification: 'orphan' }, { pid: 3 }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!['pid'], 1);
  assert.equal(rows[1]!['pid'], 3);
});
