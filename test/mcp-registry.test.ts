import test from 'node:test';
import assert from 'node:assert/strict';

import { MCP_REGISTRY, MCP_CATEGORIES } from '../src/views/system/mcp-registry.js';

test('MCP registry has no duplicate slugs', () => {
  const slugs = MCP_REGISTRY.map(e => e.slug);
  assert.equal(new Set(slugs).size, slugs.length, `duplicate slugs: ${slugs.join(',')}`);
});

test('every MCP registry entry has the required text fields', () => {
  for (const e of MCP_REGISTRY) {
    assert.ok(e.name.trim().length, `missing name: ${JSON.stringify(e)}`);
    assert.ok(e.slug.trim().length, `missing slug: ${e.name}`);
    assert.ok(e.description.trim().length, `missing description: ${e.name}`);
    assert.ok(e.category.trim().length, `missing category: ${e.name}`);
  }
});

test('every MCP registry entry declares a coherent transport target', () => {
  for (const e of MCP_REGISTRY) {
    assert.ok(['stdio', 'http', 'sse'].includes(e.transport), `bad transport on ${e.name}: ${e.transport}`);
    if (e.transport === 'stdio') {
      assert.ok(typeof e.command === 'string' && e.command.length, `stdio entry ${e.name} is missing command`);
      assert.ok(Array.isArray(e.args), `stdio entry ${e.name} is missing args array`);
    } else {
      assert.ok(typeof e.url === 'string' && e.url.length, `${e.transport} entry ${e.name} is missing url`);
    }
  }
});

test('MCP registry slugs are URL-safe', () => {
  for (const e of MCP_REGISTRY) {
    assert.match(e.slug, /^[A-Za-z0-9_.-]+$/, `unsafe slug: ${e.slug}`);
  }
});

test('MCP registry categories are all declared', () => {
  const known = new Set(MCP_CATEGORIES);
  for (const e of MCP_REGISTRY) {
    assert.ok(known.has(e.category), `entry ${e.name} uses uncatalogued category ${e.category}`);
  }
});

test('MCP env hints have non-empty names when present', () => {
  for (const e of MCP_REGISTRY) {
    if (!Array.isArray(e.env)) continue;
    for (const v of e.env) {
      assert.ok(v.name.trim().length, `empty env name on ${e.name}`);
      assert.equal(typeof v.required, 'boolean', `env.required must be boolean on ${e.name}`);
    }
  }
});
