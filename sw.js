// Offline-first service worker. Bump VERSION when shipping changes to this file or the shell list;
// asset edits alone are picked up in the background and show on the next launch.
const VERSION = 'v1';
const CACHE = `ingest-${VERSION}`;
const SHELL = [
    '/',
    '/index.html',
    '/styles.css',
    '/app.js',
    '/manifest.json',
    '/icons/icon.svg',
    '/icons/icon-180.png',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((key) => key.startsWith('ingest-') && key !== CACHE).map((key) => caches.delete(key))))
            .then(() => self.clients.claim()),
    );
});

// Cache-first with background refresh: the app opens instantly, even in airplane mode.
// Only same-origin GETs are handled; uploads to Apps Script go straight to the network.
self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

    const key = request.mode === 'navigate' ? '/index.html' : request;
    event.respondWith(
        caches.open(CACHE).then(async (cache) => {
            const cached = await cache.match(key, { ignoreSearch: request.mode === 'navigate' });
            const network = fetch(request)
                .then((response) => {
                    if (response.ok && response.type === 'basic') cache.put(key, response.clone());
                    return response;
                })
                .catch(() => undefined);
            if (cached) {
                event.waitUntil(network);
                return cached;
            }
            return (await network) || Response.error();
        }),
    );
});
