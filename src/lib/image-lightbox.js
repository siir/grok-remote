// Image lightbox.
//
// Opens an image fullscreen-ish in a modal. Click outside the image,
// press Escape, or click the close button to dismiss. Single instance
// at a time; opening a new one replaces the current one.

import { el } from './render.js';

let active = null;

export function openImageLightbox(src, alt = '') {
  closeImageLightbox();
  if (!src) return;

  const img = el('img', {
    class: 'image-lightbox__img',
    src,
    alt,
    onclick: (ev) => { ev.stopPropagation(); },
  });

  const closeBtn = el('button', {
    type: 'button',
    class: 'image-lightbox__close',
    title: 'close',
    'aria-label': 'close',
    onclick: closeImageLightbox,
  }, '×');

  const overlay = el('div', {
    class: 'image-lightbox',
    role: 'dialog',
    'aria-label': alt || 'image preview',
    onclick: closeImageLightbox,
  }, img, closeBtn);

  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
  // Lock body scroll while the lightbox is up.
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  active = { overlay, prevOverflow };
  // Trigger the fade-in on next frame so the transition runs.
  requestAnimationFrame(() => overlay.classList.add('image-lightbox--show'));
}

export function closeImageLightbox() {
  if (!active) return;
  const { overlay, prevOverflow } = active;
  active = null;
  document.removeEventListener('keydown', onKey);
  document.body.style.overflow = prevOverflow || '';
  overlay.classList.remove('image-lightbox--show');
  // Wait for the fade-out before removing so the user sees the
  // transition. Match the CSS duration.
  setTimeout(() => {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }, 160);
}

function onKey(ev) {
  if (ev.key === 'Escape') closeImageLightbox();
}
