// grok-remote PWA glue.
//
// Responsibilities:
//   1. Register the service worker (when allowed by browser + protocol).
//   2. Capture the `beforeinstallprompt` event for one-tap install.
//   3. Drive the #install-banner element (show/hide, button wiring).
//   4. Provide a manual hint for iOS Safari, which never fires the prompt event.

let deferredPrompt = null;
let bannerEl = null;

const isIos = () =>
  typeof navigator !== 'undefined' &&
  /iPad|iPhone|iPod/.test(navigator.userAgent || '');

export function isInstalled() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  // iOS Safari exposes navigator.standalone instead.
  if (typeof navigator !== 'undefined' && navigator.standalone === true) return true;
  return false;
}

export function canInstall() {
  if (isInstalled()) return false;
  if (deferredPrompt) return true;
  // iOS users have no prompt API, but they can still install via Share sheet.
  if (isIos()) return true;
  return false;
}

function dismissed() {
  try {
    return sessionStorage.getItem('install-dismissed') === '1';
  } catch {
    return false;
  }
}

function setDismissed() {
  try {
    sessionStorage.setItem('install-dismissed', '1');
  } catch {}
}

function updateBanner() {
  if (!bannerEl) bannerEl = document.getElementById('install-banner');
  if (!bannerEl) return;
  if (canInstall() && !dismissed()) {
    bannerEl.hidden = false;
    // Tweak label/hint for iOS where there is no prompt API.
    const label = bannerEl.querySelector('[data-role="label"]');
    const installBtn = bannerEl.querySelector('[data-action="install"]');
    if (isIos() && !deferredPrompt) {
      if (label) label.textContent = 'Install: tap Share, then Add to Home Screen.';
      if (installBtn) installBtn.textContent = 'Got it';
    } else {
      if (label) label.textContent = 'Install Grok Remote as an app.';
      if (installBtn) installBtn.textContent = 'Install';
    }
  } else {
    bannerEl.hidden = true;
  }
}

export async function installApp() {
  // iOS path: no prompt API, just acknowledge so the banner can be dismissed.
  if (isIos() && !deferredPrompt) {
    setDismissed();
    updateBanner();
    return { outcome: 'ios-hint' };
  }
  if (!deferredPrompt) return { outcome: 'unavailable' };
  try {
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (choice && choice.outcome === 'accepted') {
      setDismissed();
    }
    updateBanner();
    return choice || { outcome: 'unknown' };
  } catch {
    deferredPrompt = null;
    updateBanner();
    return { outcome: 'error' };
  }
}

export function dismissInstall() {
  setDismissed();
  updateBanner();
}

export function registerPwa() {
  if (typeof window === 'undefined') return;

  // Wire banner buttons (idempotent).
  bannerEl = document.getElementById('install-banner');
  if (bannerEl && !bannerEl.dataset.wired) {
    bannerEl.dataset.wired = '1';
    bannerEl.addEventListener('click', (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-action');
      if (action === 'install') {
        ev.preventDefault();
        installApp();
      } else if (action === 'dismiss') {
        ev.preventDefault();
        dismissInstall();
      }
    });
  }

  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    deferredPrompt = ev;
    updateBanner();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    setDismissed();
    updateBanner();
  });

  // Initial render (covers iOS path where the prompt event never fires).
  updateBanner();

  // Register the service worker on https or localhost only.
  if ('serviceWorker' in navigator) {
    const host = location.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (location.protocol === 'https:' || isLocal) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
          // swallow; SW registration is best-effort.
        });
      });
    }
  }
}
