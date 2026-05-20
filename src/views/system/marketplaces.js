// Marketplaces page.
//
// Lists every marketplace grok knows about (from the inspect payload).
// Each row shows the name, URL, and any extra metadata the marketplace
// surfaced (last refreshed, plugin count). Most users will see zero
// marketplaces; for them we render an empty state with the CLI hint.
//
// Add/remove flows live in the grok CLI; this page is read-only.

import {
  loadInspect, buildPageShell, setStatusLine, clearBody,
  buildGroup, buildItem, emptyState, buildFooterHint, copyToClipboard,
  shortenPath, scopeLabel,
} from './_native_common.js';

let activeContainer = null;
let aborted = false;

const BLURB = `
  Marketplaces are catalogs of plugins you can browse and install. Each
  marketplace has a name and a source URL (a git repo or HTTPS endpoint).
  Marketplaces are the primary way to discover and add new plugins to
  your grok install; the actual install/remove happens via the CLI.
`;

export async function mount(container) {
  activeContainer = container;
  aborted = false;
  const section = buildPageShell(container, { title: 'Marketplaces', blurb: BLURB });
  await reload(section);
}

export function unmount() {
  aborted = true;
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

async function reload(section) {
  const { inspect, error } = await loadInspect();
  if (aborted) return;
  if (error) { setStatusLine(section, 'failed to load: ' + error); return; }

  const items = Array.isArray(inspect && inspect.marketplaces) ? inspect.marketplaces : [];
  clearBody(section);

  if (!items.length) {
    section.appendChild(emptyState({
      message: 'no marketplaces configured yet.',
      hint: 'add one via the CLI: grok plugins marketplace add <url>',
    }));
    section.appendChild(buildFooterHint(
      'A marketplace is just a manifest pointing at a set of plugins. ' +
      'Once you add one with the CLI, it shows up here with its plugin count.'
    ));
    return;
  }

  // Group by scope. Most installs put marketplaces in user scope.
  const byKey = new Map();
  for (const m of items) {
    const key = String(m.scope || 'user').toLowerCase();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(m);
  }
  for (const [key, list] of byKey) {
    const { wrap, list: listEl } = buildGroup({ label: scopeLabel(key), count: list.length });
    for (const m of list) listEl.appendChild(makeMarketplaceCard(m));
    section.appendChild(wrap);
  }

  section.appendChild(buildFooterHint(
    'Add: <code>grok plugins marketplace add &lt;url&gt;</code>. ' +
    'Refresh + remove flows also live in the CLI.'
  ));
}

function makeMarketplaceCard(m) {
  const tags = [];
  if (typeof m.plugins === 'number') tags.push(`plugins: ${m.plugins}`);
  if (m.lastRefreshed) tags.push(`refreshed: ${m.lastRefreshed}`);
  if (m.scope) tags.push(scopeLabel(m.scope));

  const actions = [];
  if (m.url) {
    actions.push({
      label: 'copy url',
      onClick: async (ev) => {
        const ok = await copyToClipboard(m.url);
        const btn = ev.currentTarget;
        const prior = btn.textContent;
        btn.textContent = ok ? 'copied' : 'copy failed';
        setTimeout(() => { btn.textContent = prior; }, 1500);
      },
    });
  }

  return buildItem({
    primary: m.name || m.id || '(unnamed)',
    secondary: m.url ? 'remote' : 'local',
    tags,
    path: shortenPath(m.url || m.path || ''),
    fullRecord: m,
    actions,
  });
}
