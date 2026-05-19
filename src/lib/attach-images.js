// Image attachment manager for the chat composer.
//
// Usage:
//   const ctl = setupImageAttach({ container, textarea, fileInput,
//                                  canAttachImages, onChange });
//   ctl.getAttachments() => [{ kind:'image', name, size, mimeType, dataBase64 }]
//   ctl.clear()          - wipe all attachments and re-render
//   ctl.refreshSupport() - re-evaluate canAttachImages() and re-render notice
//   ctl.destroy()        - detach all listeners and remove DOM
//
// Sources:
//   - Paste: clipboard images pasted into `textarea` are captured.
//   - File input: clicking the host-rendered "Attach image" button opens
//     `fileInput` (a hidden <input type=file accept=image/* multiple>).
//   - Drag and drop: image files dropped on `container` are captured.
//
// Validation: <=5 attachments total, each <=5 MB, MIME must be one of
// image/png|jpeg|webp|gif. Rejections are surfaced via onChange's `error`.
//
// `canAttachImages` is a function returning bool (the active agent's
// promptCapabilities.image). When false, attachments are blocked at the
// source and a muted notice is rendered.

const MAX_ATTACHMENTS = 5;
const MAX_BYTES       = 5 * 1024 * 1024;
const ALLOWED_MIME    = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
]);

