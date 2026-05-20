// grok-remote dashboard entry point.
//
// Boot sequence:
//   1. play the hole-to-GR intro animation (preserved from v0.1).
//   2. once it resolves, mount the dashboard shell (topbar, sidebar, main pane).
//   3. dispatch between "chat" (per-agent) and "settings" views via a tiny router.
//
// The intro plays once per page load. On subsequent navigations the topbar
// keeps a small static GR mark.

import { api } from './lib/api.js';
import { AgentsSidebar } from './views/agents.js';
import { ChatView } from './views/chat.js';
import { SettingsView } from './views/settings.js';
import { el } from './lib/render.js';
import { registerPwa } from './lib/pwa.js';
import { applyTheme, getTheme, nextTheme, getThemeMeta } from './lib/themes.js';
import { SYSTEM_PAGES, getSystemPage } from './views/system/index.js';
import { iconHtml } from './lib/icons.js';

// Apply persisted theme as early as possible (before any DOM is drawn) so the
// dashboard never flashes the default palette.
applyTheme(getTheme());

function syncThemeToggle(name) {
  const meta = getThemeMeta(name);
  const dot   = document.getElementById('theme-toggle-dot');
  const label = document.getElementById('theme-toggle-label');
  const btn   = document.getElementById('theme-toggle');
  if (dot)   dot.style.background = meta.accent;
  if (label) label.textContent = meta.label;
  if (btn)   btn.title = `theme: ${meta.label} (click to cycle)`;
}

// React to setTheme calls from elsewhere (e.g. Settings picker).
window.addEventListener('storage', (ev) => {
  if (ev.key === 'grok-remote.theme') {
    applyTheme(getTheme());
    syncThemeToggle(getTheme());
  }
});
window.addEventListener('grok-remote:theme-change', () => {
  syncThemeToggle(getTheme());
});

// ── intro animation ────────────────────────────────────────────────────

const FIGLET_GR = [
  '  ██████╗ ██████╗  ',
  ' ██╔════╝ ██╔══██╗ ',
  ' ██║  ███╗██████╔╝ ',
  ' ██║   ██║██╔══██╗ ',
  ' ╚██████╔╝██║  ██║ ',
  '  ╚═════╝ ╚═╝  ╚═╝ ',
];

const HOLE_FRAMES = [
  ['                   ',
   '                   ',
   '                   ',
   '                   ',
   '                   ',
   '                   '],
  ['                   ',
   '                   ',
   '         ·         ',
   '         ·         ',
   '                   ',
   '                   '],
  ['                   ',
   '        ░░░        ',
   '       ░   ░       ',
   '       ░   ░       ',
   '        ░░░        ',
   '                   '],
  ['       ░░░░░       ',
   '      ░▒▒▒▒▒░      ',
   '     ░▒▓▓▓▓▓▒░     ',
   '     ░▒▓▓▓▓▓▒░     ',
   '      ░▒▒▒▒▒░      ',
   '       ░░░░░       '],
  ['     ░░░░░░░░░     ',
   '    ░▒▒▒▓▓▓▒▒▒░    ',
   '   ░▒▓▓█████▓▓▒░   ',
   '   ░▒▓▓█████▓▓▒░   ',
   '    ░▒▒▒▓▓▓▒▒▒░    ',
   '     ░░░░░░░░░     '],
  ['    ░░░░░░░░░░░    ',
   '  ░▒▒▒▒▓▓▓▓▓▒▒▒▒░  ',
   ' ░▒▓▓▓███████▓▓▓▒░ ',
   ' ░▒▓▓▓███████▓▓▓▒░ ',
   '  ░▒▒▒▒▓▓▓▓▓▒▒▒▒░  ',
   '    ░░░░░░░░░░░    '],
  ['    ▓▓▓▓▓▓▓▓▓▓▓    ',
   '  ▓███████████████ ',
   ' █████████████████ ',
   ' █████████████████ ',
   '  ▓███████████████ ',
   '    ▓▓▓▓▓▓▓▓▓▓▓    '],
  ['███████████████████',
   '███████████████████',
   '███████████████████',
   '███████████████████',
   '███████████████████',
   '███████████████████'],
];

