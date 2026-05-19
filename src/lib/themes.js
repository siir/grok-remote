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

export const THEMES = [
  {
    name:    'dark',
    label:   'dark',
    blurb:   'deep blue-black with teal accents (default)',
    accent:  '#5eead4',
    swatch:  '#07090c',
  },
  {
    name:    'light',
    label:   'light',
    blurb:   'warm off-white with darker teal/blue accents',
    accent:  '#0d9488',
    swatch:  '#fafafa',
  },
  {
    name:    'hacker',
    label:   'hacker',
    blurb:   'pure black with phosphor green text',
    accent:  '#00ff41',
    swatch:  '#000000',
  },
  {
    name:    'unicorn',
    label:   'unicorn',
    blurb:   'pastel rainbow on a lavender-tinted backdrop',
    accent:  '#ff6ec7',
    swatch:  '#f9f7ff',
  },
];

const NAMES = THEMES.map(t => t.name);

function isValid(name) {
  return typeof name === 'string' && NAMES.includes(name);
}

export function getTheme() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isValid(v)) return v;
  } catch {}
  return DEFAULT_THEME;
}

export function setTheme(name) {
  const n = isValid(name) ? name : DEFAULT_THEME;
  try { localStorage.setItem(STORAGE_KEY, n); } catch {}
  applyTheme(n);
  return n;
}

export function applyTheme(name) {
  const n = isValid(name) ? name : DEFAULT_THEME;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.theme = n;
  }
  return n;
}

export function nextTheme(current) {
  const cur = isValid(current) ? current : getTheme();
  const idx = NAMES.indexOf(cur);
  const next = NAMES[(idx + 1) % NAMES.length];
  setTheme(next);
  return next;
}

export function getThemeMeta(name) {
  return THEMES.find(t => t.name === name) || THEMES[0];
}
