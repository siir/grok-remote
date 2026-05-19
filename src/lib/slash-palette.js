// Slash-command palette for the chat composer.
//
// Usage:
//   const detach = attachSlashPalette({ textarea, getCommands, onCommit });
//   // ... later
//   detach();
//
// Behavior:
//   - Trigger when the textarea content matches /^\/[\w-]*$/ (start of line, v1).
//   - Show a floating panel anchored above the textarea, max 8 items, scrollable.
//   - Filter `getCommands()` by case-insensitive prefix on `name`.
//   - Keyboard: Up/Down highlight, Tab/Enter commit, Esc close.
//   - Click commits.
//   - After commit: inserts `/<name> ` into the textarea, closes the palette,
//     and (if the command has `input.hint`) calls `onCommit({ command, hint })`
//     so the host can render a `usage: /<name> <hint>` caption.
//
// Returns a teardown function that removes listeners and the floating panel.

const VISIBLE_MAX = 8;
const TRIGGER_RE  = /^\/([\w-]*)$/;

export default function attachSlashPalette({ textarea, getCommands, onCommit }) {
  if (!textarea) throw new Error('attachSlashPalette: textarea required');
  if (typeof getCommands !== 'function') throw new Error('attachSlashPalette: getCommands required');

  const panel = document.createElement('div');
  panel.className = 'slash-palette hidden';
  panel.setAttribute('role', 'listbox');
  // Hosted in the composer container, which is position:relative; we anchor
  // above the textarea.
  textarea.parentElement?.appendChild(panel);

  let items = [];           // filtered command list
  let highlight = 0;        // index into items
  let open = false;

  function close() {
    if (!open) return;
    open = false;
    panel.classList.add('hidden');
    panel.replaceChildren();
    items = [];
    highlight = 0;
  }

  function currentQuery() {
    const v = textarea.value || '';
    const m = v.match(TRIGGER_RE);
    return m ? m[1] : null;
  }

  function filterCommands(q) {
    const all = getCommands() || [];
    const lc = (q || '').toLowerCase();
    if (!lc) return all.slice();
    // Prefer prefix matches, then substring matches.
    const prefix = [];
    const substr = [];
    for (const c of all) {
      const name = (c?.name || '').toLowerCase();
      if (!name) continue;
      if (name.startsWith(lc)) prefix.push(c);
      else if (name.includes(lc)) substr.push(c);
    }
    return [...prefix, ...substr];
  }

  function render() {
    panel.replaceChildren();
    if (!items.length) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    const list = items.slice(0, VISIBLE_MAX * 2); // allow scroll past visible
    list.forEach((cmd, idx) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'slash-palette-item' + (idx === highlight ? ' is-active' : '');
      row.setAttribute('role', 'option');
      row.dataset.index = String(idx);

      const name = document.createElement('span');
      name.className = 'sp-name';
      name.textContent = '/' + (cmd?.name || '');

      const desc = document.createElement('span');
      desc.className = 'sp-desc';
      desc.textContent = cmd?.description || '';

      row.appendChild(name);
      row.appendChild(desc);

      row.addEventListener('mousedown', (ev) => {
        // mousedown (not click) so the textarea doesn't lose focus first.
        ev.preventDefault();
        highlight = idx;
        commit();
      });
      row.addEventListener('mouseenter', () => {
        highlight = idx;
        updateActive();
      });

      panel.appendChild(row);
    });
    scrollHighlightIntoView();
  }

  function updateActive() {
    const rows = panel.querySelectorAll('.slash-palette-item');
    rows.forEach((row, idx) => {
      row.classList.toggle('is-active', idx === highlight);
    });
    scrollHighlightIntoView();
  }

  function scrollHighlightIntoView() {
    const row = panel.querySelector('.slash-palette-item.is-active');
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  function maybeOpen() {
    const q = currentQuery();
    if (q === null) { close(); return; }
    items = filterCommands(q);
    if (!items.length) { close(); return; }
    if (highlight >= items.length) highlight = 0;
    open = true;
    render();
  }

  function commit() {
    if (!open || !items.length) return;
    const cmd = items[Math.max(0, Math.min(highlight, items.length - 1))];
    if (!cmd || !cmd.name) { close(); return; }
    const insert = '/' + cmd.name + ' ';
    textarea.value = insert;
    // Place caret at the end.
    try {
      const pos = insert.length;
      textarea.setSelectionRange(pos, pos);
    } catch { /* ignore */ }
    close();
    textarea.focus();
    const hint = cmd?.input?.hint || null;
    if (typeof onCommit === 'function') {
      try { onCommit({ command: cmd, hint }); } catch { /* ignore */ }
    }
    // Trigger an input event so any other listeners (autosize etc.) update.
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function onInput() {
    maybeOpen();
  }

  function onKeydown(ev) {
    if (!open) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (items.length) highlight = (highlight + 1) % items.length;
      updateActive();
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (items.length) highlight = (highlight - 1 + items.length) % items.length;
      updateActive();
      return;
    }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault();
      ev.stopPropagation();
      commit();
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      return;
    }
  }

  function onBlur() {
    // Delay so a mousedown on a palette row can still fire.
    setTimeout(() => {
      if (document.activeElement !== textarea) close();
    }, 120);
  }

  textarea.addEventListener('input', onInput);
  // Use capture so we beat the composer's own Enter handler when the palette
  // is open.
  textarea.addEventListener('keydown', onKeydown, true);
  textarea.addEventListener('blur', onBlur);

  return function detach() {
    textarea.removeEventListener('input', onInput);
    textarea.removeEventListener('keydown', onKeydown, true);
    textarea.removeEventListener('blur', onBlur);
    try { panel.remove(); } catch { /* ignore */ }
  };
}
