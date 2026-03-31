// Service worker for Joe's Dashboard PWA
const CACHE_NAME = 'joes-dashboard-v1';

// Cache the shell on install
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(['/demo/dashboard', '/demo/public/manifest.json']).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// Clean up old caches on activate
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for API calls, cache-first for assets
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Always network for API endpoints
  const isApi = [
    '/demo/status', '/demo/conversations', '/demo/pause',
    '/demo/resume', '/demo/delay', '/demo/send',
  ].some(p => url.includes(p));

  if (isApi || e.request.method !== 'GET') return;

  // Cache-first for everything else
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok) {
          caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
