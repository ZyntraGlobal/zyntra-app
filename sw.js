const CACHE = 'zyntra-app-v7';
const ASSETS = [
  '/zyntra-app/',
  '/zyntra-app/index.html',
  '/zyntra-app/mobile.css',
  '/zyntra-app/manifest.json',
  '/zyntra-app/icon-192.png',
  '/zyntra-app/icon-512.png',
  '/zyntra-app/_files/css2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('data.json') || e.request.url.includes('push-sub.json')) {
    e.respondWith(fetch(e.request).then(r => { caches.open(CACHE).then(c => c.put(e.request, r.clone())); return r; }).catch(() => caches.match(e.request)));
    return;
  }
  if (e.request.url.includes('fonts.gstatic.com') || e.request.url.includes('fonts.googleapis.com')) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { caches.open(CACHE).then(c => c.put(e.request, res.clone())); return res; })));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { if (res && res.status === 200) caches.open(CACHE).then(c => c.put(e.request, res.clone())); return res; })));
});

self.addEventListener('push', e => {
  let data = { title: 'Zyntra Gestão', body: 'Dados atualizados', icon: '/zyntra-app/icon-192.png', badge: '/zyntra-app/icon-192.png' };
  try { if (e.data) Object.assign(data, JSON.parse(e.data.text())); } catch(err) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon,
      badge:   data.badge,
      tag:     data.tag || 'zyntra-gestao',
      renotify: true,
      vibrate: [200, 100, 200],
      data:    { url: '/zyntra-app/' }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) { if (c.url.includes('/zyntra-app/') && 'focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow('/zyntra-app/');
  }));
});
