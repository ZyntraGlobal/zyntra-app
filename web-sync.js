(async function () {
  // Roda só no navegador (não no Electron)
  if (typeof process !== 'undefined' && process.versions && process.versions.electron) return;

  const CHAVE = 'zyntra_gestao_v1';
  const DATA_URL = location.origin + location.pathname.replace(/\/[^/]*$/, '/') + 'data.json';

  try {
    const resp = await fetch(DATA_URL + '?t=' + Date.now());
    if (!resp.ok) return;
    const remoto = await resp.json();
    if (!remoto || !remoto.produtos) return;

    // Comparar com localStorage — usar o que tiver mais produtos
    let local = null;
    try { local = JSON.parse(localStorage.getItem(CHAVE)); } catch (e) {}

    const nRemoto = (remoto.produtos || []).length;
    const nLocal  = (local && local.produtos) ? local.produtos.length : 0;

    if (nRemoto >= nLocal) {
      localStorage.setItem(CHAVE, JSON.stringify(remoto));
      localStorage.removeItem('zg_lock');
      console.log('[Zyntra Web] Dados sincronizados do PC:', nRemoto, 'produtos');
    }
  } catch (e) {
    console.warn('[Zyntra Web] Falha ao sincronizar:', e.message);
  }
})();
