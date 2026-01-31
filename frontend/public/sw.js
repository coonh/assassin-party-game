const CACHE_NAME = 'assassin-v1';
const ASSETS = [
    '/hunt/',
    '/hunt/index.html',
    '/hunt/styles.css',
    '/hunt/favicon.ico'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // We don't necessarily need to cache everything yet, 
            // just enough to satisfy PWA requirements.
            return cache.addAll(ASSETS).catch(() => { });
        })
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
