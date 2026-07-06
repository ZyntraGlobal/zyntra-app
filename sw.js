const CACHE = 'zyntra-app-v26';
// index.html e web-sync.js FORA do cache — sempre baixa o mais recente da internet
const ASSETS = [
  '/zyntra-app/mobile.css',
  '/zyntra-app/manifest.json',
  '/zyntra-app/icon-192.png',
  '/zyntra-app/icon-512.png',
  '/zyntra-app/_files/css2',
  '/zyntra-app/_files/zyntra-logo.png',
  '/zyntra-app/_files/zyntra-logo.jpg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting()) // ativa imediatamente, sem esperar aba fechar
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()) // assume controle de todas as abas abertas
     .then(() => {
       // Avisa todas as páginas abertas para recarregar com o novo código
       return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
     }).then(cls => {
       cls.forEach(c => c.postMessage({ type: 'SW_UPDATED', cache: CACHE }));
     })
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Requisições ao GitHub API e externas: NUNCA interceptar — passa direto
  if (url.includes('api.github.com') || url.includes('ntfy.sh') || url.includes('googleapis.com/oauth')) {
    return;
  }

  // index.html e web-sync.js: SEMPRE da rede — nunca do cache
  if (url.endsWith('/zyntra-app/') || url.includes('/zyntra-app/index.html') || url.includes('/zyntra-app/web-sync.js')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .catch(() => caches.match('/zyntra-app/index.html'))
    );
    return;
  }

  // data.json (só raw GitHub Pages, não a API): rede primeiro, fallback cache
  if (url.includes('data.json') && url.includes('raw.githubusercontent.com')) {
    e.respondWith(
      fetch(e.request)
        .then(r => { caches.open(CACHE).then(c => c.put(e.request, r.clone())); return r; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Fontes: cache permanente
  if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request).then(res => {
        caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }))
    );
    return;
  }

  // Todo o resto: cache primeiro
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res && res.status === 200) {
        caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      }
      return res;
    }))
  );
});

self.addEventListener('push', e => {
  let data = { title: 'Zyntra Gestão', body: 'Dados atualizados' };
  try { if (e.data) data = e.data.json(); } catch(ex) {}
  e.waitUntil(
    self.registration.showNotification(data.title || 'Zyntra Gestão', {
      body: data.body || 'Dados atualizados',
      icon: '/zyntra-app/icon-192.png',
      badge: '/zyntra-app/icon-192.png',
      tag: 'zyntra-gestao-' + Date.now(),
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      for (const c of cls) {
        if (c.url.includes('/zyntra-app/') && 'focus' in c) return c.focus();
      }
      return clients.openWindow('/zyntra-app/');
    })
  );
});
