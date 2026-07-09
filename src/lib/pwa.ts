// grok-remote PWA glue.
//
// Responsibilities:
//   1. Register the service worker (secure contexts only).
//   2. Poll for SW updates + server build identity.
//   3. Show a non-dismissable "reload for latest app" toast when an update is ready.
//   4. Capture beforeinstallprompt for one-tap install.
//   5. iOS Safari install hint (no beforeinstallprompt).

interface BeforeInstallPromptEvent extends Event {
  prompt(): void;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' | string; platform?: string }>;
}

interface SafariNavigator extends Navigator {
  standalone?: boolean;
}

declare const __APP_VERSION__: string;

const SW_POLL_MS = 60_000;
const VERSION_POLL_MS = 60_000;

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let bannerEl: HTMLElement | null = null;
let updateBannerEl: HTMLElement | null = null;
let waitingWorker: ServiceWorker | null = null;
let reloading = false;
let baselineKey: string | null = null;

const isIos = (): boolean =>
  typeof navigator !== 'undefined' &&
  /iPad|iPhone|iPod/.test(navigator.userAgent || '');

export function isInstalled(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  if (typeof navigator !== 'undefined' && (navigator as SafariNavigator).standalone === true) return true;
  return false;
}

export function canInstall(): boolean {
  if (isInstalled()) return false;
  if (deferredPrompt) return true;
  if (isIos()) return true;
  return false;
}

function dismissed(): boolean {
  try {
    return sessionStorage.getItem('install-dismissed') === '1';
  } catch {
    return false;
  }
}

function setDismissed(): void {
  try {
    sessionStorage.setItem('install-dismissed', '1');
  } catch { /* ignore */ }
}

function updateBanner(): void {
  if (!bannerEl) bannerEl = document.getElementById('install-banner');
  if (!bannerEl) return;
  // Never compete with a hard app-update toast.
  if (updateBannerEl && !updateBannerEl.hidden) {
    bannerEl.hidden = true;
    return;
  }
  if (canInstall() && !dismissed()) {
    bannerEl.hidden = false;
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

export interface InstallResult {
  outcome: string;
  platform?: string;
}

export async function installApp(): Promise<InstallResult> {
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

export function dismissInstall(): void {
  setDismissed();
  updateBanner();
}

// ── App update banner (non-dismissable) ──────────────────────────────

function ensureUpdateBanner(): HTMLElement {
  if (updateBannerEl) return updateBannerEl;
  let el = document.getElementById('app-update-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-update-banner';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'app-update-banner-label');
    el.hidden = true;
    el.innerHTML = [
      '<span data-role="label" id="app-update-banner-label">A new version of Grok Remote is ready.</span>',
      '<button type="button" data-action="reload">Update now</button>',
    ].join('');
    document.body.appendChild(el);
  }
  if (!el.dataset['wired']) {
    el.dataset['wired'] = '1';
    el.addEventListener('click', (ev: MouseEvent) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      if (t.getAttribute('data-action') === 'reload') {
        ev.preventDefault();
        applyUpdate();
      }
    });
  }
  updateBannerEl = el;
  return el;
}

function showUpdateBanner(reason: string): void {
  const el = ensureUpdateBanner();
  const label = el.querySelector('[data-role="label"]');
  if (label) {
    label.textContent = reason || 'A new version of Grok Remote is ready.';
  }
  el.hidden = false;
  // Hide install banner so the two never stack.
  if (bannerEl) bannerEl.hidden = true;
  else {
    const ib = document.getElementById('install-banner');
    if (ib) ib.hidden = true;
  }
}

function applyUpdate(): void {
  if (reloading) return;
  reloading = true;
  if (waitingWorker) {
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    // controllerchange handler reloads; hard fallback if it never fires.
    setTimeout(() => {
      location.reload();
    }, 1500);
    return;
  }
  // Version-poll path (no waiting SW): hard reload, bypass caches.
  try {
    const u = new URL(location.href);
    u.searchParams.set('_reload', String(Date.now()));
    location.replace(u.toString());
  } catch {
    location.reload();
  }
}

function trackWaitingWorker(worker: ServiceWorker | null): void {
  if (!worker) return;
  waitingWorker = worker;
  if (worker.state === 'installed') {
    showUpdateBanner('A new version of Grok Remote is ready. Tap Update now to load it.');
  }
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed') {
      waitingWorker = worker;
      showUpdateBanner('A new version of Grok Remote is ready. Tap Update now to load it.');
    }
    if (worker.state === 'activated' && reloading) {
      location.reload();
    }
  });
}

