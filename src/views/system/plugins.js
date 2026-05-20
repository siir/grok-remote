// Plugins page.
//
// Lists every plugin grok knows about (from the inspect payload), sorted
// enabled-first. Each row exposes the name, version, scope, an
// enabled/disabled badge, and a `provides` summary (skills/agents/mcp/
// hooks counts). Click to expand for the full record.
//
// We do NOT toggle plugins on/off from the dashboard. Plugins live in
// config.toml under `[plugins.<name>]`; writing TOML in-place is deferred
// to a later commit. For now, "copy disable" emits a snippet the user can
// paste into config.toml manually.

import {
  loadInspect, buildPageShell, setStatusLine, clearBody,
  addConfigFilesBanner,
  buildGroup, buildItem, emptyState, buildFooterHint, copyToClipboard,
  shortenPath, scopeLabel,
} from './_native_common.js';

let activeContainer = null;
let aborted = false;

const BLURB = `
  Plugins bundle skills, subagents, MCP servers, and hooks into a single
  installable unit. Each plugin lives in its own directory and is listed
  in your config. Toggle them on or off (in <code>config.toml</code>) to
  control what's loaded into your sessions. Use the CLI to install a new
  plugin; the dashboard is for inspecting and disabling what's already
  there.
`;

export async function mount(container) {
  activeContainer = container;
  aborted = false;
  const section = buildPageShell(container, { title: 'Plugins', blurb: BLURB });
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

  const plugins = Array.isArray(inspect && inspect.plugins) ? inspect.plugins : [];
  const cs = (inspect && inspect.configSources) || {};
  addConfigFilesBanner(section, [
    cs.userPath && { label: 'user config', path: cs.userPath },
    ...(Array.isArray(cs.projectPaths) ? cs.projectPaths.map(p => ({ label: 'project config', path: p })) : []),
  ].filter(Boolean));
  clearBody(section);

  if (!plugins.length) {
    section.appendChild(emptyState({
      message: 'no plugins installed.',
      hint: 'install one via the CLI: grok plugins add <path-or-url>',
    }));
    return;
  }

  // Sort enabled first, then by name.
  const sorted = [...plugins].sort((a, b) => {
    const ea = a.enabled === false ? 1 : 0;
    const eb = b.enabled === false ? 1 : 0;
    if (ea !== eb) return ea - eb;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  const enabled  = sorted.filter(p => p.enabled !== false);
  const disabled = sorted.filter(p => p.enabled === false);

  if (enabled.length) {
    const { wrap, list } = buildGroup({ label: 'enabled', count: enabled.length });
    for (const p of enabled) list.appendChild(makePluginCard(p));
    section.appendChild(wrap);
  }
  if (disabled.length) {
    const { wrap, list } = buildGroup({ label: 'disabled', count: disabled.length, openByDefault: false });
    for (const p of disabled) list.appendChild(makePluginCard(p));
    section.appendChild(wrap);
  }

  section.appendChild(buildFooterHint(
    'Install plugins via the CLI: <code>grok plugins add &lt;path&gt;</code>. ' +
    'Disabling a plugin writes <code>[plugins.&lt;name&gt;] enabled = false</code> to ' +
    'config.toml; in-place edits from the dashboard are not yet wired up, so use the ' +
    '"copy disable line" button and paste manually.'
  ));
}

function makePluginCard(p) {
  const provides = p.provides || {};
  const tags = [];
  if (p.version) tags.push(`v${p.version}`);
  if (p.scope) tags.push(scopeLabel(p.scope));
  if (provides.skills)     tags.push(`skills: ${provides.skills}`);
  if (provides.agents)     tags.push(`agents: ${provides.agents}`);
  if (provides.mcpServers) tags.push(`mcp: ${provides.mcpServers}`);
  if (provides.hooks)      tags.push('hooks');

  const enabled = p.enabled !== false;
  const actions = [{
    label: enabled ? 'copy disable' : 'copy enable',
    title: enabled
      ? 'copy a [plugins.<name>] enabled = false snippet for config.toml'
      : 'copy a [plugins.<name>] enabled = true snippet for config.toml',
    onClick: async (ev) => {
      const snippet = `[plugins.${tomlKey(p.name)}]\nenabled = ${enabled ? 'false' : 'true'}\n`;
      const ok = await copyToClipboard(snippet);
      const btn = ev.currentTarget;
      const prior = btn.textContent;
      btn.textContent = ok ? 'copied' : 'copy failed';
      setTimeout(() => { btn.textContent = prior; }, 1500);
    },
  }];

  return buildItem({
    primary: p.name || '(unnamed)',
    secondary: enabled ? 'enabled' : 'disabled',
    secondaryClass: enabled ? 'health-good' : 'health-warn',
    tags,
    path: p.path ? shortenPath(p.path) : '',
    sourceLabel: p.scope ? `installed in ${scopeLabel(p.scope)}:` : 'installed at:',
    sourcePath: p.path || '',
    fullRecord: p,
    actions,
  });
}

function tomlKey(name) {
  // Bare keys must match [A-Za-z0-9_-]+; otherwise wrap in quotes.
  if (typeof name !== 'string' || !name) return '"_"';
  if (/^[A-Za-z0-9_-]+$/.test(name)) return name;
  return '"' + name.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
