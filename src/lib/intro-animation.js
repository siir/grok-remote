// Hole-to-GR figlet intro animation.
//
// Extracted from main.js so it can be reused inside the chat view as a
// "welcome moment" when a new conversation is opened. The single public
// export `playIntro(targetEl, opts)` renders the frame sequence into the
// given <pre> element and resolves when the final GR figlet has settled.
//
// opts.signal: optional AbortController.signal. If aborted mid-sequence
// the function returns immediately without throwing and without touching
// the element any further (the caller is expected to remove it).

export const FIGLET_GR = [
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

function sleepCancellable(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) { resolve(true); return; }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(true);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function playIntro(figletEl, opts = {}) {
  if (!figletEl) return;
  const signal = opts.signal || null;
  if (signal && signal.aborted) return;

  figletEl.classList.add('figlet--hole');
  for (const { idx, hold, phase } of SEQUENCE) {
    if (signal && signal.aborted) return;
    const frame = HOLE_FRAMES[idx];
    figletEl.innerHTML = frame.map(l => colorizeLine(l, phase)).join('\n');
    const aborted = await sleepCancellable(hold, signal);
    if (aborted) return;
  }
  if (signal && signal.aborted) return;
  figletEl.classList.remove('figlet--hole');
  figletEl.textContent = FIGLET_GR.join('\n');
}
