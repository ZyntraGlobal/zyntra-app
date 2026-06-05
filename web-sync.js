(async function () {
  if (typeof process !== 'undefined' && process.versions && process.versions.electron) return;

  const CHAVE = 'zyntra_gestao_v1';
  const base = location.href.replace(/\/[^/]*$/, '/');
  const DATA_URL = base + 'data.json';

  // Mostra notificação via Service Worker com o que mudou
  async function _notifSync(titulo, corpo) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(titulo, {
        body: corpo,
        icon: '/zyntra-app/icon-192.png',
        badge: '/zyntra-app/icon-192.png',
        tag: 'zyntra-app-sync',
        requireInteraction: false
      });
    } catch(e) {}
  }

  // Compara DB antigo vs novo e retorna texto descrevendo as mudanças
  function _diffGestao(antigo, novo) {
    if (!antigo) return null; // primeira sync — não notifica
    const partes = [];

    // Novos lançamentos RTU
    const idsAntRTU = new Set((antigo.rtu || []).map(r => r.id));
    const novosRTU  = (novo.rtu || []).filter(r => !idsAntRTU.has(r.id));
    if (novosRTU.length > 0) {
      const nomes = novosRTU.slice(0, 2).map(r => (r.produto || r.cat || '?') + ' R$' + (r.valor || 0).toFixed(0)).join(', ');
      partes.push(novosRTU.length + ' RTU: ' + nomes + (novosRTU.length > 2 ? '...' : ''));
    }

    // Pagamentos com status alterado
    const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const pagAlt = [];
    for (let m = 0; m < 12; m++) {
      const ant = (antigo.pag && antigo.pag[m]) ? antigo.pag[m] : [];
      const nov = (novo.pag && novo.pag[m]) ? novo.pag[m] : [];
      nov.forEach((p, i) => {
        const a = ant[i];
        if (a && a.status !== p.status && p.status === 'Pago') {
          pagAlt.push((p.desc || '?') + ' (' + MESES[m] + ')');
        }
      });
    }
    if (pagAlt.length > 0) {
      partes.push(pagAlt.length + ' pago(s): ' + pagAlt.slice(0, 2).join(', ') + (pagAlt.length > 2 ? '...' : ''));
    }

    // Produtos com estoque alterado
    const mapAnt = {};
    (antigo.produtos || []).forEach(p => { mapAnt[p.id] = p; });
    const prodAlt = (novo.produtos || []).filter(p => {
      const a = mapAnt[p.id];
      return a && a.qty !== p.qty;
    });
    if (prodAlt.length > 0) {
      const nomes = prodAlt.slice(0, 2).map(p => {
        const a = mapAnt[p.id];
        const delta = p.qty - a.qty;
        return p.nome + ' (' + (delta > 0 ? '+' : '') + delta + ')';
      }).join(', ');
      partes.push('Estoque: ' + nomes + (prodAlt.length > 2 ? '...' : ''));
    }

    // Novos produtos
    const idsAntProd = new Set((antigo.produtos || []).map(p => p.id));
    const novosProd  = (novo.produtos || []).filter(p => !idsAntProd.has(p.id));
    if (novosProd.length > 0) {
      partes.push(novosProd.length + ' produto(s) novo(s): ' + novosProd.slice(0, 2).map(p => p.nome).join(', '));
    }

    return partes.length > 0 ? partes.join(' · ') : null;
  }

  async function sincronizar() {
    try {
      const resp = await fetch(DATA_URL + '?t=' + Date.now());
      if (!resp.ok) return false;
      const remoto = await resp.json();
      if (!remoto || !remoto.produtos) return false;

      let local = null;
      try { local = JSON.parse(localStorage.getItem(CHAVE)); } catch (e) {}

      const nRemoto = (remoto.produtos || []).length;
      const nLocal  = (local && local.produtos) ? local.produtos.length : 0;
      const pagRemoto = (remoto.pag || []).flat().length;
      const pagLocal  = (local && local.pag) ? local.pag.flat().length : 0;

      if (nRemoto >= nLocal || pagRemoto > pagLocal) {
        const diff = _diffGestao(local, remoto);
        localStorage.setItem(CHAVE, JSON.stringify(remoto));
        localStorage.removeItem('zg_lock');
        if (diff) _notifSync('Zyntra Gestão — Dados atualizados', diff);
        return true;
      }
      return false;
    } catch (e) {
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

  setInterval(sincronizar, 120000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/zyntra-app/sw.js', { scope: '/zyntra-app/' })
      .catch(function(e) { console.warn('SW:', e); });
  }
})();
