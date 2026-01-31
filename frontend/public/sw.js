const CACHE_NAME = 'assassin-v1.1';
const ASSETS_TO_CACHE = [
    '/hunt/favicon.ico',
];

// Entry points that should always be fresh
const FRESH_ASSETS = [
    '/hunt/',
    '/hunt/index.html',
    '/hunt/manifest.json'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE).catch(() => { });
        })
    );
});

// Clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Use Network First for index.html and other entry points
    if (FRESH_ASSETS.some(asset => url.pathname.endsWith(asset) || url.pathname === asset)) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const clonedResponse = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clonedResponse));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // Default: Cache First, then Network
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request).then(fetchResponse => {
                // Don't cache everything, just let it pass through if not in our list
                return fetchResponse;
            });
        })
    );
});
