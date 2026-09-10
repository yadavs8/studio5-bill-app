// Service Worker for Studio5 Bill App
// Strategy: Network-First with Cache Fallback for app shell
// API calls to Render/Supabase are always direct network calls.

const CACHE_NAME = 'studio5-bills-v9';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch((err) => {
        console.warn('Pre-caching some app shell assets failed:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Always bypass cache for backend API requests
  if (url.hostname.includes('onrender.com') || url.pathname.includes('/api/') || url.pathname.includes('/bank/')) {
    return;
  }

  // Network-first strategy for app shell
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        // Fallback to cache if network is offline or failing on initial launch (e.g. iOS WebClip launch)
        const cachedResponse = await caches.match(event.request);
        if (cachedResponse) return cachedResponse;

        // If navigating to the app or any subdirectory, fallback to index.html
        if (event.request.mode === 'navigate') {
          const fallback = await caches.match('./index.html') || await caches.match('./');
          if (fallback) return fallback;
        }

        return new Response('Offline - please check your internet connection.', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain' }
        });
      })
  );
});