export function setupImageAttach({
  container,
  textarea,
  fileInput,
  canAttachImages,
  onChange,
} = {}) {
  if (!container) throw new Error('setupImageAttach: container required');

  const supported = typeof canAttachImages === 'function'
    ? canAttachImages
    : () => true;

  const pills = document.createElement('div');
  pills.className = 'attach-pills hidden';
  container.appendChild(pills);

  const notice = document.createElement('div');
  notice.className = 'attach-notice hidden';
  notice.textContent = 'This model does not support image input.';
  container.appendChild(notice);

  /** @type {{ id:string, kind:'image', name:string, size:number, mimeType:string, dataBase64:string, dataUrl:string }[]} */
  let attachments = [];
  let nextId = 1;
  let destroyed = false;

  function emit(event) {
    if (typeof onChange !== 'function') return;
    try { onChange({ attachments: attachments.slice(), ...(event || {}) }); }
    catch { /* ignore */ }
  }

  function emitError(msg) {
    emit({ error: msg });
  }

  function fmtSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function render() {
    pills.replaceChildren();
    if (!attachments.length) {
      pills.classList.add('hidden');
    } else {
      pills.classList.remove('hidden');
      for (const att of attachments) {
        const pill = document.createElement('div');
        pill.className = 'attach-pill';
        pill.dataset.id = att.id;

        const thumb = document.createElement('img');
        thumb.className = 'attach-pill-thumb';
        thumb.src = att.dataUrl;
        thumb.alt = att.name;
        pill.appendChild(thumb);

        const meta = document.createElement('div');
        meta.className = 'attach-pill-meta';
        const nm = document.createElement('div');
        nm.className = 'attach-pill-name';
        nm.textContent = att.name;
        const sz = document.createElement('div');
        sz.className = 'attach-pill-size';
        sz.textContent = fmtSize(att.size);
        meta.appendChild(nm);
        meta.appendChild(sz);
        pill.appendChild(meta);

        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'attach-pill-remove';
        rm.setAttribute('aria-label', 'remove attachment');
        rm.textContent = 'x';
        rm.addEventListener('click', (ev) => {
          ev.preventDefault();
          removeAttachment(att.id);
        });
        pill.appendChild(rm);

        pills.appendChild(pill);
      }
    }
    renderNotice();
  }

  function renderNotice() {
    const ok = supported();
    if (!ok && (attachments.length > 0 || true)) {
      notice.classList.remove('hidden');
    } else {
      notice.classList.add('hidden');
    }
    // Allow callers to hide notice when there's no agent (`supported` may
    // return true by default); the host wires this via refreshSupport().
  }

  function removeAttachment(id) {
    const before = attachments.length;
    attachments = attachments.filter(a => a.id !== id);
    if (attachments.length !== before) {
      render();
      emit({});
    }
  }

  async function readAsDataUrl(blob) {
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error || new Error('read failed'));
      r.readAsDataURL(blob);
    });
  }

  function pickName(blob, fallback) {
    if (blob && typeof blob.name === 'string' && blob.name) return blob.name;
    const ext = (blob && blob.type && blob.type.split('/')[1]) || 'bin';
    return `${fallback || 'pasted'}-${Date.now()}.${ext}`;
  }

  async function addBlob(blob, suggestedName) {
    if (!supported()) {
      emitError('This model does not support image input.');
      renderNotice();
      return false;
    }
    if (attachments.length >= MAX_ATTACHMENTS) {
      emitError(`Attachment limit (${MAX_ATTACHMENTS}) reached.`);
      return false;
    }
    if (!blob) return false;
    const mime = blob.type || '';
    if (!ALLOWED_MIME.has(mime)) {
      emitError(`Unsupported image type: ${mime || 'unknown'}.`);
      return false;
    }
    if (blob.size > MAX_BYTES) {
      emitError(`Image is too large (max ${Math.round(MAX_BYTES / (1024 * 1024))} MB).`);
      return false;
    }
    let dataUrl;
    try { dataUrl = await readAsDataUrl(blob); }
    catch (err) { emitError(`Failed to read image: ${err.message}`); return false; }
    const comma = dataUrl.indexOf(',');
    const dataBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
    const name = pickName(blob, suggestedName);
    const att = {
      id: 'att-' + (nextId++),
      kind: 'image',
      name,
      size: blob.size,
      mimeType: mime,
      dataBase64,
      dataUrl,
    };
    attachments.push(att);
    render();
    emit({});
    return true;
  }

  async function addFiles(files, sourceLabel) {
    if (!files || !files.length) return;
    for (const f of files) {
      if (destroyed) return;
      await addBlob(f, sourceLabel);
    }
  }

  // ── paste ───────────────────────────────────────────────────
  async function onPaste(ev) {
    if (destroyed) return;
    const items = ev?.clipboardData?.items;
    if (!items || !items.length) return;
    const blobs = [];
    for (const it of items) {
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) blobs.push(f);
      }
    }
    if (!blobs.length) return;
    // Image found: prevent default (don't paste path text).
    ev.preventDefault();
    for (const b of blobs) {
      await addBlob(b, 'pasted');
    }
  }

  // ── drag-and-drop ───────────────────────────────────────────
  let dragDepth = 0;
  function onDragEnter(ev) {
    if (!hasImageDrag(ev)) return;
    ev.preventDefault();
    dragDepth++;
    container.classList.add('attach-dropping');
  }
  function onDragOver(ev) {
    if (!hasImageDrag(ev)) return;
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = 'copy'; } catch { /* ignore */ }
  }
  function onDragLeave(ev) {
    if (!hasImageDrag(ev)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) container.classList.remove('attach-dropping');
  }
  async function onDrop(ev) {
    if (!ev.dataTransfer) return;
    const files = Array.from(ev.dataTransfer.files || []).filter(f => f.type && f.type.startsWith('image/'));
    if (!files.length) {
      // Let other handlers (e.g. text drops) process normally.
      dragDepth = 0;
      container.classList.remove('attach-dropping');
      return;
    }
    ev.preventDefault();
    dragDepth = 0;
    container.classList.remove('attach-dropping');
    await addFiles(files, 'dropped');
  }
  function hasImageDrag(ev) {
    const types = ev?.dataTransfer?.types;
    if (!types) return false;
    // Some browsers expose only "Files" for image drags.
    for (const t of types) {
      if (t === 'Files' || (typeof t === 'string' && t.startsWith('image/'))) return true;
    }
    return false;
  }

  // ── file input ──────────────────────────────────────────────
  async function onFileChange(ev) {
    const files = ev?.target?.files;
    if (!files || !files.length) return;
    await addFiles(Array.from(files), 'file');
    try { ev.target.value = ''; } catch { /* ignore */ }
  }

  // attach listeners
  if (textarea) textarea.addEventListener('paste', onPaste);
  container.addEventListener('dragenter', onDragEnter);
  container.addEventListener('dragover',  onDragOver);
  container.addEventListener('dragleave', onDragLeave);
  container.addEventListener('drop',      onDrop);
  if (fileInput) fileInput.addEventListener('change', onFileChange);

  // initial render (mostly the notice when unsupported)
  render();

  return {
    getAttachments() {
      return attachments.map(a => ({
        kind: a.kind,
        name: a.name,
        size: a.size,
        mimeType: a.mimeType,
        dataBase64: a.dataBase64,
      }));
    },
    clear() {
      if (!attachments.length) { renderNotice(); return; }
      attachments = [];
      render();
      emit({});
    },
    refreshSupport() {
      renderNotice();
    },
    isSupported() { return supported(); },
    destroy() {
      destroyed = true;
      if (textarea) textarea.removeEventListener('paste', onPaste);
      container.removeEventListener('dragenter', onDragEnter);
      container.removeEventListener('dragover',  onDragOver);
      container.removeEventListener('dragleave', onDragLeave);
      container.removeEventListener('drop',      onDrop);
      if (fileInput) fileInput.removeEventListener('change', onFileChange);
      try { pills.remove(); } catch { /* ignore */ }
      try { notice.remove(); } catch { /* ignore */ }
      attachments = [];
    },
  };
}
