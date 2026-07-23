// Hornet Bay service worker — makes the game installable and offline-capable.
// Strategy: network-first for code/pages (deploys show up immediately),
// cache-first for static art (shots/icons), cache as offline fallback.
const CACHE = 'hb-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.startsWith('/shots/') || url.pathname.startsWith('/icons/')) {
    // static art: serve from cache, refresh in the background on miss
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return resp;
      }))
    );
    return;
  }

  // code and pages: try the network first so updates land at once
  e.respondWith(
    fetch(e.request).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return resp;
    }).catch(() => caches.match(e.request))
  );
});