// ── Service worker registration + poll ───────────────────────────────

function secureContextForSw(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return true;
  const host = location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !secureContextForSw()) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', {
      updateViaCache: 'none',
    });
    // Already waiting from a previous visit?
    if (reg.waiting) trackWaitingWorker(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          // New SW ready; old one still controlling.
          trackWaitingWorker(installing);
        }
      });
    });

    // When SKIP_WAITING takes effect, reload once.
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });

    navigator.serviceWorker.addEventListener('message', (ev: MessageEvent) => {
      const data = ev.data || {};
      if (data && data.type === 'SW_ACTIVATED' && reloading) {
        location.reload();
      }
    });

    // Periodic update check.
    const poll = (): void => {
      try { void reg.update(); } catch { /* ignore */ }
    };
    setInterval(poll, SW_POLL_MS);
    // Also check when the tab becomes visible again (phone unlock).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') poll();
    });
    // Immediate check shortly after load.
    setTimeout(poll, 5_000);

    return reg;
  } catch {
    return null;
  }
}

// ── Server build-id poll (works on plain HTTP / Tailscale IP) ─────────

interface VersionSnapshot {
  version?: string;
  pkgVersion?: string;
  gitShaShort?: string;
  gitSha?: string;
  builtAt?: string | null;
}

function fingerprint(v: VersionSnapshot | null): string {
  if (!v) return '';
  return [
    v.version || v.pkgVersion || '',
    v.gitShaShort || (v.gitSha || '').slice(0, 7) || '',
    v.builtAt || '',
  ].join('|');
}

async function fetchVersionSnapshot(): Promise<VersionSnapshot | null> {
  try {
    const r = await fetch('/api/version/current', { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as VersionSnapshot;
  } catch {
    return null;
  }
}

async function fetchBuildIdFile(): Promise<string | null> {
  try {
    const r = await fetch('/build-id.txt', { cache: 'no-store' });
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    return t || null;
  } catch {
    return null;
  }
}

function startVersionPoll(): void {
  const tick = async (): Promise<void> => {
    if (updateBannerEl && !updateBannerEl.hidden) return; // already prompting
    const snap = await fetchVersionSnapshot();
    const buildId = await fetchBuildIdFile();
    const key = fingerprint(snap) + (buildId ? `#${buildId}` : '');
    if (!key || key === '#') return;
    if (baselineKey == null) {
      baselineKey = key;
      return;
    }
    if (key !== baselineKey) {
      showUpdateBanner(
        'A new version of Grok Remote was deployed. Tap Update now to load it.',
      );
    }
  };
  void tick();
  setInterval(() => { void tick(); }, VERSION_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void tick();
  });
}

export function registerPwa(): void {
  if (typeof window === 'undefined') return;

  bannerEl = document.getElementById('install-banner');
  ensureUpdateBanner();

  if (bannerEl && !bannerEl.dataset['wired']) {
    bannerEl.dataset['wired'] = '1';
    bannerEl.addEventListener('click', (ev: MouseEvent) => {
      const target = ev.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-action');
      if (action === 'install') {
        ev.preventDefault();
        void installApp();
      } else if (action === 'dismiss') {
        ev.preventDefault();
        dismissInstall();
      }
    });
  }

  window.addEventListener('beforeinstallprompt', (ev: Event) => {
    ev.preventDefault();
    deferredPrompt = ev as BeforeInstallPromptEvent;
    updateBanner();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    setDismissed();
    updateBanner();
  });

  updateBanner();

  // Always poll server build identity — works on http://tailscale-ip where
  // service workers are not allowed (insecure context).
  startVersionPoll();

  // SW update path for https / localhost / installed PWA.
  window.addEventListener('load', () => {
    void registerServiceWorker();
  });
}
