// do — app-shell service worker (hand-rolled, no build step).
//
// Strategy:
//   • navigations          → network-first, fall back to cached index ('/') so a
//                            cold offline launch still boots the SPA.
//   • same-origin static   → stale-while-revalidate (Vite emits content-hashed,
//     (assets/js/css/img)    immutable filenames, so cached copies are always valid).
//   • /api/*               → never touched: the app handles data offline itself
//                            (IndexedDB snapshot + durable write outbox).
//
// Bump CACHE to invalidate old precaches on deploy.
const CACHE = 'do-shell-v1';
const PRECACHE = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isStaticAsset(url) {
  return /\.(?:js|mjs|css|svg|png|jpg|jpeg|webp|gif|ico|woff2?|ttf)$/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin pass through
  if (url.pathname.startsWith('/api/')) return;     // app owns data offline

  // SPA navigations: try network, fall back to the cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/').then((r) => r || Response.error())),
    );
    return;
  }

  // Static assets: serve cache fast, refresh in the background.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});