const SEQUENCE = [
  { idx: 0, hold: 60,  phase: 'hole' },
  { idx: 1, hold: 110, phase: 'hole' },
  { idx: 2, hold: 110, phase: 'hole' },
  { idx: 3, hold: 130, phase: 'hole' },
  { idx: 4, hold: 150, phase: 'hole' },
  { idx: 5, hold: 280, phase: 'hole' },
  { idx: 6, hold: 70,  phase: 'pulse' },
  { idx: 7, hold: 55,  phase: 'flash' },
];

function cellClass(ch, phase) {
  if (phase === 'flash') return 'cell-flash';
  if (phase === 'pulse') return ch === ' ' ? '' : 'cell-flash';
  if (ch === '·' || ch === '░') return 'cell-rim';
  if (ch === '▒') return 'cell-mid';
  if (ch === '▓') return 'cell-deep';
  if (ch === '█') return 'cell-void';
  return '';
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function colorizeLine(line, phase) {
  let html = '';
  let runCls = null;
  let runText = '';
  const flush = () => {
    if (!runText) return;
    if (runCls) html += `<span class="${runCls}">${escapeHtml(runText)}</span>`;
    else html += escapeHtml(runText);
    runText = '';
  };
  for (const ch of line) {
    const cls = cellClass(ch, phase);
    if (cls !== runCls) { flush(); runCls = cls; }
    runText += ch;
  }
  flush();
  return html;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function playIntro(figletEl) {
  if (!figletEl) return;
  figletEl.classList.add('figlet--hole');
  for (const { idx, hold, phase } of SEQUENCE) {
    const frame = HOLE_FRAMES[idx];
    figletEl.innerHTML = frame.map(l => colorizeLine(l, phase)).join('\n');
    await sleep(hold);
  }
  figletEl.classList.remove('figlet--hole');
  figletEl.textContent = FIGLET_GR.join('\n');
}

// ── status header ──────────────────────────────────────────────────────

function setStatus(kind, text) {
  const pill = document.getElementById('status-pill');
  const txt  = document.getElementById('status-text');
  if (!pill || !txt) return;
  pill.className = 'status-pill';
  pill.classList.add(`status-pill--${kind}`);
  pill.textContent = kind === 'ok' ? '●' : (kind === 'fail' ? '×' : (kind === 'warn' ? '!' : '·'));
  txt.textContent = text;
}

async function pingHello() {
  try {
    const data = await api.hello();
    const ts = data && data.tailscale;
    if (ts && ts.backend === 'Running') setStatus('ok', 'tailnet up');
    else if (ts) setStatus('warn', `tailscale: ${ts.backend || 'unknown'}`);
    else setStatus('warn', 'no tailscale identity');
  } catch {
    setStatus('fail', 'api unreachable');
  }
}

// ── router ─────────────────────────────────────────────────────────────

// Top-level "areas" outside the conversation flow. Each key matches the
// first hash segment and a system view module under src/views/system/.
const SYSTEM_AREAS = new Set([
  'mcp', 'memory', 'models', 'leaders', 'worktrees',
  'sessions', 'import', 'health', 'flow', 'setup', 'skills',
]);

function parseRoute() {
  const h = (location.hash || '#/').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'agents' && parts[1]) return { name: 'chat', agentId: parts[1] };
  if (parts[0] === 'settings') return { name: 'settings' };
  if (SYSTEM_AREAS.has(parts[0])) return { name: 'system', area: parts[0], parts };
  return { name: 'home' };
}

function navigate(hash) {
  if (location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
}

// ── drawer (mobile sidebar) ────────────────────────────────────────────

function openDrawer() {
  document.body.setAttribute('data-drawer-open', '');
  const btn = document.getElementById('hamburger-btn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  const bd = document.getElementById('drawer-backdrop');
  if (bd) bd.hidden = false;
}
function closeDrawer() {
  document.body.removeAttribute('data-drawer-open');
  const btn = document.getElementById('hamburger-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  const bd = document.getElementById('drawer-backdrop');
  if (bd) bd.hidden = true;
}
function toggleDrawer() {
  if (document.body.hasAttribute('data-drawer-open')) closeDrawer();
  else openDrawer();
}

// ── dashboard mount ────────────────────────────────────────────────────

function makeRailIcon({ href, title, area, iconName, label }) {
  // Build the icon element via innerHTML since iconHtml() returns a full
  // <svg> string. el() doesn't accept raw HTML by default, so we wrap it
  // in a span and assign innerHTML once.
  const a = el('a', {
    class: 'left-rail-item',
    href,
    title,
    'aria-label': title,
    'data-area': area,
  });
  const icon = document.createElement('span');
  icon.className = 'left-rail-icon';
  icon.innerHTML = iconHtml(iconName);
  a.appendChild(icon);
  const lbl = el('span', { class: 'left-rail-label' }, label || title);
  a.appendChild(lbl);
  return a;
}

function buildLeftRail() {
  const rail = el('nav', { class: 'left-rail', 'aria-label': 'top-level navigation' });
  rail.appendChild(makeRailIcon({
    href: '#/', title: 'conversations', area: 'home', iconName: 'home', label: 'chats',
  }));
  for (const p of SYSTEM_PAGES) {
    rail.appendChild(makeRailIcon({
      href: `#/${p.area}`, title: p.label, area: p.area, iconName: p.iconName, label: p.label,
    }));
  }
  return rail;
}

function updateRailHighlight(route) {
  const rail = document.querySelector('.left-rail');
  if (!rail) return;
  let activeArea = 'home';
  if (route.name === 'chat') activeArea = 'home';
  else if (route.name === 'system') activeArea = route.area;
  for (const item of rail.querySelectorAll('.left-rail-item')) {
    item.classList.toggle('left-rail-item--active', item.dataset.area === activeArea);
  }
}

function mountDashboard() {
  const host = document.getElementById('app');
  if (!host) return;
  host.replaceChildren();

  let currentAgent = null;
  let activeSystemPage = null; // { area, module }
  const chat     = new ChatView();
  const settings = new SettingsView();
  const sidebar  = new AgentsSidebar({
    onSelect: (id) => navigate(`#/agents/${encodeURIComponent(id)}`),
    onCreate: () => {},
    onDelete: (id) => {
      if (currentAgent && currentAgent.id === id) {
        currentAgent = null;
        navigate('#/');
      }
    },
  });

  const mainHost = el('div', { class: 'main-pane' });
  const railHost = buildLeftRail();
  const shell = el('div', { class: 'dashboard dashboard--with-rail' });
  host.appendChild(shell);
  shell.appendChild(railHost);
  sidebar.mount(shell);          // appends sidebar.root + starts polling
  shell.appendChild(mainHost);
  installSidebarResize(shell, sidebar);

  // hook up settings button in topbar
  const settingsBtn = document.getElementById('open-settings');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      navigate('#/settings');
      closeDrawer();
    });
  }
  const brandLink = document.getElementById('brand-link');
  if (brandLink) {
    brandLink.addEventListener('click', (ev) => {
      ev.preventDefault();
      navigate('#/');
      closeDrawer();
    });
  }

  // "Any agent active" indicator on the brand + document title prefix.
  // Listens to the same agents-refresh event the sidebar dispatches and
  // shows a pulsing amber dot whenever at least one agent has inFlight > 0
  // or is running. The title prefix surfaces activity in browser tabs and
  // the dock when the dashboard is fully out of view.
  // Stamp the brand-version span from the package.json version baked in by
  // Vite at build time. Falls back to the hardcoded HTML value if for some
  // reason the define didn't fire.
  const brandVersion = document.getElementById('brand-version');
  if (brandVersion && typeof __APP_VERSION__ === 'string' && __APP_VERSION__) {
    brandVersion.textContent = 'v' + __APP_VERSION__;
    brandVersion.title = `grok-remote v${__APP_VERSION__}`;
  }

  const brandActive = document.getElementById('brand-active');
  const baseTitle = document.title;
  document.addEventListener('grok-remote:agents-refresh', (ev) => {
    const list = (ev && ev.detail) || [];
    const active = list.some((a) =>
      (typeof a?.inFlight === 'number' && a.inFlight > 0) ||
      (a?.status === 'running')
    );
    if (brandActive) brandActive.hidden = !active;
    const wantTitle = active ? `(*) ${baseTitle}` : baseTitle;
    if (document.title !== wantTitle) document.title = wantTitle;
  });

  // ── Global background-process tracker ────────────────────────────────
  // Polls every 3s for every running terminal across every agent so the
  // user can see persistent bg work (e.g. `npm run dev`) from any page
  // and from any device. Survives page reload (server-side state).
  installBgTracker();

  // close drawer when a sidebar agent is picked on narrow screens.
  shell.addEventListener('click', (ev) => {
    if (!document.body.hasAttribute('data-drawer-open')) return;
    const target = ev.target;
    if (target && target.closest && target.closest('.sidebar .agent-item')) {
      closeDrawer();
    }
  });

  function unmountActiveSystemPage() {
    if (!activeSystemPage) return;
    try { activeSystemPage.module.unmount?.(); } catch { /* ignore */ }
    activeSystemPage = null;
  }

  function renderRoute() {
    const route = parseRoute();
    // Unmount the previous system page FIRST so its teardown (e.g.
    // ReactFlow's root.unmount) runs against the DOM it still owns. Wiping
    // mainHost first triggers React's "node to be removed is not a child"
    // NotFoundError because the nodes are already gone by the time React
    // tries to reconcile.
    unmountActiveSystemPage();
    mainHost.replaceChildren();
    updateRailHighlight(route);
    if (route.name === 'system') {
      const page = getSystemPage(route.area);
      if (page && page.module && typeof page.module.mount === 'function') {
        page.module.mount(mainHost, route);
        activeSystemPage = page;
        return;
      }
      // Unknown system area: fall through to home.
    }
    if (route.name === 'settings') {
      settings.mount(mainHost);
      return;
    }
    if (route.name === 'chat') {
      chat.mount(mainHost);
      // try to find the agent in sidebar list, otherwise fetch
      const found = sidebar.agents.find(a => a.id === route.agentId);
      if (found) {
        currentAgent = found;
        sidebar.selectedId = found.id;
        sidebar.renderList();
        chat.setAgent(found);
      } else {
        // fetch single
        api.getAgent(route.agentId).then((a) => {
          currentAgent = a || { id: route.agentId };
          sidebar.selectedId = currentAgent.id;
          sidebar.renderList();
          chat.setAgent(currentAgent);
        }).catch(() => {
          currentAgent = { id: route.agentId };
          chat.setAgent(currentAgent);
        });
      }
      return;
    }
    // home / empty
    chat.mount(mainHost);
    chat.setAgent(null);
  }

  window.addEventListener('hashchange', renderRoute);
  renderRoute();
}

// ── boot ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const figletEl = document.getElementById('figlet');
  const introHost = document.getElementById('intro');

  // Kick off api ping in parallel with the intro.
  pingHello();
  setInterval(pingHello, 10000);

  try {
    await playIntro(figletEl);
    // brief settle
    await sleep(140);
  } catch {}

  // collapse the intro panel and reveal the dashboard
  if (introHost) introHost.classList.add('intro--collapsed');
  // Move a tiny static GR mark into the topbar.
  const topMark = document.getElementById('topbar-mark');
  if (topMark) topMark.textContent = 'GR';

  mountDashboard();

  // wire the topbar theme toggle.
  syncThemeToggle(getTheme());
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      const n = nextTheme(getTheme());
      syncThemeToggle(n);
      window.dispatchEvent(new CustomEvent('grok-remote:theme-change', { detail: { theme: n } }));
    });
  }

  // wire mobile drawer affordances.
  const ham = document.getElementById('hamburger-btn');
  if (ham) {
    ham.addEventListener('click', (ev) => {
      ev.preventDefault();
      toggleDrawer();
    });
  }
  const backdrop = document.getElementById('drawer-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => closeDrawer());
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && document.body.hasAttribute('data-drawer-open')) {
      closeDrawer();
    }
  });
  // Sidebar's internal close button (× at the top of the drawer on mobile)
  // dispatches this event so it works regardless of when the sidebar is
  // mounted / re-rendered.
  document.addEventListener('grok-remote:close-drawer', () => closeDrawer());

  // wire PWA install banner + service worker.
  registerPwa();
});

