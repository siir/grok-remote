// Registry of pages routed by the dashboard.
//
// SYSTEM_PAGES are the top-level navigation targets — things the user
// goes to during normal use (chats, observability, monitoring). They
// render in the left-rail.
//
// SETTINGS_PAGES are the configuration / one-time-admin pages. They
// live inside the Settings view's sub-nav (#/settings/<area>) instead
// of the rail. Same shape as SYSTEM_PAGES so the route handler can
// mount them the same way.

import * as mcp       from './mcp.js';
import * as leaders   from './leaders.js';
import * as worktrees from './worktrees.js';
import * as memory    from './memory.js';
import * as models    from './models.js';
import * as health    from './health.js';
import * as sessions  from './sessions.js';
import * as importV   from './import.js';
import * as flow      from './flow.js';
import * as setup     from './setup.js';
import * as skills    from './skills.js';
import * as hooks        from './hooks.js';
import * as nativeAgents from './agents.js';
import * as plugins      from './plugins.js';
import * as marketplaces from './marketplaces.js';
import * as lsp          from './lsp.js';

// Top-level nav (rendered on the left rail).
export const SYSTEM_PAGES = [
  { area: 'memory',   label: 'memory',    iconName: 'memory',   module: memory   },
  { area: 'leaders',  label: 'leaders',   iconName: 'leaders',  module: leaders  },
  { area: 'sessions', label: 'sessions',  iconName: 'sessions', module: sessions },
  { area: 'health',   label: 'health',    iconName: 'health',   module: health   },
  { area: 'flow',     label: 'live flow', iconName: 'flow',     module: flow     },
];

// Sub-pages under Settings (rendered in the settings sub-nav).
// Grouped into sections for the UI; the route is still flat
// (#/settings/<area>).
export const SETTINGS_SECTIONS = [
  {
    title: 'general',
    items: [
      { area: 'general',  label: 'general',       iconName: 'settings' },
    ],
  },
  {
    title: 'native config',
    items: [
      { area: 'skills',       label: 'skills',       iconName: 'skills',   module: skills       },
      { area: 'subagents',    label: 'subagents',    iconName: 'leaders',  module: nativeAgents },
      { area: 'hooks',        label: 'hooks',        iconName: 'flow',     module: hooks        },
      { area: 'plugins',      label: 'plugins',      iconName: 'mcp',      module: plugins      },
      { area: 'marketplaces', label: 'marketplaces', iconName: 'import',   module: marketplaces },
      { area: 'mcp',          label: 'mcp servers',  iconName: 'mcp',      module: mcp          },
      { area: 'lsp',          label: 'lsp servers',  iconName: 'models',   module: lsp          },
      { area: 'models',       label: 'models',       iconName: 'models',   module: models       },
    ],
  },
  {
    title: 'tools',
    items: [
      { area: 'worktrees', label: 'worktrees', iconName: 'worktrees', module: worktrees },
      { area: 'import',    label: 'import',    iconName: 'import',    module: importV   },
      { area: 'setup',     label: 'setup',     iconName: 'setup',     module: setup     },
    ],
  },
];

// Flat lookup of every settings sub-page (including the synthetic 'general'
// one, which has no module since the SettingsView renders its form
// directly).
export const SETTINGS_PAGES = SETTINGS_SECTIONS.flatMap((s) => s.items);

// All routable areas — kept for legacy lookups (e.g. router resolution).
export const ALL_PAGES = [...SYSTEM_PAGES, ...SETTINGS_PAGES];

export function getSystemPage(area) {
  return SYSTEM_PAGES.find((p) => p.area === area) || null;
}

export function getSettingsPage(area) {
  return SETTINGS_PAGES.find((p) => p.area === area) || null;
}

export function getAnyPage(area) {
  return ALL_PAGES.find((p) => p.area === area) || null;
}
