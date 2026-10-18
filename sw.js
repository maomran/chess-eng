// Caches the app shell (including the engine) so it works offline after the first visit.
const CACHE = 'bestmove-v5';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'engine.js',
  'recognizer.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
  'vendor/chess.js',
  'vendor/pieces.svg',
  'vendor/piece-model.bin',
  'vendor/stockfish/stockfish-19-lite-single.js',
  'vendor/stockfish/stockfish-19-lite-single.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first so updates show up; fall back to the cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
