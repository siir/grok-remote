import test from 'node:test';
import assert from 'node:assert/strict';

import { LSP_REGISTRY } from '../src/views/system/lsp-registry.js';

test('LSP registry has no duplicate slugs', () => {
  const slugs = LSP_REGISTRY.map(e => e.slug);
  assert.equal(new Set(slugs).size, slugs.length, `duplicate slugs: ${slugs.join(',')}`);
});

test('every LSP registry entry has the required text fields', () => {
  for (const e of LSP_REGISTRY) {
    assert.ok(e.name.trim().length, `missing name: ${JSON.stringify(e)}`);
    assert.ok(e.slug.trim().length, `missing slug: ${e.name}`);
    assert.ok(e.description.trim().length, `missing description: ${e.name}`);
    assert.ok(e.language.trim().length, `missing language: ${e.name}`);
  }
});

test('every LSP registry entry has a command + args + root_markers', () => {
  for (const e of LSP_REGISTRY) {
    assert.ok(typeof e.command === 'string' && e.command.length, `missing command: ${e.name}`);
    assert.ok(Array.isArray(e.args), `args must be array on ${e.name}`);
    assert.ok(Array.isArray(e.root_markers) && e.root_markers.length, `${e.name} needs at least one root_marker`);
  }
});

test('LSP registry slugs are URL-safe', () => {
  for (const e of LSP_REGISTRY) {
    assert.match(e.slug, /^[A-Za-z0-9_.-]+$/, `unsafe slug: ${e.slug}`);
  }
});

test('LSP registry official flags are booleans', () => {
  for (const e of LSP_REGISTRY) {
    assert.equal(typeof e.official, 'boolean', `${e.name} official must be boolean`);
  }
});
