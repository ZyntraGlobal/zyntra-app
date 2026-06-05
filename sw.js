const CACHE = 'zyntra-v1';
const OFFLINE = ['/zyntra-app/', '/zyntra-app/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(OFFLINE)));
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('data.json')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
