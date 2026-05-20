// Health page. Composes grok inspect / version / update with a small
// "server info" block, plus a recheck button.

import { api } from '../../lib/api.js';

let activeContainer = null;
let abortToken      = 0;

export function mount(container) {
  activeContainer = container;
  abortToken += 1;
  const myToken = abortToken;

  container.replaceChildren();
  container.innerHTML = `
    <section class="system-page health-page">
      <header class="system-page-header health-header">
        <div>
          <h2 class="system-page-title">Health</h2>
          <p class="system-page-sub">
            What this grok build sees about itself. Combines
            <code>grok inspect</code>, <code>grok version</code>, and an
            update check.
          </p>
        </div>
        <button type="button" class="health-recheck-btn" data-role="recheck">
          recheck
        </button>
      </header>

      <div class="health-grid">
        <article class="health-card" data-card="inspect">
          <header class="health-card-head">grok inspect</header>
          <div class="health-card-body" data-role="inspect-body">
            <p class="health-status">loading...</p>
          </div>
        </article>

        <article class="health-card" data-card="version">
          <header class="health-card-head">version</header>
          <div class="health-card-body" data-role="version-body">
            <p class="health-status">loading...</p>
          </div>
        </article>

        <article class="health-card" data-card="update">
          <header class="health-card-head">update</header>
          <div class="health-card-body" data-role="update-body">
            <p class="health-status">loading...</p>
          </div>
        </article>
      </div>

      <article class="health-server">
        <header class="health-card-head">server</header>
        <div class="health-card-body" data-role="server-body">
          <p class="health-status">loading...</p>
        </div>
      </article>

      <p class="health-error" data-role="error" hidden></p>
    </section>
  `;

  const btn = container.querySelector('[data-role="recheck"]');
  if (btn) {
    btn.addEventListener('click', () => {
      recheck(container, () => myToken === abortToken).catch(() => {});
    });
  }

  load(container, () => myToken === abortToken).catch(() => {});
}

export function unmount() {
  abortToken += 1;
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

// ----- data flow -----

async function load(root, alive) {
  setLoading(root);
  try {
    const data = await api.systemHealth.get();
    if (!alive()) return;
    renderAll(root, data);
  } catch (err) {
    if (!alive()) return;
    showError(root, err);
  }
}

async function recheck(root, alive) {
  const btn = root.querySelector('[data-role="recheck"]');
  if (btn) { btn.disabled = true; btn.textContent = 'rechecking...'; }
  setLoading(root);
  try {
    const data = await api.systemHealth.recheck();
    if (!alive()) return;
    renderAll(root, data);
  } catch (err) {
    if (!alive()) return;
    showError(root, err);
  } finally {
    if (alive() && btn) { btn.disabled = false; btn.textContent = 'recheck'; }
  }
}

function setLoading(root) {
  for (const sel of ['inspect-body', 'version-body', 'update-body', 'server-body']) {
    const el = root.querySelector(`[data-role="${sel}"]`);
    if (el) el.innerHTML = '<p class="health-status">loading...</p>';
  }
  const err = root.querySelector('[data-role="error"]');
  if (err) { err.hidden = true; err.textContent = ''; }
}

function showError(root, err) {
  const errEl = root.querySelector('[data-role="error"]');
  if (errEl) {
    errEl.hidden = false;
    errEl.textContent = err?.message || String(err);
  }
}

function renderAll(root, data) {
  renderInspect(root.querySelector('[data-role="inspect-body"]'), data?.inspect, data?.inspectError);
  renderVersion(root.querySelector('[data-role="version-body"]'), data?.version, data?.versionError);
  renderUpdate(root.querySelector('[data-role="update-body"]'),  data?.update,  data?.updateError);
  renderServer(root.querySelector('[data-role="server-body"]'),  data?.server);
}

// ----- renderers -----

function renderInspect(host, inspect, errMsg) {
  if (!host) return;
  host.replaceChildren();
  if (errMsg) {
    host.appendChild(errorNote(errMsg));
    return;
  }
  if (!inspect || typeof inspect !== 'object') {
    host.appendChild(plain('(no data)'));
    return;
  }
  const dl = document.createElement('dl');
  dl.className = 'health-kv';
  for (const [k, v] of flattenForDisplay(inspect)) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
  if (!dl.childElementCount) {
    host.appendChild(plain('(empty)'));
    return;
  }
  host.appendChild(dl);
}

function renderVersion(host, version, errMsg) {
  if (!host) return;
  host.replaceChildren();
  if (errMsg) { host.appendChild(errorNote(errMsg)); return; }
  if (!version || typeof version !== 'object') {
    host.appendChild(plain('(no data)'));
    return;
  }
  const dl = document.createElement('dl');
  dl.className = 'health-kv';
  // Pull a few well-known fields up front, then any remaining strings.
  const KNOWN = ['version', 'commit', 'build', 'buildHash', 'hash', 'channel', 'timestamp', 'buildTimestamp', 'binary', 'path'];
  const seen = new Set();
  for (const key of KNOWN) {
    if (version[key] === undefined || version[key] === null) continue;
    seen.add(key);
    const dt = document.createElement('dt'); dt.textContent = key;
    const dd = document.createElement('dd'); dd.textContent = stringify(version[key]);
    dl.append(dt, dd);
  }
  for (const [k, v] of Object.entries(version)) {
    if (seen.has(k)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = stringify(v);
    dl.append(dt, dd);
  }
  if (!dl.childElementCount) {
    host.appendChild(plain('(empty)'));
    return;
  }
  host.appendChild(dl);
}

function renderUpdate(host, update, errMsg) {
  if (!host) return;
  host.replaceChildren();
  if (errMsg && !update) {
    host.appendChild(errorNote(errMsg));
    return;
  }
  if (!update || typeof update !== 'object') {
    host.appendChild(plain('(no data)'));
    return;
  }

  // The JSON shape is best-effort; common fields: available, latest,
  // current, channel.
  const available = !!(update.available || update.update || update.hasUpdate);
  const latest    = update.latest || update.latestVersion || update.target || '';
  const current   = update.current || update.currentVersion || update.installed || '';
  const channel   = update.channel || '';

  const status = document.createElement('p');
  status.className = 'health-update-status';
  status.dataset.status = available ? 'available' : 'current';
  status.textContent = available
    ? `update available${latest ? `: ${latest}` : ''}`
    : 'up to date';
  host.appendChild(status);

  const dl = document.createElement('dl');
  dl.className = 'health-kv';
  if (current) {
    const dt = document.createElement('dt'); dt.textContent = 'current';
    const dd = document.createElement('dd'); dd.textContent = stringify(current);
    dl.append(dt, dd);
  }
  if (latest) {
    const dt = document.createElement('dt'); dt.textContent = 'latest';
    const dd = document.createElement('dd'); dd.textContent = stringify(latest);
    dl.append(dt, dd);
  }
  if (channel) {
    const dt = document.createElement('dt'); dt.textContent = 'channel';
    const dd = document.createElement('dd'); dd.textContent = stringify(channel);
    dl.append(dt, dd);
  }
  if (dl.childElementCount) host.appendChild(dl);

  if (available) {
    const row = document.createElement('div');
    row.className = 'health-update-action';
    const cmd = document.createElement('code');
    cmd.className = 'health-update-cmd';
    cmd.textContent = 'grok update';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'health-copy-btn';
    btn.textContent = 'copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText('grok update');
        btn.textContent = 'copied';
        setTimeout(() => { btn.textContent = 'copy'; }, 1500);
      } catch {
        btn.textContent = 'copy failed';
        setTimeout(() => { btn.textContent = 'copy'; }, 1500);
      }
    });
    row.append(cmd, btn);
    host.appendChild(row);
  }

  if (errMsg) {
    host.appendChild(errorNote(errMsg));
  }
}

