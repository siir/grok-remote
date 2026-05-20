// MCP servers routes. Wraps `grok mcp` for the dashboard.
//
// Registered routes:
//   GET    /api/system/mcp                    -> list configured servers
//   POST   /api/system/mcp                    -> add or update a server
//   DELETE /api/system/mcp/:name              -> remove a server
//   GET    /api/system/mcp/:name/doctor       -> diagnose one server
//   GET    /api/system/mcp/doctor             -> diagnose all servers

import { send, readJsonBody } from '../helpers.js';
import { runGrokJson, runGrok, errorToResponse } from '../../grok-cli.js';

export function register(add) {
  add('GET',    '/api/system/mcp',                 listHandler);
  add('POST',   '/api/system/mcp',                 addHandler);
  add('DELETE', '/api/system/mcp/:name',           removeHandler);
  add('GET',    '/api/system/mcp/:name/doctor',    doctorOneHandler);
  add('GET',    '/api/system/mcp/doctor',          doctorAllHandler);
}

// Normalise whatever `grok mcp list --json` returns into an array. The CLI
// might emit an array, an object keyed by name, or null when empty.
function normalizeList(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    return Object.entries(json).map(([name, value]) => {
      if (value && typeof value === 'object') return { name, ...value };
      return { name, value };
    });
  }
  return [];
}

async function fetchList() {
  const json = await runGrokJson(['mcp', 'list', '--json']);
  return normalizeList(json);
}

async function listHandler(req, res) {
  try {
    const servers = await fetchList();
    send(res, 200, { ok: true, servers });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}

async function addHandler(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    send(res, 400, { ok: false, error: err?.message || 'invalid body' });
    return;
  }

  const name    = typeof body.name === 'string' ? body.name.trim() : '';
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  const url     = typeof body.url === 'string' ? body.url.trim() : '';
  const type    = typeof body.type === 'string' ? body.type.trim() : '';
  const args    = Array.isArray(body.args) ? body.args.filter(s => typeof s === 'string' && s.length) : [];
  const envIn   = body.env;

  if (!name) {
    send(res, 400, { ok: false, error: 'name is required' });
    return;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    send(res, 400, { ok: false, error: 'name must be alphanumeric (plus _ . -)' });
    return;
  }
  const hasCommand = command.length > 0;
  const hasUrl     = url.length > 0;
  if (hasCommand === hasUrl) {
    send(res, 400, { ok: false, error: 'provide exactly one of command or url' });
    return;
  }

  // env may arrive as { KEY: VALUE } or as an array of "KEY=VALUE" strings.
  const envPairs = [];
  if (Array.isArray(envIn)) {
    for (const item of envIn) {
      if (typeof item === 'string' && item.includes('=')) envPairs.push(item);
    }
  } else if (envIn && typeof envIn === 'object') {
    for (const [k, v] of Object.entries(envIn)) {
      if (typeof k === 'string' && k.length && v !== undefined && v !== null) {
        envPairs.push(`${k}=${String(v)}`);
      }
    }
  }

  const argv = ['mcp', 'add', name];
  if (hasCommand) {
    argv.push('--command', command);
    if (args.length) {
      argv.push('--args', ...args);
    }
    for (const pair of envPairs) {
      argv.push('--env', pair);
    }
  } else {
    argv.push('--url', url);
    if (type) argv.push('--type', type);
  }

  try {
    await runGrok(argv);
  } catch (err) {
    send(res, 500, errorToResponse(err));
    return;
  }

  try {
    const servers = await fetchList();
    send(res, 200, { ok: true, servers });
  } catch (err) {
    // Add succeeded but list failed. Still report 200 with a warning.
    send(res, 200, { ok: true, servers: [], warning: errorToResponse(err) });
  }
}

async function removeHandler(req, res, _url, params) {
  const name = params && params.name;
  if (!name) {
    send(res, 400, { ok: false, error: 'name is required' });
    return;
  }
  try {
    await runGrok(['mcp', 'remove', name]);
  } catch (err) {
    send(res, 500, errorToResponse(err));
    return;
  }
  try {
    const servers = await fetchList();
    send(res, 200, { ok: true, servers });
  } catch (err) {
    send(res, 200, { ok: true, servers: [], warning: errorToResponse(err) });
  }
}

async function doctorOneHandler(req, res, _url, params) {
  const name = params && params.name;
  if (!name) {
    send(res, 400, { ok: false, error: 'name is required' });
    return;
  }
  try {
    const result = await runGrokJson(['mcp', 'doctor', name, '--json']);
    send(res, 200, { ok: true, result });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}

async function doctorAllHandler(req, res) {
  try {
    const result = await runGrokJson(['mcp', 'doctor', '--json']);
    send(res, 200, { ok: true, result });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}
