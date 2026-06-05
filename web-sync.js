(async function () {
  if (typeof process !== 'undefined' && process.versions && process.versions.electron) return;

  const CHAVE = 'zyntra_gestao_v1';
  // URL correta: mesma pasta do index.html
  const base = location.href.replace(/\/[^/]*$/, '/');
  const DATA_URL = base + 'data.json';

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

      // Usar remoto se tiver mais dados
      if (nRemoto >= nLocal || pagRemoto > pagLocal) {
        localStorage.setItem(CHAVE, JSON.stringify(remoto));
        localStorage.removeItem('zg_lock');
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // Sincronizar e recarregar se trouxe dados novos
  const atualizou = await sincronizar();
  if (atualizou) {
    // Se o app ainda está na tela de login, não precisa recarregar
    const jaLogado = localStorage.getItem('zg_sess');
    if (jaLogado) {
      // Avisar o app para recarregar os dados sem recarregar a página
      if (typeof carregarDados === 'function') carregarDados();
      else window.dispatchEvent(new CustomEvent('zyntra-sync'));
    }
  }

  // Re-sincronizar a cada 2 minutos em background
  setInterval(sincronizar, 120000);
})();
