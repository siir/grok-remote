import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { _internal } from '../lib/routes/system/lsp.js';

test('buildLspBlock emits a well-formed [[lsp]] table', () => {
  const out = _internal.buildLspBlock({
    language: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    markers: ['package.json', 'tsconfig.json'],
    envEntries: [],
  });
  assert.match(out, /^\[\[lsp\]\]\n/);
  assert.match(out, /language = "typescript"/);
  assert.match(out, /command = "typescript-language-server"/);
  assert.match(out, /args = \["--stdio"\]/);
  assert.match(out, /root_markers = \["package\.json", "tsconfig\.json"\]/);
});

test('buildLspBlock omits args line when none are provided', () => {
  const out = _internal.buildLspBlock({
    language: 'rust',
    command: 'rust-analyzer',
    args: [],
    markers: ['Cargo.toml'],
    envEntries: [],
  });
  assert.doesNotMatch(out, /^args = /m);
  assert.match(out, /root_markers = \["Cargo\.toml"\]/);
});

test('buildLspBlock writes an [lsp.env] sub-table when env entries are present', () => {
  const out = _internal.buildLspBlock({
    language: 'go',
    command: 'gopls',
    args: [],
    markers: ['go.mod'],
    envEntries: [['GOPATH', '/home/user/go'], ['GOEXPERIMENT', 'rangefunc']],
  });
  assert.match(out, /\[lsp\.env\]/);
  assert.match(out, /GOPATH = "\/home\/user\/go"/);
  assert.match(out, /GOEXPERIMENT = "rangefunc"/);
});

test('buildLspBlock escapes backslashes and double quotes in string values', () => {
  const out = _internal.buildLspBlock({
    language: 'demo',
    command: 'c:\\bin\\demo.exe',
    args: ['--say', 'hi "there"'],
    markers: ['.demo'],
    envEntries: [],
  });
  assert.match(out, /command = "c:\\\\bin\\\\demo\.exe"/);
  assert.match(out, /args = \["--say", "hi \\"there\\""\]/);
});

test('appendBlock creates the parent directory and appends to fresh files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-route-'));
  const nested = path.join(tmpDir, 'sub', 'config.toml');
  const block = '[[lsp]]\nlanguage = "py"\n';
  _internal.appendBlock(nested, block);
  const content = fs.readFileSync(nested, 'utf8');
  assert.equal(content, block);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('appendBlock preserves existing TOML and adds a blank-line separator', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-route-'));
  const file = path.join(tmpDir, 'config.toml');
  fs.writeFileSync(file, '[ui]\ntheme = "dark"\n');
  _internal.appendBlock(file, '[[lsp]]\nlanguage = "py"\n');
  const content = fs.readFileSync(file, 'utf8');
  assert.equal(content, '[ui]\ntheme = "dark"\n\n[[lsp]]\nlanguage = "py"\n');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