// ── Resizable + collapsible sidebar ──────────────────────────────────────
//
// The skeleton is split into four small helpers so each concern stays
// readable:
//
//   restoreSidebarState  - read localStorage, apply --sidebar-width and
//                          the collapsed class before the first paint.
//   attachResizeDrag     - wire the vertical drag handle that lives on the
//                          sidebar/main seam.
//   attachToggle         - wire the collapse toggle event + reopen tab.
//   relayoutOverlays     - reposition the (viewport-fixed) drag handle and
//                          reopen tab whenever the layout changes.
//
// The drag handle and the reopen tab are appended to document.body with
// position: fixed so they cannot perturb the dashboard grid (an earlier
// bug: absolutely-positioned children inside a CSS grid were still
// participating in grid auto-placement, which pushed the topbar off-screen
// when the sidebar collapsed).
const SIDEBAR_W_KEY = 'grok-remote.sidebar.width';
const SIDEBAR_C_KEY = 'grok-remote.sidebar.collapsed';
const SIDEBAR_W_MIN = 220;
const SIDEBAR_W_MAX = 560;
const RAIL_WIDTH    = 68;
const MOBILE_MAX    = 720;

function isMobileViewport() {
  return window.matchMedia(`(max-width: ${MOBILE_MAX}px)`).matches;
}

