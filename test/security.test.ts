import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import {
  pathInsideRoot,
  clampBrowsePath,
  assertCwdAllowed,
  authorizeRequest,
  authorizeAdmin,
  isLoopbackAddress,
} from '../lib/security.js';
import type { IncomingMessage } from 'node:http';

test('pathInsideRoot accepts self and children', () => {
  const root = '/Users/me';
  assert.equal(pathInsideRoot(root, '/Users/me'), true);
  assert.equal(pathInsideRoot(root, '/Users/me/src'), true);
  assert.equal(pathInsideRoot(root, '/Users/other'), false);
  assert.equal(pathInsideRoot(root, '/Users/meevil'), false);
});

test('clampBrowsePath keeps targets under jail', () => {
  const home = '/Users/me';
  const jail = '/Users/me';
  assert.equal(clampBrowsePath('', home, jail).path, path.resolve(home));
  assert.equal(clampBrowsePath('/etc', home, jail).error?.includes('outside'), true);
  assert.equal(clampBrowsePath('/Users/me/Code', home, jail).path, path.resolve('/Users/me/Code'));
});

test('assertCwdAllowed accepts home dirs and rejects outside jail', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-cwd-'));
  try {
    const inside = path.join(tmp, 'proj');
    fs.mkdirSync(inside);
    assert.equal(assertCwdAllowed(inside, { jail: tmp }), path.resolve(inside));
    assert.throws(
      () => assertCwdAllowed('/etc', { jail: tmp }),
      /outside allowed jail/,
    );
    assert.throws(
      () => assertCwdAllowed(path.join(tmp, 'missing'), { jail: tmp }),
      /does not exist/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isLoopbackAddress recognizes v4 and v6', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('100.123.1.1'), false);
});

function fakeReq(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers,
  } as unknown as IncomingMessage;
}

test('authorizeRequest allows loopback without token', () => {
  const prev = process.env['GROK_REMOTE_TOKEN'];
  process.env['GROK_REMOTE_TOKEN'] = 'secret';
  try {
    const r = authorizeRequest(fakeReq('127.0.0.1'));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.via, 'loopback');
  } finally {
    if (prev === undefined) delete process.env['GROK_REMOTE_TOKEN'];
    else process.env['GROK_REMOTE_TOKEN'] = prev;
  }
});

test('authorizeRequest requires token on non-loopback when configured', () => {
  const prev = process.env['GROK_REMOTE_TOKEN'];
  process.env['GROK_REMOTE_TOKEN'] = 'secret';
  try {
    const deny = authorizeRequest(fakeReq('100.1.2.3'));
    assert.equal(deny.ok, false);
    const ok = authorizeRequest(fakeReq('100.1.2.3', { authorization: 'Bearer secret' }));
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.via, 'token');
  } finally {
    if (prev === undefined) delete process.env['GROK_REMOTE_TOKEN'];
    else process.env['GROK_REMOTE_TOKEN'] = prev;
  }
});

test('authorizeAdmin denies open non-loopback without token', () => {
  const prev = process.env['GROK_REMOTE_TOKEN'];
  delete process.env['GROK_REMOTE_TOKEN'];
  try {
    const r = authorizeAdmin(fakeReq('100.1.2.3'));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403);
  } finally {
    if (prev !== undefined) process.env['GROK_REMOTE_TOKEN'] = prev;
  }
});