function renderServer(host, server) {
  if (!host) return;
  host.replaceChildren();
  if (!server || typeof server !== 'object') {
    host.appendChild(plain('(no data)'));
    return;
  }
  const dl = document.createElement('dl');
  dl.className = 'health-kv';
  const rows = [
    ['node',     server.node || ''],
    ['platform', server.platform || ''],
    ['uptime',   fmtUptime(server.uptimeSeconds)],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v || '';
    dl.append(dt, dd);
  }
  host.appendChild(dl);
}

// ----- formatters -----

function plain(text) {
  const p = document.createElement('p');
  p.className = 'health-status';
  p.textContent = text;
  return p;
}

function errorNote(msg) {
  const p = document.createElement('p');
  p.className = 'health-card-error';
  p.textContent = msg;
  return p;
}

function stringify(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Flatten one level of the inspect object into [key, displayString] rows.
// inspect's top-level is grouped (model, tools, ...); we surface keys as
// "group.subkey" so the kv list stays scannable.
function flattenForDisplay(obj) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      out.push([k, v.length ? `[${v.length} items]` : '[]']);
      continue;
    }
    if (typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v)) {
        if (v2 === null || v2 === undefined) continue;
        if (typeof v2 === 'object') {
          out.push([`${k}.${k2}`, summarize(v2)]);
        } else {
          out.push([`${k}.${k2}`, stringify(v2)]);
        }
      }
      continue;
    }
    out.push([k, stringify(v)]);
  }
  return out;
}

function summarize(v) {
  if (Array.isArray(v)) return `[${v.length} items]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    return keys.length ? `{${keys.length} keys}` : '{}';
  }
  return stringify(v);
}

function fmtUptime(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '0s';
  const days = Math.floor(s / 86400);
  const hrs  = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hrs)  parts.push(`${hrs}h`);
  if (mins) parts.push(`${mins}m`);
  if (!parts.length || secs) parts.push(`${secs}s`);
  return parts.join(' ');
}
