// KID'S TRENDS POS - PWA SERVICE WORKER

const CACHE_NAME = 'kids-trends-pos-cache-v1';

// Assets to cache for 100% offline usage
const ASSETS = [
    './',
    'index.html',
    'style.css',
    'db.js',
    'scanner.js',
    'app.js',
    'manifest.json',
    'icon-192.png',
    'icon-512.png'
];

// 1. Installation: cache all local assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[Service Worker] Caching app shell assets');
                return cache.addAll(ASSETS);
            })
            .then(() => self.skipWaiting())
    );
});

// 2. Activation: purge old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        console.log('[Service Worker] Removing old cache key:', key);
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// 3. Intercept requests: Stale-While-Revalidate caching
self.addEventListener('fetch', (event) => {
    // Only intercept local HTTP/HTTPS requests
    if (!event.request.url.startsWith(self.location.origin)) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                // If it is in cache, return immediately, but fetch background updates if online
                event.waitUntil(
                    fetch(event.request).then((networkResponse) => {
                        if (networkResponse && networkResponse.status === 200) {
                            return caches.open(CACHE_NAME).then((cache) => {
                                cache.put(event.request, networkResponse.clone());
                            });
                        }
                    }).catch(() => {
                        // Quietly fail background fetch if offline
                    })
                );
                return cachedResponse;
            }

            // Fallback to fetching directly from network
            return fetch(event.request);
        })
    );
});
