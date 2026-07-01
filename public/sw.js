// Service Worker per Orto (con backend Express).
// Strategia: API sempre via network; file statici cache-first con
// navigazione offline di fallback.
// Bump CACHE_NAME su ogni deploy per forzare l'aggiornamento sui client.

const CACHE_NAME = 'ortopwa-v5-grams-prices';
const STATIC_ASSETS = [
  './',
  './index.html',
  './stats.html',
  './prezzi.html',
  './style.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Permette all'app di forzare l'aggiornamento
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.url);
  // API: sempre via network, niente cache (no-store disabilita la HTTP cache del browser)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }).catch(() => new Response(
      JSON.stringify({ error: 'Offline' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )));
    return;
  }

  // Static: cache-first, fallback network + cache
  if (!event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
