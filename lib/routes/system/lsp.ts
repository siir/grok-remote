// LSP servers routes. Today we just expose a POST that appends a [[lsp]]
// block to ~/.grok/config.toml. Reads still flow through the existing
// inspect-based pipeline used by the LSP page.

import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { send, readJsonBody } from '../helpers.js';
import type { RouteRegistrar } from '../system.js';

const CONFIG_PATH = path.join(os.homedir(), '.grok', 'config.toml');

export function register(add: RouteRegistrar): void {
  add('POST', '/api/system/lsp/add', addHandler);
}

interface AddBody {
  language?: unknown;
  command?: unknown;
  args?: unknown;
  root_markers?: unknown;
  rootMarkers?: unknown;
  env?: unknown;
}

async function addHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: AddBody;
  try {
    body = (await readJsonBody(req)) as AddBody;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid body';
    send(res, 400, { ok: false, error: msg });
    return;
  }

  const language = typeof body.language === 'string' ? body.language.trim() : '';
  const command  = typeof body.command  === 'string' ? body.command.trim()  : '';
  const args: string[] = Array.isArray(body.args)
    ? (body.args as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const markersRaw = body.root_markers ?? body.rootMarkers;
  const markers: string[] = Array.isArray(markersRaw)
    ? (markersRaw as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
  const envEntries: Array<[string, string]> = [];
  if (body.env && typeof body.env === 'object' && !Array.isArray(body.env)) {
    for (const [k, v] of Object.entries(body.env as Record<string, unknown>)) {
      if (typeof k === 'string' && k.length && v !== undefined && v !== null) {
        envEntries.push([k, String(v)]);
      }
    }
  }

  if (!language) {
    send(res, 400, { ok: false, error: 'language is required' });
    return;
  }
  if (!/^[A-Za-z0-9_.\-]+$/.test(language)) {
    send(res, 400, { ok: false, error: 'language must be alphanumeric (plus _ . -)' });
    return;
  }
  if (!command) {
    send(res, 400, { ok: false, error: 'command is required' });
    return;
  }
  if (!markers.length) {
    send(res, 400, { ok: false, error: 'at least one root_marker is required' });
    return;
  }

  const block = buildLspBlock({ language, command, args, markers, envEntries });

  try {
    appendBlock(CONFIG_PATH, block);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: `failed to write ${CONFIG_PATH}: ${msg}` });
    return;
  }

  send(res, 200, { ok: true, configPath: CONFIG_PATH, block });
}

interface BuildLspArgs {
  language: string;
  command: string;
  args: string[];
  markers: string[];
  envEntries: Array<[string, string]>;
}

function buildLspBlock({ language, command, args, markers, envEntries }: BuildLspArgs): string {
  const lines: string[] = ['[[lsp]]'];
  lines.push(`language = ${q(language)}`);
  lines.push(`command = ${q(command)}`);
  if (args.length) lines.push(`args = [${args.map(q).join(', ')}]`);
  lines.push(`root_markers = [${markers.map(q).join(', ')}]`);
  if (envEntries.length) {
    lines.push('[lsp.env]');
    for (const [k, v] of envEntries) lines.push(`${k} = ${q(v)}`);
  }
  return lines.join('\n') + '\n';
}

function q(s: string): string {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function appendBlock(filePath: string, block: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let next = existing;
  if (next.length && !next.endsWith('\n')) next += '\n';
  if (next.length) next += '\n';
  next += block;

  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, filePath);
}

export const _internal = { buildLspBlock, appendBlock, CONFIG_PATH };
