(async function () {
  if (typeof process !== 'undefined' && process.versions && process.versions.electron) return;

  const CHAVE = 'zyntra_gestao_v1';
  const base = location.href.replace(/\/[^/]*$/, '/');
  const DATA_URL = base + 'data.json';
  const R = v => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
  const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

  async function _notifSync(titulo, linhas) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const body = linhas.slice(0, 5).join('\n') + (linhas.length > 5 ? '\n…+' + (linhas.length - 5) + ' mais' : '');
      await reg.showNotification(titulo, {
        body: body,
        icon: '/zyntra-app/icon-192.png',
        badge: '/zyntra-app/icon-192.png',
        tag: 'zyntra-app-sync',
        requireInteraction: false
      });
    } catch(e) {}
  }

  function _diffGestao(antigo, novo) {
    if (!antigo) return null;
    const linhas = [];

    // ── RTU ──
    const mapAntR = {};
    (antigo.rtu || []).forEach(r => mapAntR[r.id] = r);
    const idsNovR = new Set((novo.rtu || []).map(r => r.id));

    (novo.rtu || []).forEach(r => {
      const a = mapAntR[r.id];
      if (!a) {
        linhas.push('➕ RTU: ' + r.produto + ' · ' + R(r.valor) + ' · Imp: ' + R(r.totalImp) + ' · Total: ' + R((r.valor||0)+(r.totalImp||0)));
      } else {
        const d = [];
        if (a.valor    !== r.valor)    d.push(R(a.valor) + ' → ' + R(r.valor));
        if (a.produto  !== r.produto)  d.push('produto: ' + r.produto);
        if (a.cat      !== r.cat)      d.push('cat: ' + r.cat);
        if (d.length) linhas.push('✏️ RTU ' + r.produto + ': ' + d.join(', '));
      }
    });
    (antigo.rtu || []).forEach(r => {
      if (!idsNovR.has(r.id)) linhas.push('🗑️ RTU removido: ' + r.produto + ' · ' + R(r.valor));
    });

    // ── Pagamentos (todos os meses) ──
    for (let m = 0; m < 12; m++) {
      const ant = (antigo.pag && antigo.pag[m]) ? antigo.pag[m] : [];
      const nov = (novo.pag   && novo.pag[m])   ? novo.pag[m]   : [];
      const mes = MESES[m];

      // Novos pagamentos no mês
      for (let i = ant.length; i < nov.length; i++) {
        const p = nov[i];
        linhas.push('➕ Pgto ' + mes + ': ' + p.desc + ' · ' + R(p.valor) + ' [' + p.status + ']');
      }

      // Alterações em pagamentos existentes
      for (let i = 0; i < Math.min(ant.length, nov.length); i++) {
        const a = ant[i], p = nov[i];
        if (!a || !p) continue;
        const d = [];
        if (a.status !== p.status) d.push(a.status + ' → ' + p.status);
        if (a.valor  !== p.valor)  d.push(R(a.valor) + ' → ' + R(p.valor));
        if (a.desc   !== p.desc)   d.push('desc: ' + p.desc);
        if (d.length) {
          const ico = p.status === 'Pago' ? '💳' : p.status === 'Atrasado' ? '🔴' : '✏️';
          linhas.push(ico + ' ' + (p.desc || a.desc) + ' (' + mes + '): ' + d.join(', '));
        }
      }

      // Pagamentos removidos
      for (let i = nov.length; i < ant.length; i++) {
        const a = ant[i];
        if (a) linhas.push('🗑️ Pgto removido ' + mes + ': ' + a.desc);
      }
    }

    // ── Produtos / Estoque ──
    const mapAntP = {};
    (antigo.produtos || []).forEach(p => mapAntP[p.id] = p);
    const idsNovP = new Set((novo.produtos || []).map(p => p.id));

    (novo.produtos || []).forEach(p => {
      const a = mapAntP[p.id];
      if (!a) {
        linhas.push('➕ Produto: ' + p.nome + ' (cod: ' + p.cod + ', mín: ' + p.min + ')');
      } else {
        const d = [];
        if (a.qty  !== p.qty)  {
          const delta = (p.qty - a.qty);
          const sinal = delta > 0 ? '+' : '';
          const aviso = p.qty <= p.min ? ' ⚠️ ABAIXO DO MÍN' : '';
          d.push('estoque: ' + a.qty + ' → ' + p.qty + ' (' + sinal + delta + ')' + aviso);
        }
        if (a.cmv  !== p.cmv)  d.push('CMV: ' + R(a.cmv) + ' → ' + R(p.cmv));
        if (a.min  !== p.min)  d.push('mín: ' + a.min + ' → ' + p.min);
        if (a.nome !== p.nome) d.push('nome: ' + p.nome);
        if (a.cat  !== p.cat)  d.push('cat: ' + p.cat);
        if (d.length) linhas.push('📦 ' + p.nome + ': ' + d.join(', '));
      }
    });
    (antigo.produtos || []).forEach(p => {
      if (!idsNovP.has(p.id)) linhas.push('🗑️ Produto removido: ' + p.nome);
    });

    // ── Movimentações de estoque ──
    const mapAntM = {};
    (antigo.mov || []).forEach(m => mapAntM[m.id] = m);
    (novo.mov || []).forEach(m => {
      if (!mapAntM[m.id]) {
        linhas.push('📋 Mov: ' + m.tipo + ' · ' + (m.produto || '?') + ' · qtd ' + m.qtd);
      }
    });

    return linhas.length ? linhas : null;
  }

  async function sincronizar() {
    try {
      const resp = await fetch(DATA_URL + '?t=' + Date.now());
      if (!resp.ok) return false;
      const remoto = await resp.json();
      if (!remoto || !remoto.produtos) return false;

      let local = null;
      try { local = JSON.parse(localStorage.getItem(CHAVE)); } catch (e) {}

      const nRemoto  = (remoto.produtos || []).length;
      const nLocal   = local ? (local.produtos || []).length : 0;
      const pagR     = (remoto.pag || []).flat().length;
      const pagL     = local ? (local.pag || []).flat().length : 0;
      const rtuR     = (remoto.rtu || []).length;
      const rtuL     = local ? (local.rtu || []).length : 0;

      if (nRemoto >= nLocal || pagR >= pagL || rtuR >= rtuL) {
        const linhas = _diffGestao(local, remoto);
        localStorage.setItem(CHAVE, JSON.stringify(remoto));
        localStorage.removeItem('zg_lock');
        if (linhas) {
          const qtd = linhas.length;
          _notifSync('Zyntra Gestão — ' + qtd + ' alteração(ões)', linhas);
        }
        return true;
      }
      return false;
    } catch (e) { return false; }
  }

  const atualizou = await sincronizar();
  if (atualizou) {
    const jaLogado = localStorage.getItem('zg_sess');
    if (jaLogado) {
      if (typeof carregarDados === 'function') carregarDados();
      else window.dispatchEvent(new CustomEvent('zyntra-sync'));
    }
  }

  // Polling a cada 30s quando visível, 120s em background
  function iniciarPolling() {
    let timer;
    function agendar() {
      clearTimeout(timer);
      timer = setTimeout(async function() {
        await sincronizar();
        agendar();
      }, document.hidden ? 120000 : 30000);
    }
    document.addEventListener('visibilitychange', function() { agendar(); });
    agendar();
  }
  iniciarPolling();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/zyntra-app/sw.js', { scope: '/zyntra-app/' })
      .then(function() {
        if ('Notification' in window && Notification.permission === 'granted') {
          navigator.serviceWorker.ready.then(function(reg) {
            reg.pushManager.getSubscription().then(function(sub) {
              var salvar = function(s) {
                fetch('https://ntfy.sh/zyntra-sub-gestao-zg2026x', {
                  method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(s)
                }).catch(function(){});
              };
              if (sub) { salvar(sub); return; }
              function urlB64(b){var p='='.repeat((4-b.length%4)%4);var s=(b+p).replace(/-/g,'+').replace(/_/g,'/');var r=window.atob(s);var o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o;}
              reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlB64('BBhENPjxNvUjD-1ug7UJMdfnWJU3AvpBunQKj8dR_JNlr0J3_RFKCpRVEBbrmKIK6J_E9aCSv4y3thL_R0xMONE')
              }).then(salvar).catch(function(){});
            });
          });
        }
      })
      .catch(function(e) { console.warn('SW:', e); });
  }
})();
