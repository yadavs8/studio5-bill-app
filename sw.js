// Service Worker for Studio5 Bill App
// Strategy: Stale-While-Revalidate for the app shell — the app opens instantly from the
// phone's stored copy while a fresh copy is fetched in the background. When a new version
// has been published, open pages are told so they can switch to it without a reinstall.
// API calls to Render/Supabase are always direct network calls.

const CACHE_NAME = 'studio5-bills-v44';
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
    }).then(() => self.clients.claim())
  );
});

async function notifyClientsOfUpdate() {
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clientList.forEach((client) => client.postMessage({ action: 'app_updated' }));
}

// Fetch a fresh copy, store it, and tell open pages if the app page itself changed.
// `cachedCopy` must be a clone taken before the stored copy is handed to the page.
async function refreshFromNetwork(request, cacheKey, cachedCopy) {
  const networkResponse = await fetch(request, { cache: 'no-cache' });
  if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
    const cache = await caches.open(CACHE_NAME);
    if (cachedCopy && request.mode === 'navigate') {
      const [oldText, newText] = await Promise.all([cachedCopy.text(), networkResponse.clone().text()]);
      await cache.put(cacheKey, networkResponse.clone());
      if (oldText !== newText) await notifyClientsOfUpdate();
    } else {
      await cache.put(cacheKey, networkResponse.clone());
    }
  }
  return networkResponse;
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Always bypass cache for backend API requests and anything not served by this site
  if (url.origin !== self.location.origin || url.pathname.includes('/api/') || url.pathname.includes('/bank/') || url.pathname.includes('/push/')) {
    return;
  }

  // Every navigation (?view=approvals etc.) is the same single-page app, stored under one key.
  const isNavigation = event.request.mode === 'navigate';
  const cacheKey = isNavigation ? './' : event.request;

  event.respondWith((async () => {
    const cached = await caches.match(cacheKey);
    const networkUpdate = refreshFromNetwork(event.request, cacheKey, cached && cached.clone());

    if (cached) {
      event.waitUntil(networkUpdate.catch(() => {})); // offline — the stored copy is all we have
      return cached;
    }

    try {
      return await networkUpdate;
    } catch (e) {
      if (isNavigation) {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
      }
      return new Response('Offline - please check your internet connection.', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  })());
});

// Push notification click handler — opens or focuses the app to the Approvals tab
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : './?view=approvals';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ action: 'open_approvals' });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('push', (event) => {
  let data = { title: '⏳ Studio5 ERP Lockscreen Alert', body: 'New bill(s) waiting for approval', url: './?view=approvals' };
  try {
    if (event.data) {
      const parsed = event.data.json();
      data = Object.assign({}, data, parsed);
    }
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }

  const options = {
    body: data.body,
    icon: data.icon || './icon-192.png',
    badge: data.badge || './icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || './?view=approvals' },
    tag: data.tag || 'pending-approvals',
    renotify: true // a new alert buzzes the phone even when an older one is still in the tray
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});
