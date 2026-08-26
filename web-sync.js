(async function () {
  if (typeof process !== 'undefined' && process.versions && process.versions.electron) return;

  const CHAVE    = 'zyntra_gestao_v1';
  // Leitura e escrita passam pelo relay, autenticadas com o token de sessão do
  // login — o navegador não fala mais direto com o GitHub.
  const PUSH_RELAY_URL = 'https://zyntra-push-relay.nameless-bonus-004f.workers.dev';
  const R = v => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');

  function _sessaoWS() {
    try { return JSON.parse(localStorage.getItem('zg_sess') || '{}'); } catch(e) { return {}; }
  }
  function _avisarTokenSW() {
    var tok = _sessaoWS().token;
    if (tok && navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'SESSION_TOKEN', token: tok });
    }
  }
  const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

  async function _notifSync(titulo, linhas) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const body = linhas.slice(0, 6).join('\n') + (linhas.length > 6 ? '\n…+' + (linhas.length - 6) + ' mais' : '');
      await reg.showNotification(titulo, {
        body, icon: 'icon-192.png', badge: 'icon-192.png',
        tag: 'zyntra-app-sync', requireInteraction: false
      });
    } catch(e) {}
  }

  function _diffGestao(antigo, novo) {
    if (!antigo) return null;
    const linhas = [];
    // RTU
    const mAntR = {}; (antigo.rtu || []).forEach(r => mAntR[r.id] = r);
    const idsNR = new Set((novo.rtu || []).map(r => r.id));
    (novo.rtu || []).forEach(r => {
      const a = mAntR[r.id];
      if (!a) { linhas.push('➕ RTU: ' + r.produto + ' · ' + R(r.valor) + ' · Imp: ' + R(r.totalImp)); }
      else {
        const d = [];
        if (a.valor   !== r.valor)   d.push(R(a.valor) + ' → ' + R(r.valor));
        if (a.produto !== r.produto) d.push('produto: ' + r.produto);
        if (d.length) linhas.push('✏️ RTU ' + r.produto + ': ' + d.join(', '));
      }
    });
    (antigo.rtu || []).forEach(r => { if (!idsNR.has(r.id)) linhas.push('🗑️ RTU removido: ' + r.produto); });
    // Pagamentos
    for (let m = 0; m < 12; m++) {
      const ant = (antigo.pag && antigo.pag[m]) || [];
      const nov = (novo.pag   && novo.pag[m])   || [];
      for (let i = ant.length; i < nov.length; i++) linhas.push('➕ Pgto ' + MESES[m] + ': ' + nov[i].desc + ' · ' + R(nov[i].valor));
      for (let i = 0; i < Math.min(ant.length, nov.length); i++) {
        const a = ant[i], p = nov[i]; if (!a || !p) continue;
        const d = [];
        if (a.status !== p.status) d.push(a.status + ' → ' + p.status);
        if (a.valor  !== p.valor)  d.push(R(a.valor) + ' → ' + R(p.valor));
        if (d.length) {
          const ico = p.status === 'Pago' ? '💳' : p.status === 'Atrasado' ? '🔴' : '✏️';
          linhas.push(ico + ' ' + (p.desc || a.desc) + ' (' + MESES[m] + '): ' + d.join(', '));
        }
      }
      for (let i = nov.length; i < ant.length; i++) if (ant[i]) linhas.push('🗑️ Pgto ' + MESES[m] + ': ' + ant[i].desc);
    }
    // Estoque
    const mAntP = {}; (antigo.produtos || []).forEach(p => mAntP[p.id] = p);
    const idsNP = new Set((novo.produtos || []).map(p => p.id));
    (novo.produtos || []).forEach(p => {
      const a = mAntP[p.id];
      if (!a) { linhas.push('➕ Produto: ' + p.nome); }
      else {
        const d = [];
        if (a.qty !== p.qty) { const delta = p.qty - a.qty; d.push('estoque: ' + a.qty + ' → ' + p.qty + ' (' + (delta>0?'+':'') + delta + ')' + (p.qty <= p.min ? ' ⚠️ ABAIXO MÍN' : '')); }
        if (a.cmv !== p.cmv) d.push('CMV: ' + R(a.cmv) + ' → ' + R(p.cmv));
        if (a.min !== p.min) d.push('mín: ' + a.min + ' → ' + p.min);
        if (d.length) linhas.push('📦 ' + p.nome + ': ' + d.join(', '));
      }
    });
    (antigo.produtos || []).forEach(p => { if (!idsNP.has(p.id)) linhas.push('🗑️ Produto removido: ' + p.nome); });
    return linhas.length ? linhas : null;
  }

  async function sincronizar() {
    try {
      const sess = _sessaoWS();
      if (!sess.token) return false;

      // AbortController: evita travar pra sempre numa rede lenta/instável
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(PUSH_RELAY_URL + '/data?app=gestao', {
        signal: ctrl.signal,
        headers: { 'Authorization': 'Bearer ' + sess.token }
      }).finally(() => clearTimeout(to));
      if (resp.status === 401) { try { if (typeof window._expirar === 'function') window._expirar(); } catch(e) {} return false; }
      if (!resp.ok) return false;
      const body = await resp.json();
      const remoto = body && body.data;
      if (!remoto || !remoto.produtos) return false;

      let local = null;
      try { local = JSON.parse(localStorage.getItem(CHAVE)); } catch(e) {}

      // Filtrar pra funcionário não muda o _savedAt (é o mesmo dado, só com campos
      // a menos) — então trocar de usuário no mesmo aparelho (ex: colab → felipe)
      // sem o papel mudar o timestamp fazia o dono continuar vendo a versão
      // filtrada presa no aparelho. Por isso o papel da sessão também invalida o
      // cache, não só a hora.
      const tRemoto = remoto._savedAt || 0;
      const tLocal  = local ? (local._savedAt || 0) : 0;
      const papelMudou = local && local._papel && local._papel !== sess.role;
      if (tRemoto <= tLocal && !papelMudou) {
        // Local é mais recente que GitHub — push automático (dados ficaram presos por falha anterior)
        if (tLocal > tRemoto && typeof _ghSalvarG === 'function' && typeof DB !== 'undefined' && DB && DB.produtos) {
          console.log('[ZyntraG] Auto-push: local mais recente que GitHub — enviando...');
          _ghSalvarG();
        }
        return false;
      }

      const linhas = _diffGestao(local, remoto);
      localStorage.setItem(CHAVE, JSON.stringify(Object.assign({}, remoto, { _papel: sess.role })));
      localStorage.removeItem('zg_lock');

      if (linhas && linhas.length > 0) {
        _notifSync('Zyntra Gestão — ' + linhas.length + ' alteração(ões)', linhas);
      } else if (local) {
        _notifSync('Zyntra Gestão — dados atualizados', ['Dados sincronizados do desktop']);
      }
      return true;
    } catch(e) { return false; }
  }

  // 'zyntra-sync' é ouvido pelo index.html, que redesenha a tela em memória
  // (nunca usar location.reload() aqui — no PWA instalado do iOS isso é
  // tratado como navegação e chega a tirar o usuário do modo de app)
  function _aplicarSeMudou(mudou) {
    if (!mudou) return;
    const jaLogado = localStorage.getItem('zg_sess');
    if (jaLogado && typeof carregarDados === 'function') carregarDados();
    else if (jaLogado) window.dispatchEvent(new CustomEvent('zyntra-sync'));
  }

  _aplicarSeMudou(await sincronizar());

  // Exposto para o botão "🔄 Atualizar" da topbar — sincroniza sob demanda, sem esperar o polling
  window.forcarSincronizarG = async function() {
    const mudou = await sincronizar();
    _aplicarSeMudou(mudou);
    return mudou;
  };

  // Renova subscription push, republica no relay ntfy (instantâneo, mas expira em 12h)
  // e persiste no GitHub (push-sub.json — não expira, é a fonte confiável pro desktop).
  // push-sub.json é uma LISTA de aparelhos (não um só) — o mesmo app pode estar
  // instalado em vários iPhones ao mesmo tempo (ex: pessoal + da empresa), cada um
  // identificado por um deviceId próprio e aleatório gerado uma vez e guardado local.
  var _lastPushRenew = 0;
  // Publica através do relay — dedupe por endpoint já acontece do lado do servidor.
  function _salvarSubGitHubG(sub, forcar) {
    try {
      var mudou = localStorage.getItem('zg_push_ep') !== sub.endpoint;
      var ultimaPub = Number(localStorage.getItem('zg_push_pub_ts') || 0);
      // Sem mudança de endpoint, republica mesmo assim 1x/dia — autocorreção caso o
      // arquivo remoto tenha ficado dessincronizado sem o endpoint em si ter mudado.
      if (!mudou && !forcar && (Date.now() - ultimaPub) < 86400000) return;
      // sub é um PushSubscription nativo — .keys não existe como propriedade direta
      // (só endpoint tem getter), as chaves só saem via .toJSON(). Sem isso, a
      // subscription salva ficava sem "keys" e o push falhava silenciosamente.
      var subJson = sub.toJSON ? sub.toJSON() : sub;
      var _tok = _sessaoWS().token;
      if (!_tok) return;
      fetch(PUSH_RELAY_URL + '/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _tok },
        body: JSON.stringify({ app: 'gestao', subscription: { endpoint: sub.endpoint, keys: subJson.keys } })
      }).then(function(r) {
        if (r && r.ok) {
          localStorage.setItem('zg_push_ep', sub.endpoint);
          localStorage.setItem('zg_push_pub_ts', String(Date.now()));
        } else {
          setTimeout(function() { _salvarSubGitHubG(sub, true); }, 30000);
        }
      }).catch(function() { setTimeout(function() { _salvarSubGitHubG(sub, true); }, 30000); });
    } catch(e) {}
  }
  function _renewPushG() {
    _avisarTokenSW();
    if (!('serviceWorker' in navigator) || !('Notification' in window) || Notification.permission !== 'granted') return;
    var now = Date.now();
    if (now - _lastPushRenew < 1200000) return; // a cada 20 min
    _lastPushRenew = now;
    navigator.serviceWorker.ready.then(function(reg) {
      function urlB64(b){var p='='.repeat((4-b.length%4)%4);var s=(b+p).replace(/-/g,'+').replace(/_/g,'/');var r=window.atob(s);var o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o;}
      var chaveAtual = urlB64('BITLfwTQwUU_BYIbbdEXYoUAEp7sy6iiL52Cn-GmnuljgI4F0cPgiT5xgjSM-uV33AIP9LvWf3QrsLR1CRvE-FQ');
      var salvar = function(s){
        fetch('https://ntfy.sh/zyntra-sub-gestao-zg2026x',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(s)}).catch(function(){});
        _salvarSubGitHubG(s);
      };
      // Se a chave VAPID mudou (rotação de chave), a subscription antiga fica inválida
      // pro servidor — descarta e reinscreve com a chave nova, sem precisar de ação manual.
      function chaveBate(sub){
        try {
          var atual = new Uint8Array(sub.options.applicationServerKey);
          if (atual.length !== chaveAtual.length) return false;
          for (var i=0;i<atual.length;i++) if (atual[i]!==chaveAtual[i]) return false;
          return true;
        } catch(e) { return true; }
      }
      reg.pushManager.getSubscription().then(function(sub) {
        if (sub && chaveBate(sub)) { salvar(sub); return; }
        var refazer = function(){
          reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveAtual })
            .then(salvar).catch(function(){});
        };
        if (sub) { sub.unsubscribe().then(refazer).catch(refazer); } else { refazer(); }
      });
    }).catch(function(){});
  }

  // Polling: 10s com app aberto, 60s em background
  function iniciarPolling() {
    let timer;
    function agendar() {
      clearTimeout(timer);
      timer = setTimeout(async function() { _aplicarSeMudou(await sincronizar()); _renewPushG(); agendar(); },
        document.hidden ? 60000 : 10000);
    }
    document.addEventListener('visibilitychange', function() { _renewPushG(); agendar(); });
    agendar();
  }
  iniciarPolling();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(function() { _renewPushG(); })
      .catch(function(e) { console.warn('SW:', e); });
  }

  // Exposto pro botão "🔄 Renovar Push" do index.html — _renewPushG/_salvarSubGitHubG
  // vivem fechados dentro desta IIFE, então precisam de uma ponte explícita pra fora.
  // Ignora os dois throttles (20min do _renewPushG, 1x/dia do _salvarSubGitHubG) —
  // é um pedido manual e direto do usuário, sempre publica na hora.
  window._forcarRenovarPushG = function() {
    if (!('serviceWorker' in navigator) || !('Notification' in window) || Notification.permission !== 'granted') return Promise.resolve(false);
    function urlB64(b){var p='='.repeat((4-b.length%4)%4);var s=(b+p).replace(/-/g,'+').replace(/_/g,'/');var r=window.atob(s);var o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o;}
    return navigator.serviceWorker.ready.then(function(reg) {
      return reg.pushManager.getSubscription().then(function(sub) {
        if (sub) { _salvarSubGitHubG(sub, true); return true; }
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64('BITLfwTQwUU_BYIbbdEXYoUAEp7sy6iiL52Cn-GmnuljgI4F0cPgiT5xgjSM-uV33AIP9LvWf3QrsLR1CRvE-FQ') })
          .then(function(sub2) { _salvarSubGitHubG(sub2, true); return true; }).catch(function() { return false; });
      });
    }).catch(function() { return false; });
  };
})();
