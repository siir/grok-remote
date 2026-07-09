// grok-remote service worker.
//
// Caching strategy:
//   - app shell: precache "/" and "/index.html" on install.
//   - /api/*: network-first, never cached (live data).
//   - other same-origin GETs: network-first with cache fallback (prefer fresh UI).
//
// Updates:
//   - CACHE name is rewritten at build time (see vite.config.ts) so each
//     deploy produces a new SW byte stream → browser detects an update.
//   - Clients call registration.update() on an interval.
//   - Waiting SW activates when the page posts { type: 'SKIP_WAITING' }.

/* BUILD_ID is replaced at build time; leave a stable default for `vite` dev. */
const BUILD_ID = 'dev';
const CACHE = 'gr-shell-' + BUILD_ID;
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL_URLS)).catch(() => {
      // Shell precache is best-effort; activate even if offline during install.
    })
  );
  // Do NOT skipWaiting here — wait for the user to confirm via the update toast.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k))))
    ).then(() => self.clients.claim()).then(() => {
      // Tell pages a new SW is now controlling them.
      return self.clients.matchAll({ type: 'window' }).then((clients) => {
        for (const c of clients) {
          c.postMessage({ type: 'SW_ACTIVATED', buildId: BUILD_ID });
        }
      });
    })
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data && data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (data && data.type === 'GET_BUILD_ID' && event.source) {
    event.source.postMessage({ type: 'SW_BUILD_ID', buildId: BUILD_ID });
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // never cache API traffic.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  // Network-first for navigations and hashed assets so deploys win quickly;
  // fall back to cache when offline.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const resp = await fetch(req);
        if (resp && resp.status === 200 && resp.type === 'basic') {
          cache.put(req, resp.clone()).catch(() => {});
        }
        return resp;
      } catch {
        const cached = await cache.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const shell = await cache.match('/index.html');
          if (shell) return shell;
        }
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })
  );
});
