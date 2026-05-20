// Skills management page.
//
// Lists every skill grok discovers on this machine: per-cwd (.grok/skills/),
// repo-shared (<repo-root>/.grok/skills/), user-wide (~/.grok/skills/), and
// Claude-Code compatibility (~/.claude/skills/).
//
// Each skill is rendered as a card with its name, short description, scope
// badge, and an "open SKILL.md" affordance that fetches the file inline.
//
// Per-conversation enable/disable is intentionally out of scope here:
// grok's own [skills] config drives discovery, and the per-agent settings
// drawer already exposes --tools / --disallowed-tools for sharper control.

import { api } from '../../lib/api.js';

let activeContainer = null;
let aborted = false;

const SCOPE_LABEL = {
  'cwd':          'cwd',
  'repo':         'repo',
  'user-grok':    '~/.grok',
  'user-claude':  '~/.claude',
};

export async function mount(container) {
  activeContainer = container;
  aborted = false;
  container.replaceChildren();
  container.innerHTML = `
    <section class="system-page skills-page">
      <header class="system-page-header">
        <h2 class="system-page-title">Skills</h2>
        <p class="system-page-sub">
          Reusable prompt packages grok discovers under <code>.grok/skills/</code>.
          Invoked by the agent via <code>/&lt;name&gt;</code> when relevant.
          Scope priority (high to low): cwd, repo, ~/.grok, ~/.claude.
        </p>
      </header>
      <div class="skills-loading">loading skills...</div>
    </section>
  `;
  const sectionEl = container.querySelector('.skills-page');

  try {
    const data = await api.skills.list();
    if (aborted || activeContainer !== container) return;
    if (!data || !data.ok) {
      sectionEl.innerHTML += `<div class="system-page-empty">failed to load: ${escapeHtml((data && data.error) || 'unknown')}</div>`;
      return;
    }
    render(sectionEl, data);
  } catch (err) {
    if (aborted || activeContainer !== container) return;
    sectionEl.querySelector('.skills-loading')?.remove();
    sectionEl.innerHTML += `<div class="system-page-empty">failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

export function unmount() {
  aborted = true;
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

function render(sectionEl, data) {
  sectionEl.querySelector('.skills-loading')?.remove();
  const skills = Array.isArray(data.skills) ? data.skills : [];
  const sources = Array.isArray(data.sources) ? data.sources : [];

  // Build sources summary (small chips).
  const sourcesEl = document.createElement('div');
  sourcesEl.className = 'skills-sources';
  for (const s of sources) {
    const chip = document.createElement('span');
    chip.className = `skills-source-chip skills-scope--${s.scope}`;
    chip.textContent = `${SCOPE_LABEL[s.scope] || s.scope}: ${shortenPath(s.dir)}`;
    sourcesEl.appendChild(chip);
  }
  sectionEl.appendChild(sourcesEl);

  if (!skills.length) {
    const empty = document.createElement('div');
    empty.className = 'system-page-empty';
    empty.textContent = 'no skills found in any of the scopes above.';
    sectionEl.appendChild(empty);
    return;
  }

  // Group by scope.
  const grouped = new Map();
  for (const s of skills) {
    if (!grouped.has(s.scope)) grouped.set(s.scope, []);
    grouped.get(s.scope).push(s);
  }
  const scopeOrder = ['cwd', 'repo', 'user-grok', 'user-claude'];
  for (const scope of scopeOrder) {
    const items = grouped.get(scope);
    if (!items || !items.length) continue;
    const group = document.createElement('section');
    group.className = 'skills-group';
    group.innerHTML = `<h3 class="skills-group-title">${escapeHtml(SCOPE_LABEL[scope] || scope)}</h3>`;
    const grid = document.createElement('div');
    grid.className = 'skills-grid';
    for (const sk of items.sort((a, b) => a.name.localeCompare(b.name))) {
      grid.appendChild(makeCard(sk));
    }
    group.appendChild(grid);
    sectionEl.appendChild(group);
  }
}

function makeCard(sk) {
  const card = document.createElement('article');
  card.className = `skills-card skills-scope--${sk.scope}`;
  const desc = sk.shortDescription || sk.description || '(no description)';
  card.innerHTML = `
    <header class="skills-card-head">
      <span class="skills-card-name">/${escapeHtml(sk.name)}</span>
      <span class="skills-card-scope">${escapeHtml(SCOPE_LABEL[sk.scope] || sk.scope)}</span>
    </header>
    <p class="skills-card-desc">${escapeHtml(desc)}</p>
    <footer class="skills-card-foot">
      <span class="skills-card-path" title="${escapeHtml(sk.mdPath)}">${escapeHtml(shortenPath(sk.dir))}</span>
      <button type="button" class="skills-card-open">view SKILL.md</button>
    </footer>
    <pre class="skills-card-body hidden"></pre>
  `;
  const btn = card.querySelector('.skills-card-open');
  const body = card.querySelector('.skills-card-body');
  btn.addEventListener('click', async () => {
    if (!body.classList.contains('hidden')) {
      body.classList.add('hidden');
      btn.textContent = 'view SKILL.md';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'loading...';
    try {
      const r = await api.skills.read(sk.mdPath);
      if (r && r.ok) {
        body.textContent = r.content;
        body.classList.remove('hidden');
        btn.textContent = 'hide';
      } else {
        body.textContent = `error: ${(r && r.error) || 'unknown'}`;
        body.classList.remove('hidden');
        btn.textContent = 'retry';
      }
    } catch (err) {
      body.textContent = `error: ${err.message}`;
      body.classList.remove('hidden');
      btn.textContent = 'retry';
    } finally {
      btn.disabled = false;
    }
  });
  return card;
}

function shortenPath(p) {
  if (!p) return '';
  const home = '/Users/dan'; // best effort; the server reports absolute paths
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
