// Offline support: precache the app shell; serve same-origin files network-first with a cache fallback.
// Other same-origin files (e.g. vendor/dash.all.min.js) are cached the first time they're used.
// Video and stream requests are never cached here (local files use blob: URLs, streams go to the network).

const VERSION = 'anivlc-v2';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/subtitles.js',
  'js/storage.js',
  'js/source.js',
  'js/anime.js',
  'js/playlist.js',
  'vendor/hls.min.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return; // media byte ranges

  // Network-first so updates show up immediately; fall back to the cache when offline or slow (>3s).
  const isPage = req.mode === 'navigate';
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const key = isPage ? 'index.html' : req;
      const network = fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') cache.put(key, res.clone());
        return res;
      });
      network.catch(() => {}); // handled below; avoids an unhandled rejection when the cache wins
      const timeout = new Promise((resolve) => setTimeout(resolve, 3000, null));
      try {
        const res = await Promise.race([network, timeout]);
        if (res) return res;
      } catch { /* offline */ }
      const cached = await cache.match(key, { ignoreSearch: isPage });
      if (cached) return cached;
      try { return await network; } catch { return new Response('Offline', { status: 503, statusText: 'Offline' }); }
    })
  );
});
