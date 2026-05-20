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

function makeRailIcon({ href, title, area, iconName }) {
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
  return a;
}

function buildLeftRail() {
  const rail = el('nav', { class: 'left-rail', 'aria-label': 'top-level navigation' });
  rail.appendChild(makeRailIcon({
    href: '#/', title: 'conversations', area: 'home', iconName: 'home',
  }));
  for (const p of SYSTEM_PAGES) {
    rail.appendChild(makeRailIcon({
      href: `#/${p.area}`, title: p.label, area: p.area, iconName: p.iconName,
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

  // "Any agent active" indicator on the brand. Listens to the same
  // agents-refresh event the sidebar dispatches and shows a pulsing
  // amber dot whenever at least one agent has inFlight > 0 or is running.
  const brandActive = document.getElementById('brand-active');
  if (brandActive) {
    document.addEventListener('grok-remote:agents-refresh', (ev) => {
      const list = (ev && ev.detail) || [];
      const active = list.some((a) =>
        (typeof a?.inFlight === 'number' && a.inFlight > 0) ||
        (a?.status === 'running')
      );
      brandActive.hidden = !active;
    });
  }

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
