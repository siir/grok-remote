import test from 'node:test';
import assert from 'node:assert/strict';

import { sweepOnce } from '../lib/retention.js';

// Disabled-path coverage. The full sweep reads ~/.grok-remote/agents/ from
// disk, which we deliberately don't touch from tests. These cases lock in the
// safety contract: when retention is disabled (or misconfigured), sweepOnce
// MUST return zero counts and not touch the filesystem at all.

test('sweepOnce returns zero counts when called with no arguments', () => {
  assert.deepEqual(sweepOnce(), { scanned: 0, removed: 0, skipped: 0 });
});

test('sweepOnce returns zero counts when days is missing', () => {
  assert.deepEqual(sweepOnce({}), { scanned: 0, removed: 0, skipped: 0 });
});

test('sweepOnce returns zero counts when days is zero', () => {
  assert.deepEqual(sweepOnce({ days: 0 }), { scanned: 0, removed: 0, skipped: 0 });
});

test('sweepOnce returns zero counts when days is negative', () => {
  assert.deepEqual(sweepOnce({ days: -5 }), { scanned: 0, removed: 0, skipped: 0 });
});

test('sweepOnce returns zero counts when days is non-finite', () => {
  assert.deepEqual(sweepOnce({ days: NaN }), { scanned: 0, removed: 0, skipped: 0 });
  assert.deepEqual(sweepOnce({ days: Infinity }), { scanned: 0, removed: 0, skipped: 0 });
  // Stringly-typed config values from settings.json should also short-circuit
  // before any filesystem call.
  assert.deepEqual(sweepOnce({ days: 'soon' as unknown as number }), { scanned: 0, removed: 0, skipped: 0 });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepOnceAsync } from '../lib/retention.js';

test('sweepOnceAsync skips starred and archived agents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-ret-'));
  const old = new Date('2020-01-01T00:00:00.000Z');
  try {
    for (const [id, meta] of [
      ['old-plain', { lastSeen: '2020-01-01T00:00:00.000Z' }],
      ['starred', { starred: true, lastSeen: '2020-01-01T00:00:00.000Z' }],
      ['archived', { archived: true, lastSeen: '2020-01-01T00:00:00.000Z' }],
    ] as const) {
      const dir = path.join(root, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
      // activityMs uses dir/history mtime; force them into the past.
      fs.utimesSync(dir, old, old);
      fs.utimesSync(path.join(dir, 'meta.json'), old, old);
    }
    const r = await sweepOnceAsync({
      days: 30,
      agentsRoot: root,
      now: Date.parse('2026-07-09T00:00:00.000Z'),
    });
    assert.equal(r.scanned, 3);
    assert.equal(r.removed, 1);
    assert.equal(r.skipped, 2);
    assert.equal(fs.existsSync(path.join(root, 'old-plain')), false);
    assert.equal(fs.existsSync(path.join(root, 'starred')), true);
    assert.equal(fs.existsSync(path.join(root, 'archived')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
