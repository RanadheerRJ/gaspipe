/* PumpLog Service Worker — caches app shell for offline install */

const CACHE = 'pumplog-shell-v1';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/css/style.css',
  '/manifest.json',
  '/js/app.js',
  '/js/auth.js',
  '/js/firebase.js',
  '/js/dashboard.js',
  '/js/pumps.js',
  '/js/config-page.js',
  '/js/history.js',
  '/js/components.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => {
      // Don't fail install if individual files 404 — app shell is the main target
      return cache.addAll(SHELL_FILES).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // Only handle same-origin requests for the app shell
  if (url.origin !== self.location.origin) return;

  // For navigation requests, serve index.html from cache (SPA)
  if (request.mode === 'navigate') {
    e.respondWith(
      caches.match('/index.html').then((cached) => cached || fetch(request))
    );
    return;
  }

  // For other static assets, try cache first, fallback to network
  e.respondWith(
    caches.match(request).then((cached) => {
      return cached || fetch(request).then((response) => {
        // Cache successful responses for future offline use
        if (response.ok && SHELL_FILES.includes(url.pathname)) {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // If offline and not cached, return a minimal fallback
        if (request.destination === 'image') {
          return new Response('', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } });
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
