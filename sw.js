// Minimal service worker — just enough to make this installable as a PWA.
// It doesn't cache anything aggressively, so the app always loads the latest
// version rather than a stale offline copy — important while you're still
// making changes to it.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Pass-through: always fetch fresh from network.
  event.respondWith(fetch(event.request));
});
