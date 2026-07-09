import test from 'node:test';
import assert from 'node:assert/strict';

import { randomThreeWordName } from '../src/views/new-session-dialog.js';

test('randomThreeWordName returns three hyphen-separated words', () => {
  const name = randomThreeWordName();
  const parts = name.split('-');
  assert.equal(parts.length, 3);
  for (const p of parts) {
    assert.ok(p.length >= 3);
    assert.match(p, /^[a-z]+$/);
  }
});

test('randomThreeWordName is not constant across calls', () => {
  const set = new Set<string>();
  for (let i = 0; i < 20; i++) set.add(randomThreeWordName());
  // Extremely unlikely to collide 20 times on a 32^3 space.
  assert.ok(set.size >= 2);
});
