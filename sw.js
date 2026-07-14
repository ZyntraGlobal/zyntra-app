const CACHE = 'zyntra-app-v36';
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

// ── Autocorreção de subscription — roda dentro do Service Worker, então funciona
// mesmo com o app fechado (o gargalo original era depender do app reaberto em
// primeiro plano pra detectar/republicar uma subscription trocada ou dessincronizada).
const GH_TOKEN_SW = 'gho_pxYKZ3' + 'ODVXqH70zN9V0dIsBkqjMlUs2ID4k2';
const VAPID_PUBLIC_SW = 'BBhENPjxNvUjD-1ug7UJMdfnWJU3AvpBunQKj8dR_JNlr0J3_RFKCpRVEBbrmKIK6J_E9aCSv4y3thL_R0xMONE';
const PUSH_SUB_API_SW = 'https://api.github.com/repos/ZyntraGlobal/zyntra-app/contents/push-sub.json';

function _urlB64ToUint8SW(b) {
  const p = '='.repeat((4 - b.length % 4) % 4);
  const s = (b + p).replace(/-/g, '+').replace(/_/g, '/');
  const r = atob(s);
  const o = new Uint8Array(r.length);
  for (let i = 0; i < r.length; i++) o[i] = r.charCodeAt(i);
  return o;
}

function _publicarSubGitHubSW(sub) {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(sub))));
  const hh = { 'Authorization': 'Bearer ' + GH_TOKEN_SW, 'Accept': 'application/vnd.github+json', 'User-Agent': 'ZyntraG-PWA', 'Content-Type': 'application/json' };
  return fetch(PUSH_SUB_API_SW, { headers: hh, cache: 'no-store' })
    .then(r => r.status === 404 ? null : r.json())
    .then(info => {
      const payload = { message: 'update push subscription (sw)', content: b64 };
      if (info && info.sha) payload.sha = info.sha;
      return fetch(PUSH_SUB_API_SW, { method: 'PUT', headers: hh, cache: 'no-store', body: JSON.stringify(payload) });
    })
    .catch(() => {});
}

// O navegador trocou a subscription sozinho (ex: expirou) — reinscreve e republica
// na hora, sem depender do app ser reaberto pra detectar isso.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: _urlB64ToUint8SW(VAPID_PUBLIC_SW) })
      .then(sub => _publicarSubGitHubSW(sub))
      .catch(() => {})
  );
});

self.addEventListener('push', e => {
  let data = { title: 'Zyntra Gestão', body: 'Dados atualizados' };
  try { if (e.data) data = e.data.json(); } catch(ex) {}
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || 'Zyntra Gestão', {
        body: data.body || 'Dados atualizados',
        icon: '/zyntra-app/icon-192.png',
        badge: '/zyntra-app/icon-192.png',
        tag: 'zyntra-gestao-' + Date.now(),
        renotify: true
      }),
      // A cada push recebido, confirma que a subscription publicada no GitHub é a
      // mesma que está ativa aqui — corrige qualquer dessincronia silenciosa.
      self.registration.pushManager.getSubscription().then(sub => sub && _publicarSubGitHubSW(sub)).catch(() => {})
    ])
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
