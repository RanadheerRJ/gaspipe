/* PumpLog service worker
 *
 * Strategy
 *   - App shell is precached on install.
 *   - Navigations: network-first with a cache fallback, so a deploy is picked
 *     up immediately instead of being pinned to a stale index.html.
 *   - Same-origin assets: stale-while-revalidate — instant paint, silent update.
 *   - Firebase / Google APIs: always network, never cached.
 */

const VERSION = 'v2.0.0';
const SHELL_CACHE = `pumplog-shell-${VERSION}`;
const RUNTIME_CACHE = `pumplog-runtime-${VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/auth.js',
  './js/firebase.js',
  './js/store.js',
  './js/components.js',
  './js/station-settings.js',
  './js/app-lock.js',
  './js/dashboard.js',
  './js/pumps.js',
  './js/config-page.js',
  './js/reports.js',
  './js/staff-auth.js',
  './js/profile.js',
  './js/audit.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/logo-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // Individual 404s must not abort the whole install.
      .then(cache => Promise.allSettled(SHELL_FILES.map(f => cache.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

function isFirebaseRequest(url) {
  return /(?:googleapis|gstatic|firebaseio|firebaseapp|google)\.com$/.test(url.hostname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Auth/Firestore traffic must always hit the network.
  if (isFirebaseRequest(url)) return;
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first so new deploys land right away.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
          return response;
        })
        .catch(async () =>
          (await caches.match('./index.html')) ||
          (await caches.match('./')) ||
          new Response('<h1>Offline</h1><p>PumpLog is unavailable right now.</p>', {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        )
    );
    return;
  }

  // Static assets: serve cache immediately, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(RUNTIME_CACHE).then(c => c.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
