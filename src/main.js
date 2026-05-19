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

function parseRoute() {
  const h = (location.hash || '#/').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'agents' && parts[1]) return { name: 'chat', agentId: parts[1] };
  if (parts[0] === 'settings') return { name: 'settings' };
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

function mountDashboard() {
  const host = document.getElementById('app');
  if (!host) return;
  host.replaceChildren();

  let currentAgent = null;
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
  const shell = el('div', { class: 'dashboard' });
  host.appendChild(shell);
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

  // close drawer when a sidebar agent is picked on narrow screens.
  shell.addEventListener('click', (ev) => {
    if (!document.body.hasAttribute('data-drawer-open')) return;
    const target = ev.target;
    if (target && target.closest && target.closest('.sidebar .agent-item')) {
      closeDrawer();
    }
  });

  function renderRoute() {
    const route = parseRoute();
    mainHost.replaceChildren();
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