function restoreSidebarState(shell) {
  try {
    const w = parseInt(localStorage.getItem(SIDEBAR_W_KEY) || '', 10);
    if (Number.isFinite(w) && w >= SIDEBAR_W_MIN && w <= SIDEBAR_W_MAX) {
      shell.style.setProperty('--sidebar-width', `${w}px`);
    }
    if (localStorage.getItem(SIDEBAR_C_KEY) === '1') {
      shell.classList.add('dashboard--sidebar-collapsed');
    }
  } catch { /* ignore */ }
}

function attachResizeDrag(shell, sidebar, handle, relayout) {
  handle.addEventListener('mousedown', (ev) => {
    if (shell.classList.contains('dashboard--sidebar-collapsed')) return;
    if (isMobileViewport()) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = sidebar.root.getBoundingClientRect().width;
    const onMove = (e) => {
      const dx = e.clientX - startX;
      const w = Math.max(SIDEBAR_W_MIN, Math.min(SIDEBAR_W_MAX, startW + dx));
      shell.style.setProperty('--sidebar-width', `${w}px`);
      relayout();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const w = sidebar.root.getBoundingClientRect().width;
      try { localStorage.setItem(SIDEBAR_W_KEY, String(Math.round(w))); } catch { /* ignore */ }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function attachToggle(shell, sidebar, handle, reopenBtn, relayout) {
  function updateCollapseBtnLabel(collapsed) {
    const btn = sidebar.sidebarCollapseBtn;
    if (!btn) return;
    btn.textContent = collapsed ? '⟩' : '⟨';
    btn.title = collapsed ? 'expand sidebar' : 'collapse sidebar';
  }

  function toggleCollapse(forceState) {
    const next = (typeof forceState === 'boolean')
      ? forceState
      : !shell.classList.contains('dashboard--sidebar-collapsed');
    shell.classList.toggle('dashboard--sidebar-collapsed', next);
    updateCollapseBtnLabel(next);
    relayout();
    try { localStorage.setItem(SIDEBAR_C_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  }

  // Initial sync of the in-sidebar collapse button label.
  updateCollapseBtnLabel(shell.classList.contains('dashboard--sidebar-collapsed'));

  reopenBtn.addEventListener('click', () => toggleCollapse(false));
  document.addEventListener('grok-remote:sidebar-toggle', () => toggleCollapse());
}

function relayoutOverlays(shell, sidebar, handle, reopenBtn) {
  // On mobile the sidebar is an off-canvas drawer; the seam/handle and the
  // edge-reopen tab have no meaning. Force them hidden so the desktop
  // collapsed class can't leak into the mobile layout.
  if (isMobileViewport()) {
    handle.style.display = 'none';
    reopenBtn.style.display = 'none';
    return;
  }

  const collapsed = shell.classList.contains('dashboard--sidebar-collapsed');

  if (collapsed) {
    handle.style.display = 'none';
    reopenBtn.style.display = '';
    reopenBtn.style.left = `${RAIL_WIDTH}px`;
  } else {
    reopenBtn.style.display = 'none';
    const rect = sidebar.root.getBoundingClientRect();
    handle.style.display = '';
    handle.style.left = `${rect.right - 2}px`;
  }
}

function installSidebarResize(shell, sidebar) {
  restoreSidebarState(shell);

  // Both overlays live on <body> with position: fixed (see style.css).
  // That keeps them OUT of the dashboard grid entirely, so collapse cannot
  // create implicit grid rows or perturb the topbar.
  const handle = el('div', {
    class: 'sidebar-resize-handle',
    title: 'drag to resize',
    'aria-hidden': 'true',
  });
  const reopenBtn = el('button', {
    type: 'button',
    class: 'sidebar-reopen-tab',
    title: 'expand sidebar',
    'aria-label': 'expand sidebar',
  }, '⟩');
  document.body.appendChild(handle);
  document.body.appendChild(reopenBtn);

  const relayout = () => relayoutOverlays(shell, sidebar, handle, reopenBtn);

  attachResizeDrag(shell, sidebar, handle, relayout);
  attachToggle(shell, sidebar, handle, reopenBtn, relayout);

  window.addEventListener('resize', relayout);
  // Run once after mount so the initial position is correct (the sidebar
  // root must already be in the DOM and laid out for getBoundingClientRect
  // to return meaningful coords).
  requestAnimationFrame(relayout);
}

// ── Background-process tracker (persistent across pages + reloads) ──────
// Polls /api/system/bg-terminals every 3s while the tab is visible. Shows
// "bg: N" in the topbar when at least one terminal is running, and opens
// a global viewer on click. Server-side state survives client reloads.
function installBgTracker() {
  const btn   = document.getElementById('topbar-bg');
  const count = btn ? btn.querySelector('.topbar-bg__count') : null;
  if (!btn || !count) return;

  let lastSnapshot = null;

  async function tick() {
    if (document.hidden) return;
    try {
      const data = await api.terminals.global();
      lastSnapshot = data;
      const n = (data && data.runningCount) || 0;
      const totalEntries = (data && Array.isArray(data.agents))
        ? data.agents.reduce((a, g) => a + (g.terminals?.length || 0), 0)
        : 0;
      btn.hidden = totalEntries === 0;
      count.textContent = `bg: ${n}`;
      btn.classList.toggle('topbar-bg--active', n > 0);
      btn.classList.toggle('topbar-bg--exited-only', n === 0 && totalEntries > 0);
    } catch {
      // server may not implement the route yet; hide.
      btn.hidden = true;
    }
  }
  btn.addEventListener('click', () => openBgViewer(() => lastSnapshot));
  tick();
  setInterval(tick, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

function openBgViewer(getSnapshot) {
  // Reuse fresh data and re-fetch every 1s while the modal is open.
  const overlay = el('div', { class: 'bgglobal-viewer' });
  const closeBtn = el('button', {
    type: 'button', class: 'bgglobal-viewer__close',
    onclick: () => overlay.remove(),
  }, '×');
  const title = el('div', { class: 'bgglobal-viewer__title' }, 'background processes');
  const body  = el('div', { class: 'bgglobal-viewer__body' });
  overlay.appendChild(el('div', { class: 'bgglobal-viewer__head' }, title, closeBtn));
  overlay.appendChild(body);
  document.body.appendChild(overlay);

  async function render() {
    if (!overlay.isConnected) return;
    let data = getSnapshot && getSnapshot();
    try { data = await api.terminals.global(); } catch { /* keep stale */ }
    body.replaceChildren();
    const groups = (data && Array.isArray(data.agents)) ? data.agents : [];
    if (!groups.length) {
      body.appendChild(el('div', { class: 'bgglobal-viewer__empty' },
        'no background processes are running.'));
      return;
    }
    for (const g of groups) {
      const groupEl = el('div', { class: 'bgglobal-viewer__group' });
      groupEl.appendChild(el('div', { class: 'bgglobal-viewer__group-head' },
        el('span', { class: 'bgglobal-viewer__agent-name' }, g.agentName || g.agentId),
        el('button', {
          type: 'button',
          class: 'bgglobal-viewer__open-conv',
          onclick: () => {
            overlay.remove();
            navigate(`#/agents/${encodeURIComponent(g.agentId)}`);
          },
        }, 'open conversation'),
      ));
      for (const t of (g.terminals || [])) {
        const exited = !!t.exited;
        const code = t.exitStatus && (t.exitStatus.exitCode ?? t.exitStatus.signal);
        const row = el('div', { class: `bgglobal-viewer__term ${exited ? 'bgglobal-viewer__term--exited' : ''}` },
          el('span', { class: 'bgglobal-viewer__term-status' },
            el('span', { class: 'bgglobal-viewer__term-dot' }),
            exited ? `exit ${code ?? '?'}` : 'running'),
          el('div', { class: 'bgglobal-viewer__term-cmd' }, t.command || ''),
          el('div', { class: 'bgglobal-viewer__term-cwd' }, t.cwd || ''),
          el('div', { class: 'bgglobal-viewer__term-actions' },
            (t.url && !exited) && el('a', {
              class: 'bgglobal-viewer__open-url',
              href: t.url,
              target: '_blank',
              rel: 'noopener',
              title: `open ${t.url}`,
            }, `open ↗`),
            el('button', {
              type: 'button', class: 'bgglobal-viewer__open-output',
              onclick: () => {
                // Hand off to the chat view's bg-term viewer by navigating
                // there with a query param the chat view can pick up. For
                // now: navigate to the conversation, the per-conversation
                // strip will be visible and the user can click the chip.
                overlay.remove();
                navigate(`#/agents/${encodeURIComponent(g.agentId)}`);
              },
            }, 'view in conversation'),
            !exited && el('button', {
              type: 'button', class: 'bgglobal-viewer__kill',
              onclick: async (ev) => {
                const btn = ev.currentTarget;
                btn.disabled = true;
                btn.textContent = 'killing...';
                row.classList.add('bgglobal-viewer__term--killing');
                try {
                  await api.terminals.kill(g.agentId, t.id);
                  btn.textContent = 'kill sent';
                  // Replace the status pill text so the user sees an
                  // immediate confirmation before the next poll arrives.
                  const stEl = row.querySelector('.bgglobal-viewer__term-status');
                  if (stEl) {
                    stEl.replaceChildren(
                      el('span', { class: 'bgglobal-viewer__term-dot' }),
                      document.createTextNode('killing'),
                    );
                  }
                } catch (err) {
                  btn.disabled = false;
                  btn.textContent = 'kill failed; retry';
                  btn.title = err.message;
                }
              },
            }, 'kill'),
          ),
        );
        groupEl.appendChild(row);
      }
      body.appendChild(groupEl);
    }
  }

  render();
  const timer = setInterval(() => {
    if (!overlay.isConnected) { clearInterval(timer); return; }
    render();
  }, 1500);
}
