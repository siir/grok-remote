// Health routes. Composes `grok inspect`, `grok version`, and
// `grok update --check` into a single payload for the dashboard.
//
// `grok update --check` may exit non-zero when there is no update
// available (or when the channel cannot be contacted); we tolerate that
// and surface the error string instead of failing the whole call.

import { send } from '../helpers.js';
import { runGrokJson, errorToResponse } from '../../grok-cli.js';

export function register(add) {
  add('GET',  '/api/system/health',         getHandler);
  add('POST', '/api/system/health/recheck', getHandler);
}

function serverInfo() {
  return {
    node:           process.version,
    platform:       process.platform,
    uptimeSeconds:  Math.floor(process.uptime()),
  };
}

async function safeJson(args) {
  try {
    return { ok: true, value: await runGrokJson(args) };
  } catch (err) {
    return { ok: false, error: errorToResponse(err) };
  }
}

async function collect() {
  const [inspectRes, versionRes, updateRes] = await Promise.all([
    safeJson(['inspect', '--json']),
    safeJson(['version', '--json']),
    safeJson(['update', '--check', '--json']),
  ]);

  const payload = {
    inspect: inspectRes.ok ? inspectRes.value : null,
    version: versionRes.ok ? versionRes.value : null,
    update:  updateRes.ok ? updateRes.value : null,
    server:  serverInfo(),
  };

  if (!inspectRes.ok) payload.inspectError = inspectRes.error?.error || 'inspect failed';
  if (!versionRes.ok) payload.versionError = versionRes.error?.error || 'version failed';
  if (!updateRes.ok) {
    // `grok update --check --json` is allowed to fail (e.g. no update
    // available, network error). Surface the message inline.
    payload.updateError = updateRes.error?.error || 'update check failed';
  }

  return payload;
}

async function getHandler(req, res) {
  try {
    const data = await collect();
    send(res, 200, { ok: true, ...data });
  } catch (err) {
    send(res, 500, { ok: false, error: err?.message || String(err) });
  }
}
