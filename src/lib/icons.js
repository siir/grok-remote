// Centralized inline SVG icons. Stroke-based, currentColor, 1.5px stroke,
// 20x20 viewBox. The rail and any other surface can drop one in by name.
//
// Why inline instead of an SVG sprite or icon font:
//  - Zero new deps and zero network round trips.
//  - currentColor lets every icon track the active theme without per-icon
//    CSS.
//  - Each definition is small (~150 chars) so the bundle hit is trivial.

const W = 20, H = 20, BASE = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

function wrap(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" aria-hidden="true" ${BASE}>${inner}</svg>`;
}

export const ICONS = {
  // home / conversations: chat bubble
  home: wrap(`
    <path d="M3.5 4.5h13a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 3v-3h-1A1.5 1.5 0 0 1 2 13V6a1.5 1.5 0 0 1 1.5-1.5z"/>
  `),

  // mcp: two interlocking sockets (a plug + a port)
  mcp: wrap(`
    <rect x="2.5" y="6.5" width="6" height="7" rx="1.5"/>
    <rect x="11.5" y="6.5" width="6" height="7" rx="1.5"/>
    <path d="M8.5 10h3"/>
    <path d="M5.5 4.5v2M5.5 13.5v2M14.5 4.5v2M14.5 13.5v2"/>
  `),

  // memory: stack of disks
  memory: wrap(`
    <ellipse cx="10" cy="5.5" rx="6" ry="2"/>
    <path d="M4 5.5v3c0 1.1 2.7 2 6 2s6-.9 6-2v-3"/>
    <path d="M4 8.5v3c0 1.1 2.7 2 6 2s6-.9 6-2v-3"/>
    <path d="M4 11.5v3c0 1.1 2.7 2 6 2s6-.9 6-2v-3"/>
  `),

  // models: stacked cards
  models: wrap(`
    <rect x="4" y="6" width="12" height="9" rx="1.5"/>
    <path d="M5.5 4h9M6.5 2h7"/>
  `),

  // leaders: layered figure + crown dot
  leaders: wrap(`
    <circle cx="10" cy="6.5" r="2.5"/>
    <path d="M4 16c0-2.8 2.7-5 6-5s6 2.2 6 5"/>
    <circle cx="10" cy="3" r="0.6" fill="currentColor"/>
  `),

  // worktrees: git branch
  worktrees: wrap(`
    <circle cx="5.5" cy="4.5" r="1.8"/>
    <circle cx="5.5" cy="15.5" r="1.8"/>
    <circle cx="14.5" cy="10" r="1.8"/>
    <path d="M5.5 6.3v7.4"/>
    <path d="M5.5 10c0-2.5 2-4.5 4.5-4.5h3"/>
  `),

  // sessions: clock with chevron history
  sessions: wrap(`
    <circle cx="10" cy="10" r="7"/>
    <path d="M10 6v4l2.5 2"/>
  `),

  // import: tray with downward arrow
  import: wrap(`
    <path d="M10 3v9"/>
    <path d="M6.5 8.5L10 12l3.5-3.5"/>
    <path d="M4 14.5v1A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-1"/>
  `),

  // health: heart + pulse
  health: wrap(`
    <path d="M10 16.5s-6-3.7-6-8.2A3.3 3.3 0 0 1 10 6a3.3 3.3 0 0 1 6 2.3c0 4.5-6 8.2-6 8.2z"/>
  `),

  // flow: node graph
  flow: wrap(`
    <circle cx="4" cy="6" r="1.8"/>
    <circle cx="16" cy="6" r="1.8"/>
    <circle cx="10" cy="14" r="1.8"/>
    <path d="M5.4 7l3.5 5.4"/>
    <path d="M14.6 7l-3.5 5.4"/>
    <path d="M5.8 6h8.4"/>
  `),

  // setup: gear (simple)
  setup: wrap(`
    <circle cx="10" cy="10" r="2.5"/>
    <path d="M10 2.5v2.3M10 15.2v2.3M2.5 10h2.3M15.2 10h2.3M4.6 4.6l1.6 1.6M13.8 13.8l1.6 1.6M4.6 15.4l1.6-1.6M13.8 6.2l1.6-1.6"/>
  `),

  // skills: lightning bolt
  skills: wrap(`
    <path d="M11.5 2L4 11.5h5L8.5 18 16 8.5h-5z"/>
  `),

  // settings (topbar): sliders
  settings: wrap(`
    <path d="M4 5h6M14 5h2"/>
    <path d="M4 10h2M10 10h6"/>
    <path d="M4 15h8M16 15h0"/>
    <circle cx="12" cy="5" r="1.4"/>
    <circle cx="8" cy="10" r="1.4"/>
    <circle cx="14" cy="15" r="1.4"/>
  `),
};

export function iconHtml(name) {
  return ICONS[name] || '';
}
