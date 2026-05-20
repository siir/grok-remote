// Setup page.
//
// Surfaces a single button that runs `grok setup` (managed-deployment
// installer). After the run completes, the page also shows the post-run
// `grok inspect --json` output so the user can confirm what changed.

import { el } from '../../lib/render.js';

let activeContainer = null;
let activeAbort = null;

export function mount(container) {
  activeContainer = container;
  container.replaceChildren();

  const desc = el('div', { class: 'setup-desc' },
    el('p', null,
      'Fetches and installs the managed deployment configuration that ',
      'your organisation (or xAI) has bound this install to.'),
    el('p', null,
      'It downloads the managed bundle (config + agent profiles + MCP ',
      'servers + skill definitions) and merges it into your local config ',
      'while preserving user-only fields.'),
    el('p', null,
      'Re-running is idempotent: the same bundle will not be reapplied. ',
      'If you are an individual user with no managed deployment, this is ',
      'effectively a no-op and safe to run at any time.'),
    el('p', { class: 'setup-desc-foot' },
      'After the run completes, ', el('code', null, 'grok inspect --json'),
      ' is invoked automatically so you can see the resulting configuration.'),
  );

  const runBtn = el('button', {
    class: 'btn btn--primary setup-run-btn',
    type: 'button',
    onclick: () => runSetup(runBtn, resultHost),
  }, 'Run grok setup');

  const resultHost = el('div', { class: 'setup-result-host' });

  const wrap = el('section', { class: 'system-page setup-page' },
    el('h2', { class: 'system-page-title' }, 'Setup'),
    el('p', { class: 'system-page-sub' },
      'Run the managed-deployment installer. Pulls the latest bundle and merges it into your local config.'),
    desc,
    el('div', { class: 'setup-actions' }, runBtn),
    resultHost,
  );

  container.appendChild(wrap);
}

export function unmount() {
  if (activeAbort) {
    try { activeAbort.abort(); } catch { /* ignore */ }
    activeAbort = null;
  }
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

async function runSetup(btn, resultHost) {
  if (!btn || !resultHost) return;
  btn.disabled = true;
  const origLabel = btn.textContent;
  btn.textContent = 'running...';
  resultHost.replaceChildren(
    el('div', { class: 'setup-running' }, 'invoking grok setup; this may take a moment...'),
  );

  const abort = new AbortController();
  activeAbort = abort;
  try {
    const r = await fetch('/api/system/setup', {
      method: 'POST',
      headers: { accept: 'application/json' },
      signal: abort.signal,
    });
    const data = await r.json().catch(() => null);
    renderResult(resultHost, r.status, data);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    resultHost.replaceChildren(
      el('div', { class: 'setup-error' },
        el('strong', null, 'request failed: '),
        String(err && err.message ? err.message : err)),
    );
  } finally {
    if (activeAbort === abort) activeAbort = null;
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}

function renderResult(host, status, data) {
  host.replaceChildren();
  if (!data || typeof data !== 'object') {
    host.appendChild(el('div', { class: 'setup-error' },
      `unexpected response from server (HTTP ${status})`));
    return;
  }
  const ok = !!data.ok;
  const head = el('div', { class: `setup-result-head setup-result-head--${ok ? 'ok' : 'fail'}` },
    el('span', { class: 'setup-result-badge' }, ok ? 'success' : 'failed'),
    el('span', { class: 'setup-result-summary' },
      ok
        ? `grok setup completed (exit ${data.exitCode ?? 0}).`
        : `grok setup failed (exit ${data.exitCode ?? '?'}): ${data.error || 'unknown error'}`,
    ),
  );
  host.appendChild(head);

  if (data.stdout) {
    host.appendChild(buildOutputBlock('stdout', data.stdout));
  }
  if (data.stderr) {
    host.appendChild(buildOutputBlock('stderr', data.stderr));
  }

  // Post-setup inspect block. If inspect failed we still surface the error so
  // the user knows the dashboard tried.
  if (data.inspect) {
    const pretty = JSON.stringify(data.inspect, null, 2);
    host.appendChild(buildOutputBlock('grok inspect --json (after setup)', pretty));
  } else if (data.inspectError) {
    host.appendChild(el('div', { class: 'setup-result-note' },
      el('strong', null, 'grok inspect: '),
      `unavailable (${data.inspectError})`,
    ));
  }
}

function buildOutputBlock(title, text) {
  const pre = el('pre', { class: 'setup-output-pre' }, text);
  return el('section', { class: 'setup-output' },
    el('header', { class: 'setup-output-head' },
      el('span', { class: 'setup-output-title' }, title),
    ),
    pre,
  );
}
