// Registry of top-level "system" pages. Each entry is one page reachable
// from the left-rail nav. Sub-agents fill in the mount() / unmount()
// implementations in their dedicated files; this index just glues them
// together so main.js can render any of them by area name.

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

// label is the short name shown in the nav (tooltip) + accessibility name.
// iconName indexes into src/lib/icons.js (inline SVGs). mount(container, route)
// sets up the view; unmount() tears it down.
export const SYSTEM_PAGES = [
  { area: 'mcp',       label: 'mcp servers',  iconName: 'mcp',       module: mcp       },
  { area: 'memory',    label: 'memory',       iconName: 'memory',    module: memory    },
  { area: 'models',    label: 'models',       iconName: 'models',    module: models    },
  { area: 'leaders',   label: 'leaders',      iconName: 'leaders',   module: leaders   },
  { area: 'worktrees', label: 'worktrees',    iconName: 'worktrees', module: worktrees },
  { area: 'sessions',  label: 'sessions',     iconName: 'sessions',  module: sessions  },
  { area: 'import',    label: 'import',       iconName: 'import',    module: importV   },
  { area: 'health',    label: 'health',       iconName: 'health',    module: health    },
  { area: 'flow',         label: 'live flow',     iconName: 'flow',     module: flow         },
  { area: 'skills',       label: 'skills',        iconName: 'skills',   module: skills       },
  { area: 'subagents',    label: 'subagents',     iconName: 'leaders',  module: nativeAgents },
  { area: 'hooks',        label: 'hooks',         iconName: 'flow',     module: hooks        },
  { area: 'plugins',      label: 'plugins',       iconName: 'mcp',      module: plugins      },
  { area: 'marketplaces', label: 'marketplaces',  iconName: 'import',   module: marketplaces },
  { area: 'lsp',          label: 'lsp servers',   iconName: 'models',   module: lsp          },
  { area: 'setup',        label: 'setup',         iconName: 'setup',    module: setup        },
];

export function getSystemPage(area) {
  return SYSTEM_PAGES.find(p => p.area === area) || null;
}
