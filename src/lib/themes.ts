// Theme registry and persistence.
//
// Themes apply via the `data-theme` attribute on <html>. CSS variables for
// each theme live in style.css under `[data-theme="..."]` selectors. The
// `dark` theme uses the bare `:root` defaults (no `data-theme` override needed
// but we set the attribute anyway for symmetry).
//
// Persistence: localStorage key `grok-remote.theme`.

const STORAGE_KEY = 'grok-remote.theme';
const DEFAULT_THEME = 'dark';

export interface Theme {
  name:   string;
  label:  string;
  blurb:  string;
  accent: string;
  swatch: string;
  chrome: string; // browser titlebar / PWA window color; matches --bg-soft
}

export type ThemeName =
  | 'dark' | 'light' | 'hacker' | 'unicorn'
  | 'nebula' | 'aurora' | 'sunset'
  | 'midnight' | 'carbon' | 'mocha';

export const THEMES: Theme[] = [
  {
    name:    'dark',
    label:   'dark',
    blurb:   'deep blue-black with teal accents (default)',
    accent:  '#5eead4',
    swatch:  '#07090c',
    chrome:  '#0c1117',
  },
  {
    name:    'light',
    label:   'light',
    blurb:   'warm off-white with darker teal/blue accents',
    accent:  '#0d9488',
    swatch:  '#fafafa',
    chrome:  '#ffffff',
  },
  {
    name:    'hacker',
    label:   'hacker',
    blurb:   'pure black with phosphor green text',
    accent:  '#00ff41',
    swatch:  '#000000',
    chrome:  '#050505',
  },
  {
    name:    'unicorn',
    label:   'unicorn',
    blurb:   'pastel rainbow on a lavender-tinted backdrop',
    accent:  '#ff6ec7',
    swatch:  '#f9f7ff',
    chrome:  '#fffafe',
  },
  {
    name:    'nebula',
    label:   'nebula',
    blurb:   'deep indigo with cyan-to-magenta gradient accents',
    accent:  '#a78bfa',
    swatch:  '#0a0814',
    chrome:  '#0e0a1c',
  },
  {
    name:    'aurora',
    label:   'aurora',
    blurb:   'midnight teal with green-to-blue northern-lights glow',
    accent:  '#34d399',
    swatch:  '#06121a',
    chrome:  '#081820',
  },
  {
    name:    'sunset',
    label:   'sunset',
    blurb:   'dusk plum with coral-to-amber accent glow',
    accent:  '#fb7185',
    swatch:  '#150c14',
    chrome:  '#1a0f1a',
  },
  {
    name:    'midnight',
    label:   'midnight',
    blurb:   'deep navy with electric-blue accents',
    accent:  '#60a5fa',
    swatch:  '#070d1a',
    chrome:  '#0a1224',
  },
  {
    name:    'carbon',
    label:   'carbon',
    blurb:   'graphite charcoal with orange accents',
    accent:  '#fb923c',
    swatch:  '#0c0c0d',
    chrome:  '#111114',
  },
  {
    name:    'mocha',
    label:   'mocha',
    blurb:   'dark espresso brown with caramel accents',
    accent:  '#e0a575',
    swatch:  '#15110d',
    chrome:  '#1b1611',
  },
];

const NAMES: string[] = THEMES.map((t) => t.name);

function isValid(name: unknown): name is string {
  return typeof name === 'string' && NAMES.includes(name);
}

export function getTheme(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isValid(v)) return v;
  } catch { /* ignore */ }
  return DEFAULT_THEME;
}

export function setTheme(name: string): string {
  const n = isValid(name) ? name : DEFAULT_THEME;
  try { localStorage.setItem(STORAGE_KEY, n); } catch { /* ignore */ }
  applyTheme(n);
  return n;
}

/** Themes that should use the light system color-scheme (native scrollbars). */
const LIGHT_SCHEMES = new Set(['light', 'unicorn']);

export function applyTheme(name: string): string {
  const n = isValid(name) ? name : DEFAULT_THEME;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.theme = n;
    // Keep native scrollbars/form controls in sync with the page palette
    // (avoids a light macOS scrollbar strip on dark themes).
    document.documentElement.style.colorScheme = LIGHT_SCHEMES.has(n) ? 'light' : 'dark';
    // Browser titlebar / PWA window chrome follows the active theme.
    const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (meta) meta.content = getThemeMeta(n).chrome;
  }
  return n;
}

export function nextTheme(current: string): string {
  const cur = isValid(current) ? current : getTheme();
  const idx = NAMES.indexOf(cur);
  const next = NAMES[(idx + 1) % NAMES.length] ?? DEFAULT_THEME;
  setTheme(next);
  return next;
}

export function getThemeMeta(name: string): Theme {
  return THEMES.find((t) => t.name === name) ?? THEMES[0]!;
}
