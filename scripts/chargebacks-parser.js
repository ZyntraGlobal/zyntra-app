// Interpreta o email "Resumo de Atualizações: Chargebacks [Stark Bank]".
// Funções puras (sem rede), usadas por chargebacks-email.js — e dá pra testar
// colando no console do navegador, já que não dependem de nada do Node.
//
// Formato conhecido do email (blocos podem ou não aparecer):
//   Novos Chargebacks
//     2 novos itens recebidos (Total: R$ 2.421,50).
//     Prazo de defesa: 5 dias corridos da disponibilização.
//   Alterações de Tratativa
//     • Processo: 61099602 | De: AGUARDANDO CLIENTE STARK para: NÃO DEFENDIDO (automático pós prazo de defesa)
//   Alterações de Status
//     • Processo: 60993404 | De: Em análise para: A favor do emissor
//   [Abrir Planilha de Chargebacks]  (link)

function htmlParaTexto(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|tr|h\d|table|ul|ol|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/[ \t\r ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function _semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function _numeroBR(s) {
  // "2.421,50" -> 2421.5
  const n = Number(String(s || '').replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

// Acha o link do botão "Abrir Planilha de Chargebacks" no HTML
function acharLinkPlanilha(html) {
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    if (/planilha/i.test(m[2].replace(/<[^>]+>/g, ''))) return m[1].replace(/&amp;/g, '&');
  }
  return '';
}

// Recebe o texto (já sem HTML) e devolve o que o email diz.
//   novos:    { qtd, total, prazoDias } ou null
//   mudancas: [{ processo, campo: 'tratativa'|'status'|<outro>, de, para, nota }]
function interpretarResumo(texto) {
  const linhas = String(texto || '').split('\n').map(l => l.trim()).filter(Boolean);
  const resultado = { novos: null, mudancas: [] };

  const plano = linhas.join(' ');
  const mNovos = plano.match(/(\d+)\s+novos?\s+ite(?:ns|m)\s+recebidos?/i);
  if (mNovos) {
    const mTotal = plano.match(/total:?\s*R\$\s*([\d.]+(?:,\d{1,2})?)/i);
    const mPrazo = plano.match(/(\d+)\s+dias?\s+(?:corridos|[uú]teis)/i);
    resultado.novos = {
      qtd: Number(mNovos[1]),
      total: mTotal ? _numeroBR(mTotal[1]) : 0,
      prazoDias: mPrazo ? Number(mPrazo[1]) : 5
    };
  }

  let secao = '';
  for (const linha of linhas) {
    const l = _semAcento(linha);
    const mSec = l.match(/^[^a-z0-9]*alteracoes de ([a-z ]+?)\s*:?$/);
    if (mSec) { secao = mSec[1].trim(); continue; }
    if (/^[^a-z0-9]*novos chargebacks/.test(l)) { secao = 'novos'; continue; }

    const m = linha.match(/processo:?\s*(\d+)\s*\|?\s*de:?\s*(.*?)\s+para:?\s+(.+)$/i);
    if (!m) continue;
    let para = m[3].trim().replace(/[.;]$/, '');
    let nota = '';
    const mNota = para.match(/^(.*?)\s*\((.+)\)$/);
    if (mNota) { para = mNota[1].trim(); nota = mNota[2].trim(); }
    resultado.mudancas.push({
      processo: m[1],
      campo: secao === 'status' ? 'status' : secao === 'tratativa' ? 'tratativa' : (secao || 'status'),
      de: m[2].trim(),
      para,
      nota
    });
  }
  return resultado;
}

// Data/hora em horário de Brasília (UTC-3 fixo, sem horário de verão)
function dataBRT(date) {
  const d = new Date(new Date(date).getTime() - 3 * 60 * 60 * 1000);
  const p = n => String(n).padStart(2, '0');
  return {
    data: p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear(),
    hora: p(d.getUTCHours()) + ':' + p(d.getUTCMinutes())
  };
}

function somarDias(dataStr, n) {
  const p = String(dataStr || '').split('/');
  if (p.length !== 3) return '';
  const d = new Date(Date.UTC(Number(p[2]), Number(p[1]) - 1, Number(p[0]) + n));
  if (isNaN(d.getTime())) return '';
  const z = x => String(x).padStart(2, '0');
  return z(d.getUTCDate()) + '/' + z(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear();
}

// ── Planilha de Chargebacks ───────────────────────────
// As colunas são achadas pelo nome do cabeçalho (sem depender da ordem), já que
// a planilha é da Stark e pode mudar. A primeira regra que bater ganha; uma
// coluna nunca é usada pra dois campos.
const COLUNAS = [
  ['processo',  [/^processo/, /n.? ?(do )?processo/, /id (da )?disputa/, /^disputa/, /^case/]],
  ['tratativa', [/tratativa/]],
  ['status',    [/^status/, /situacao/]],
  ['prazo',     [/prazo/, /data limite/, /limite (de|para) defesa/, /vencimento/]],
  ['recebido',  [/disponibiliza/, /data (de |do )?(abertura|recebimento|chargeback|contestacao|notificacao)/]],
  ['valor',     [/valor (do |da )?(chargeback|contesta|disputa)/, /^valor$/, /valor/]],
  ['pedido',    [/pedido/, /^nsu/, /\bnsu\b/, /transac/, /autoriza/, /^tid$/, /order/]],
  ['cliente',   [/cliente/, /portador/, /comprador/, /^nome/]],
  ['motivo',    [/motivo/, /razao/, /reason/]],
  ['dataVenda', [/data (da )?(venda|compra|transac)/]]
];

function mapearCabecalho(cab) {
  const norm = cab.map(c => _semAcento(c).replace(/\s+/g, ' ').trim());
  const usado = {};
  const mapa = {};
  for (const [campo, regras] of COLUNAS) {
    for (const re of regras) {
      const i = norm.findIndex((c, idx) => c && !usado[idx] && re.test(c));
      if (i >= 0) { mapa[campo] = i; usado[i] = true; break; }
    }
  }
  return mapa;
}

// "R$ 1.234,56" / "1234.56" / "1.234" -> número
function valorPlanilha(s) {
  let t = String(s == null ? '' : s).replace(/[^\d,.\-]/g, '');
  if (!t) return 0;
  if (t.indexOf(',') >= 0) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return isNaN(n) ? 0 : n;
}

// "16/11/2026", "16/11/2026 10:30", "2026-11-16" -> "16/11/2026"
function dataPlanilha(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) { let a = Number(m[3]); if (a < 100) a += 2000; return String(m[1]).padStart(2, '0') + '/' + String(m[2]).padStart(2, '0') + '/' + a; }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[3] + '/' + m[2] + '/' + m[1];
  return '';
}

// linhas = matriz de textos (como aparecem na planilha). Acha a linha de
// cabeçalho (a primeira que tem uma coluna de "processo") e devolve
// { mapa, cabecalho, registros: [{processo, valor, recebido, prazo, ..., planilha:{coluna: valor}}] }
function lerPlanilha(linhas) {
  linhas = Array.isArray(linhas) ? linhas : [];
  let iCab = -1, mapa = null;
  for (let i = 0; i < Math.min(linhas.length, 15); i++) {
    const m = mapearCabecalho((linhas[i] || []).map(String));
    if (m.processo !== undefined) { iCab = i; mapa = m; break; }
  }
  if (iCab < 0) return { mapa: null, cabecalho: [], registros: [] };
  const cab = linhas[iCab].map(c => String(c).trim());
  const registros = [];
  const vistos = {};
  for (let i = iCab + 1; i < linhas.length; i++) {
    const l = linhas[i] || [];
    const proc = String(l[mapa.processo] || '').replace(/\s+/g, '');
    if (!proc || !/\d/.test(proc)) continue;
    const g = campo => mapa[campo] === undefined ? '' : String(l[mapa[campo]] == null ? '' : l[mapa[campo]]).trim();
    const r = {
      processo: proc,
      valor: valorPlanilha(g('valor')),
      recebido: dataPlanilha(g('recebido')),
      prazo: dataPlanilha(g('prazo')),
      tratativa: g('tratativa'),
      status: g('status'),
      pedido: g('pedido'),
      cliente: g('cliente'),
      motivo: g('motivo'),
      dataVenda: dataPlanilha(g('dataVenda')),
      planilha: {}
    };
    cab.forEach((c, idx) => { if (c && l[idx] !== undefined && String(l[idx]).trim() !== '') r.planilha[c] = String(l[idx]).trim(); });
    // Mesmo processo repetido na planilha: fica a última linha (a mais recente)
    if (vistos[proc] !== undefined) registros[vistos[proc]] = r;
    else { vistos[proc] = registros.length; registros.push(r); }
  }
  return { mapa, cabecalho: cab, registros };
}

if (typeof module !== 'undefined') {
  module.exports = { htmlParaTexto, interpretarResumo, acharLinkPlanilha, dataBRT, somarDias, mapearCabecalho, lerPlanilha, valorPlanilha, dataPlanilha };
}
