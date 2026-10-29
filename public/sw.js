// Minimal service worker: makes the app installable; network-first, falls back to cache for the shell.
const CACHE = 'sakura-shell-v2';
const SHELL = ['/', '/css/app.css', '/js/app.js', '/icon.svg'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => { }));
    self.skipWaiting();
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
    const u = new URL(e.request.url);
    if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
    e.respondWith(fetch(e.request).then(r => {
        if (r.ok && SHELL.includes(u.pathname)) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
        return r;
    }).catch(() => caches.match(e.request)));
});
