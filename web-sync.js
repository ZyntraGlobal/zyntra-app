(async function () {
  if (typeof process !== 'undefined' && process.versions && process.versions.electron) return;

  const CHAVE = 'zyntra_gestao_v1';
  const DATA_URL = 'https://raw.githubusercontent.com/ZyntraGlobal/zyntra-app/main/data.json';
  const R = v => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
  const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

  window._zyntraLastSyncG = window._zyntraLastSyncG || null;
  window._zyntraSyncStatusG = window._zyntraSyncStatusG || 'Aguardando...';

  async function _notifSync(titulo, linhas) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const body = linhas.slice(0, 6).join('\n') + (linhas.length > 6 ? '\n…+' + (linhas.length - 6) + ' mais' : '');
      await reg.showNotification(titulo, {
        body: body,
        icon: '/zyntra-app/icon-192.png',
        badge: '/zyntra-app/icon-192.png',
        tag: 'zyntra-app-sync',
        requireInteraction: false
      });
    } catch(e) { console.warn('notif err:', e); }
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
        const a = ant[i], p = nov[i];
        if (!a || !p) continue;
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
      const resp = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!resp.ok) { window._zyntraSyncStatusG = 'Erro HTTP ' + resp.status; return false; }
      const remoto = await resp.json();
      if (!remoto || !remoto.produtos) { window._zyntraSyncStatusG = 'JSON inválido'; return false; }

      let local = null;
      try { local = JSON.parse(localStorage.getItem(CHAVE)); } catch (e) {}

      const nProd = (remoto.produtos || []).length;
      const nProdL = local ? (local.produtos || []).length : 0;
      const nRtu  = (remoto.rtu || []).length;
      const nRtuL = local ? (local.rtu || []).length : 0;
      const nPag  = (remoto.pag || []).flat().length;
      const nPagL = local ? (local.pag || []).flat().length : 0;

      window._zyntraLastSyncG = new Date().toLocaleTimeString('pt-BR');
      window._zyntraSyncStatusG = 'Produtos: ' + nProd + ' | RTU: ' + nRtu + ' | Pgtos: ' + nPag;

      const dadosMudaram =
        nProd !== nProdL || nRtu !== nRtuL || nPag !== nPagL ||
        JSON.stringify(remoto.rtu)      !== JSON.stringify((local||{}).rtu) ||
        JSON.stringify(remoto.pag)      !== JSON.stringify((local||{}).pag) ||
        JSON.stringify(remoto.produtos) !== JSON.stringify((local||{}).produtos);

      if (dadosMudaram) {
        const linhas = _diffGestao(local, remoto);
        localStorage.setItem(CHAVE, JSON.stringify(remoto));
        localStorage.removeItem('zg_lock');
        if (linhas && linhas.length > 0) {
          _notifSync('Zyntra Gestão — ' + linhas.length + ' alteração(ões)', linhas);
        } else if (local) {
          _notifSync('Zyntra Gestão — dados atualizados', ['Dados sincronizados do desktop']);
        }
        return true;
      }
      return false;
    } catch (e) {
      window._zyntraSyncStatusG = 'Erro: ' + e.message;
      return false;
    }
  }

  const atualizou = await sincronizar();
  if (atualizou) {
    const jaLogado = localStorage.getItem('zg_sess');
    if (jaLogado) {
      if (typeof carregarDados === 'function') carregarDados();
      else window.dispatchEvent(new CustomEvent('zyntra-sync'));
    }
  }

  function iniciarPolling() {
    let timer;
    function agendar() {
      clearTimeout(timer);
      timer = setTimeout(async function() { await sincronizar(); agendar(); },
        document.hidden ? 60000 : 15000);
    }
    document.addEventListener('visibilitychange', agendar);
    agendar();
  }
  iniciarPolling();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/zyntra-app/sw.js', { scope: '/zyntra-app/' })
      .then(function() {
        if ('Notification' in window && Notification.permission === 'granted') {
          navigator.serviceWorker.ready.then(function(reg) {
            reg.pushManager.getSubscription().then(function(sub) {
              function urlB64(b){var p='='.repeat((4-b.length%4)%4);var s=(b+p).replace(/-/g,'+').replace(/_/g,'/');var r=window.atob(s);var o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o;}
              var salvar = function(s) { fetch('https://ntfy.sh/zyntra-sub-gestao-zg2026x',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(s)}).catch(function(){}); };
              if (sub) { salvar(sub); return; }
              reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64('BBhENPjxNvUjD-1ug7UJMdfnWJU3AvpBunQKj8dR_JNlr0J3_RFKCpRVEBbrmKIK6J_E9aCSv4y3thL_R0xMONE') })
                .then(salvar).catch(function(){});
            });
          });
        }
      })
      .catch(function(e) { console.warn('SW:', e); });
  }
})();
