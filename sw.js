const CACHE = 'zyntra-app-v45';
// index.html e web-sync.js FORA do cache — sempre baixa o mais recente da internet
const ASSETS = [
  'mobile.css',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  '_files/css2',
  '_files/zyntra-logo.png',
  '_files/zyntra-logo.jpg',
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

  // Requisições ao GitHub API, ao relay (dados reais/login/notificação) e
  // externas: NUNCA interceptar nem cachear — sempre direto da rede. Sem isso,
  // a resposta de /data ficava presa em cache e nunca mais era atualizada.
  if (url.includes('api.github.com') || url.includes('ntfy.sh') || url.includes('googleapis.com/oauth') || url.includes('zyntra-push-relay')) {
    return;
  }

  // index.html e web-sync.js: SEMPRE da rede — nunca do cache
  if (url.endsWith('/') || url.includes('/index.html') || url.includes('/web-sync.js')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .catch(() => caches.match('index.html'))
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
const VAPID_PUBLIC_SW = 'BITLfwTQwUU_BYIbbdEXYoUAEp7sy6iiL52Cn-GmnuljgI4F0cPgiT5xgjSM-uV33AIP9LvWf3QrsLR1CRvE-FQ';
const PUSH_RELAY_URL = 'https://zyntra-push-relay.nameless-bonus-004f.workers.dev/subscribe';

// O Service Worker não tem localStorage — a página manda o token por
// postMessage a cada login/renovação. Sem token em memória, a autocorreção
// fica pendente até a página reabrir e mandar de novo (não crítico).
let _sessionTokenSW = null;
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SESSION_TOKEN') _sessionTokenSW = e.data.token;
});

function _urlB64ToUint8SW(b) {
  const p = '='.repeat((4 - b.length % 4) % 4);
  const s = (b + p).replace(/-/g, '+').replace(/_/g, '/');
  const r = atob(s);
  const o = new Uint8Array(r.length);
  for (let i = 0; i < r.length; i++) o[i] = r.charCodeAt(i);
  return o;
}

// Publica a subscription através do relay (Cloudflare Worker) em vez de escrever
// direto no GitHub — o token de escrita fica só no relay, nunca aqui no código que
// o navegador baixa. Ver /Users/felipehorbatey/zyntra/push-relay.
function _publicarSubGitHubSW(sub) {
  if (!_sessionTokenSW) return Promise.resolve();
  const subJson = sub.toJSON ? sub.toJSON() : sub; // .keys só existe via toJSON()
  return fetch(PUSH_RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _sessionTokenSW },
    body: JSON.stringify({ app: 'gestao', subscription: { endpoint: subJson.endpoint, keys: subJson.keys } })
  }).catch(() => {});
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
        icon: 'icon-192.png',
        badge: 'icon-192.png',
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
        if (c.url.includes('/') && 'focus' in c) return c.focus();
      }
      return clients.openWindow('./');
    })
  );
});
