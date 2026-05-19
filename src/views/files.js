// Files tab: lists the agent's cwd and previews text files.
// Mounted by chat.js when the Files tab is selected.

import { api } from '../lib/api.js';
import { el, escapeHtml } from '../lib/render.js';

let activeState = null;

function storageKey(agentId) {
  return `grok-remote.files.${agentId}.path`;
}

function readStoredPath(agentId) {
  try {
    return localStorage.getItem(storageKey(agentId)) || '';
  } catch {
    return '';
  }
}

function writeStoredPath(agentId, p) {
  try {
    localStorage.setItem(storageKey(agentId), p || '');
  } catch {
    /* ignore */
  }
}

function fmtSize(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function joinPath(dir, name) {
  if (!dir) return name;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

function parentPath(p) {
  if (!p) return '';
  const cleaned = p.replace(/\/+$/, '');
  const i = cleaned.lastIndexOf('/');
  return i < 0 ? '' : cleaned.slice(0, i);
}

export function mountFilesTab(container, agent) {
  unmountFilesTab();
  if (!container) return;
  if (!agent || !agent.id) {
    const empty = el('div', { class: 'pane-empty' }, 'no agent selected');
    container.replaceChildren(empty);
    return;
  }

  const state = {
    agent,
    container,
    currentPath: readStoredPath(agent.id),
    selectedFile: null,
    destroyed: false,
  };
  activeState = state;

  const refreshBtn = el('button', {
    class: 'btn btn--ghost files-refresh',
    title: 'refresh',
    onclick: () => loadDir(state, state.currentPath),
  }, 'refresh');

  const backBtn = el('button', {
    class: 'btn btn--ghost files-back hidden',
    onclick: () => {
      state.selectedFile = null;
      renderViewer(state);
      state.root.classList.remove('files--show-viewer');
    },
  }, '< back');

  const breadcrumb = el('div', { class: 'files-breadcrumb' });
  const treeBody = el('div', { class: 'files-tree-body' });
  const viewerBody = el('div', { class: 'files-viewer-body' },
    el('div', { class: 'pane-empty' }, 'select a file to preview'));

  const tree = el('div', { class: 'files-tree' },
    el('div', { class: 'files-tree-header' },
      breadcrumb,
      refreshBtn,
    ),
    treeBody,
  );
  const viewer = el('div', { class: 'files-viewer' },
    el('div', { class: 'files-viewer-header' },
      backBtn,
      el('div', { class: 'files-viewer-title' }, ''),
    ),
    viewerBody,
  );

  const root = el('div', { class: 'files files--show-tree' }, tree, viewer);
  state.root = root;
  state.treeBody = treeBody;
  state.breadcrumb = breadcrumb;
  state.viewerBody = viewerBody;
  state.viewerTitle = viewer.querySelector('.files-viewer-title');
  state.backBtn = backBtn;

  container.replaceChildren(root);

  loadDir(state, state.currentPath);
}

export function unmountFilesTab() {
  if (!activeState) return;
  activeState.destroyed = true;
  activeState = null;
}

async function loadDir(state, p) {
  if (state.destroyed) return;
  state.currentPath = p || '';
  writeStoredPath(state.agent.id, state.currentPath);
  renderBreadcrumb(state);
  state.treeBody.replaceChildren(el('div', { class: 'files-loading' }, 'loading...'));
  try {
    const res = await api.listFiles(state.agent.id, state.currentPath);
    if (state.destroyed) return;
    if (!res || res.type !== 'directory') {
      // Path stored as a file - try the parent
      if (res && res.type === 'file') {
        const parent = parentPath(state.currentPath);
        state.selectedFile = state.currentPath;
        state.currentPath = parent;
        writeStoredPath(state.agent.id, state.currentPath);
        renderBreadcrumb(state);
        const r2 = await api.listFiles(state.agent.id, state.currentPath);
        renderDir(state, r2);
        await openFile(state, state.selectedFile);
        return;
      }
      state.treeBody.replaceChildren(el('div', { class: 'pane-empty' }, 'empty'));
      return;
    }
    renderDir(state, res);
  } catch (err) {
    if (state.destroyed) return;
    const msg = err && err.message ? err.message : 'failed to load directory';
    state.treeBody.replaceChildren(
      el('div', { class: 'files-error' }, `error: ${msg}`)
    );
    // If the stored path was bad, fall back to root.
    if (state.currentPath) {
      state.currentPath = '';
      writeStoredPath(state.agent.id, '');
      setTimeout(() => loadDir(state, ''), 0);
    }
  }
}

function renderBreadcrumb(state) {
  const parts = [];
  parts.push(el('button', {
    class: 'files-crumb',
    onclick: () => loadDir(state, ''),
  }, 'cwd'));
  if (state.currentPath) {
    const segments = state.currentPath.split('/').filter(Boolean);
    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      const here = acc;
      parts.push(el('span', { class: 'files-crumb-sep' }, '/'));
      parts.push(el('button', {
        class: 'files-crumb',
        onclick: () => loadDir(state, here),
      }, seg));
    }
  }
  state.breadcrumb.replaceChildren(...parts);
}

function renderDir(state, res) {
  const entries = Array.isArray(res.entries) ? res.entries : [];
  const rows = [];

  if (state.currentPath) {
    rows.push(el('button', {
      class: 'files-row files-row--up',
      onclick: () => loadDir(state, parentPath(state.currentPath)),
    },
      el('span', { class: 'files-row-icon' }, '..'),
      el('span', { class: 'files-row-name' }, 'parent directory'),
    ));
  }

  for (const ent of entries) {
    const isDir = ent.type === 'directory';
    const row = el('button', {
      class: `files-row files-row--${isDir ? 'dir' : 'file'}${ent.isHidden ? ' files-row--hidden' : ''}`,
      onclick: isDir
        ? () => loadDir(state, joinPath(state.currentPath, ent.name))
        : () => {
            const full = joinPath(state.currentPath, ent.name);
            openFile(state, full);
          },
    },
      el('span', { class: 'files-row-icon' }, isDir ? 'dir' : 'doc'),
      el('span', { class: 'files-row-name' }, ent.name + (isDir ? '/' : '')),
      el('span', { class: 'files-row-size' }, isDir ? '' : fmtSize(ent.size)),
    );
    rows.push(row);
  }

  if (!rows.length) {
    state.treeBody.replaceChildren(el('div', { class: 'pane-empty' }, 'empty directory'));
    return;
  }
  state.treeBody.replaceChildren(...rows);
}

async function openFile(state, filePath) {
  state.selectedFile = filePath;
  state.viewerTitle.textContent = filePath;
  state.viewerBody.replaceChildren(el('div', { class: 'files-loading' }, 'loading...'));
  state.root.classList.add('files--show-viewer');
  state.backBtn.classList.remove('hidden');
  try {
    const res = await api.readFile(state.agent.id, filePath);
    if (state.destroyed) return;
    renderViewerContents(state, res);
  } catch (err) {
    if (state.destroyed) return;
    const msg = err && err.message ? err.message : 'failed to read file';
    state.viewerBody.replaceChildren(
      el('div', { class: 'files-error' }, `error: ${msg}`)
    );
  }
}

function renderViewer(state) {
  if (!state.selectedFile) {
    state.viewerTitle.textContent = '';
    state.viewerBody.replaceChildren(
      el('div', { class: 'pane-empty' }, 'select a file to preview')
    );
    state.backBtn.classList.add('hidden');
  }
}

function renderViewerContents(state, res) {
  if (!res || res.type !== 'file') {
    state.viewerBody.replaceChildren(
      el('div', { class: 'files-error' }, 'unexpected response')
    );
    return;
  }
  const header = el('div', { class: 'files-viewer-meta' },
    el('span', { class: 'files-viewer-size' }, fmtSize(res.size)),
  );

  if (res.truncated) {
    state.viewerBody.replaceChildren(
      header,
      el('div', { class: 'files-placeholder' },
        el('div', { class: 'files-placeholder-title' }, 'file too large to preview'),
        el('div', { class: 'files-placeholder-sub' }, `${fmtSize(res.size)} exceeds the inline preview limit.`),
      ),
    );
    return;
  }
  if (res.binary) {
    state.viewerBody.replaceChildren(
      header,
      el('div', { class: 'files-placeholder' },
        el('div', { class: 'files-placeholder-title' }, 'binary file'),
        el('div', { class: 'files-placeholder-sub' }, `${fmtSize(res.size)} of binary data. preview not shown.`),
      ),
    );
    return;
  }

  const content = String(res.content || '');
  const lines = content.length ? content.split('\n') : [''];
  const gutter = el('div', { class: 'files-code-gutter' });
  const body = el('div', { class: 'files-code-body' });
  let gutterHtml = '';
  let bodyHtml = '';
  for (let i = 0; i < lines.length; i++) {
    gutterHtml += `<div class="files-code-lineno">${i + 1}</div>`;
    bodyHtml += `<div class="files-code-line">${escapeHtml(lines[i]) || '&nbsp;'}</div>`;
  }
  gutter.innerHTML = gutterHtml;
  body.innerHTML = bodyHtml;

  state.viewerBody.replaceChildren(
    header,
    el('pre', { class: 'files-code' }, gutter, body),
  );
}

export default mountFilesTab;
