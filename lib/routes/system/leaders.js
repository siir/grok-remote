// leaders routes. See docs/leader.md.
//
// Registered routes:
//   GET    /api/system/leaders                          -> list leaders
//   GET    /api/system/leaders/:pid                     -> info for one leader
//   POST   /api/system/leaders/kill                     -> kill all leaders
//   GET    /api/system/leaders/:pid/profile/status      -> profile status (text)
//   POST   /api/system/leaders/:pid/profile/start       -> start profiling
//   POST   /api/system/leaders/:pid/profile/stop        -> stop profiling
//
// All grok invocations go through lib/grok-cli.js.

import os from 'node:os';
import path from 'node:path';
import { send, readJsonBody } from '../helpers.js';
import { runGrok, runGrokJson, runGrokText, errorToResponse } from '../../grok-cli.js';

export function register(add) {
  add('GET',  '/api/system/leaders',                       handleList);
  add('POST', '/api/system/leaders/kill',                  handleKill);
  add('GET',  '/api/system/leaders/:pid',                  handleInfo);
  add('GET',  '/api/system/leaders/:pid/profile/status',   handleProfileStatus);
  add('POST', '/api/system/leaders/:pid/profile/start',    handleProfileStart);
  add('POST', '/api/system/leaders/:pid/profile/stop',     handleProfileStop);
}

async function handleList(req, res) {
  try {
    const data = await runGrokJson(['leader', 'list', '--json']);
    send(res, 200, { ok: true, data });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleInfo(req, res, _url, params) {
  const pid = (params && params.pid) || '';
  if (!isValidPid(pid)) {
    send(res, 400, { ok: false, error: 'invalid pid' });
    return;
  }
  try {
    const data = await runGrokJson(['leader', 'info', '--pid', pid, '--json']);
    send(res, 200, { ok: true, data });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleKill(req, res) {
  try {
    await runGrok(['leader', 'kill']);
    send(res, 200, { ok: true });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleProfileStatus(req, res, _url, params) {
  const pid = (params && params.pid) || '';
  if (!isValidPid(pid)) {
    send(res, 400, { ok: false, error: 'invalid pid' });
    return;
  }
  try {
    const output = await runGrokText(['leader', 'profile', 'status']);
    send(res, 200, { ok: true, output });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleProfileStart(req, res, _url, params) {
  const pid = (params && params.pid) || '';
  if (!isValidPid(pid)) {
    send(res, 400, { ok: false, error: 'invalid pid' });
    return;
  }
  let body = {};
  try { body = await readJsonBody(req); }
  catch (err) { send(res, 400, { ok: false, error: err.message }); return; }

  const args = ['leader', 'profile', 'start'];
  if (body && body.frequencyHz != null) {
    const hz = Number(body.frequencyHz);
    if (!Number.isFinite(hz) || hz <= 0) {
      send(res, 400, { ok: false, error: 'frequencyHz must be a positive number' });
      return;
    }
    args.push('--frequency-hz', String(Math.floor(hz)));
  }

  try {
    const output = await runGrokText(args);
    send(res, 200, { ok: true, output });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleProfileStop(req, res, _url, params) {
  const pid = (params && params.pid) || '';
  if (!isValidPid(pid)) {
    send(res, 400, { ok: false, error: 'invalid pid' });
    return;
  }
  let body = {};
  try { body = await readJsonBody(req); }
  catch (err) { send(res, 400, { ok: false, error: err.message }); return; }

  let out = body && typeof body.output === 'string' ? body.output.trim() : '';
  if (!out) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    out = path.join(os.homedir(), '.grok-remote', `leader-profile-${pid}-${ts}.pprof`);
  }

  try {
    await runGrok(['leader', 'profile', 'stop', '--output', out]);
    send(res, 200, { ok: true, path: out });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

function isValidPid(s) {
  return typeof s === 'string' && /^[0-9]+$/.test(s);
}
