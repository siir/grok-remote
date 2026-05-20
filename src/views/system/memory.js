// Memory page. Two cards (workspace + global) and a "clear all" footer.
// All actions hit /api/system/memory{,/clear}; there is no live SSE here.

import { api } from '../../lib/api.js';

let activeContainer = null;
let abortToken      = 0;

export function mount(container) {
  activeContainer = container;
  abortToken += 1;
  const myToken = abortToken;

  container.replaceChildren();
  container.innerHTML = `
    <section class="system-page memory-page">
      <header class="system-page-header">
        <h2 class="system-page-title">Memory</h2>
        <p class="system-page-sub">
          The MEMORY.md files grok keeps for this workspace and your home
          directory. Clearing wipes the file plus the matching session
          index. There is no undo.
        </p>
      </header>

      <div class="memory-grid">
        <article class="memory-card" data-scope="workspace">
          <header class="memory-card-head">
            <span class="memory-card-label">workspace memory</span>
            <button type="button" class="memory-clear-btn" data-scope="workspace">clear</button>
          </header>
          <div class="memory-card-body" data-role="body">
            <p class="memory-status">loading...</p>
          </div>
        </article>

        <article class="memory-card" data-scope="global">
          <header class="memory-card-head">
            <span class="memory-card-label">global memory</span>
            <button type="button" class="memory-clear-btn" data-scope="global">clear</button>
          </header>
          <div class="memory-card-body" data-role="body">
            <p class="memory-status">loading...</p>
          </div>
        </article>
      </div>

      <footer class="memory-footer">
        <button type="button" class="memory-clear-all-btn" data-stage="idle">
          clear all memory
        </button>
        <span class="memory-footer-note">click twice to confirm. removes both workspace and global memory.</span>
      </footer>

      <p class="memory-error" data-role="error" hidden></p>
    </section>
  `;

  wireEvents(container, () => myToken === abortToken);
  refresh(container, () => myToken === abortToken).catch(() => {});
}

export function unmount() {
  abortToken += 1;
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

// ----- helpers -----

function wireEvents(root, alive) {
  root.querySelectorAll('.memory-clear-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const scope = btn.dataset.scope;
      const label = scope === 'workspace' ? 'workspace memory' : 'global memory';
      if (!window.confirm(`Clear ${label}? This cannot be undone.`)) return;
      await runClear(root, alive, scope, btn);
    });
  });

  const allBtn = root.querySelector('.memory-clear-all-btn');
  if (allBtn) {
    allBtn.addEventListener('click', async () => {
      if (allBtn.dataset.stage !== 'armed') {
        allBtn.dataset.stage = 'armed';
        allBtn.textContent = 'click again to confirm';
        setTimeout(() => {
          if (!alive()) return;
          if (allBtn.dataset.stage === 'armed') {
            allBtn.dataset.stage = 'idle';
            allBtn.textContent = 'clear all memory';
          }
        }, 4000);
        return;
      }
      allBtn.dataset.stage = 'idle';
      allBtn.textContent = 'clear all memory';
      if (!window.confirm('Clear ALL memory (workspace + global)? This cannot be undone.')) return;
      await runClear(root, alive, 'all', allBtn);
    });
  }
}

async function runClear(root, alive, scope, btn) {
  const errEl = root.querySelector('[data-role="error"]');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'clearing...';
  try {
    const data = await api.memory.clear(scope);
    if (!alive()) return;
    renderCards(root, data);
  } catch (err) {
    if (!alive()) return;
    if (errEl) { errEl.hidden = false; errEl.textContent = err?.message || String(err); }
  } finally {
    if (alive()) {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }
}

async function refresh(root, alive) {
  const errEl = root.querySelector('[data-role="error"]');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  try {
    const data = await api.memory.get();
    if (!alive()) return;
    renderCards(root, data);
  } catch (err) {
    if (!alive()) return;
    if (errEl) { errEl.hidden = false; errEl.textContent = err?.message || String(err); }
  }
}

function renderCards(root, data) {
  const ws = (data && data.workspace) || { path: '', exists: false, size: 0, mtime: null };
  const gl = (data && data.global)    || { path: '', exists: false, size: 0, mtime: null };
  renderCard(root.querySelector('.memory-card[data-scope="workspace"] [data-role="body"]'), ws);
  renderCard(root.querySelector('.memory-card[data-scope="global"]    [data-role="body"]'), gl);
}

function renderCard(bodyEl, block) {
  if (!bodyEl) return;
  bodyEl.replaceChildren();
  const pathEl = document.createElement('p');
  pathEl.className = 'memory-path';
  pathEl.textContent = block.path || '(unknown path)';
  bodyEl.appendChild(pathEl);

  const meta = document.createElement('dl');
  meta.className = 'memory-meta';
  meta.append(
    metaRow('status', block.exists ? 'present' : '(empty)'),
    metaRow('size',   block.exists ? fmtBytes(block.size) : '0 B'),
    metaRow('mtime',  block.mtime ? fmtTime(block.mtime) : 'never'),
  );
  bodyEl.appendChild(meta);

  if (block.error) {
    const err = document.createElement('p');
    err.className = 'memory-card-error';
    err.textContent = block.error;
    bodyEl.appendChild(err);
  }
}

function metaRow(label, value) {
  const frag = document.createDocumentFragment();
  const dt = document.createElement('dt'); dt.textContent = label;
  const dd = document.createElement('dd'); dd.textContent = value;
  frag.append(dt, dd);
  return frag;
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
