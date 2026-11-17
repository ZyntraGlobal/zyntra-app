// Roda via GitHub Actions (junto com a sincronização de chargebacks). Lê na API
// da Stark Bank o saldo da conta e as parcelas de cartão ainda a receber, e grava
// um resumo em DB.starkConta (data.json) pra aba Chargebacks → Conta Stark.
// Também mantém o saldo da Stark em Gateways em dia.
//
// Só LÊ dados da Stark (saldo e parcelas). Nenhuma chamada aqui movimenta dinheiro.
//
// Secrets: STARK_PROJECT_ID, STARK_PRIVATE_KEY (chave privada .pem do projeto
// cadastrado no Internet Banking da Stark), GH_DATA_TOKEN.

const starkbank = require('starkbank');

const PROJECT_ID = process.env.STARK_PROJECT_ID;
const PRIVATE_KEY = process.env.STARK_PRIVATE_KEY;
const GH_DATA_TOKEN = process.env.GH_DATA_TOKEN;
const DATA_REPO = 'ZyntraGlobal/zyntra-app-data';
const DIAS_DETALHE = 60;                 // a visão Conta Stark mostra só os próximos N dias
const REGRAVAR_HORAS = 3;                // regrava mesmo sem mudança (mostra "consultado às")

async function ghGetJSON(caminho) {
  const r = await fetch('https://api.github.com/repos/' + DATA_REPO + '/contents/' + caminho, {
    headers: { 'Authorization': 'Bearer ' + GH_DATA_TOKEN, 'Accept': 'application/vnd.github+json' }
  });
  if (r.status === 404) return { json: null, sha: null };
  if (!r.ok) throw new Error('Falha ao ler ' + caminho + ' (' + r.status + ')');
  const info = await r.json();
  let texto;
  if (info.content && info.encoding === 'base64') texto = Buffer.from(info.content, 'base64').toString('utf8');
  else {
    const rb = await fetch(info.git_url, { headers: { 'Authorization': 'Bearer ' + GH_DATA_TOKEN, 'Accept': 'application/vnd.github.raw+json' } });
    if (!rb.ok) throw new Error('Falha ao baixar ' + caminho + ' (' + rb.status + ')');
    texto = await rb.text();
  }
  return { json: JSON.parse(texto), sha: info.sha };
}
async function ghPutJSON(caminho, obj, sha, mensagem) {
  const body = { message: mensagem, content: Buffer.from(JSON.stringify(obj, null, 2) + '\n').toString('base64') };
  if (sha) body.sha = sha;
  const r = await fetch('https://api.github.com/repos/' + DATA_REPO + '/contents/' + caminho, {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + GH_DATA_TOKEN, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.status === 409 || r.status === 422) { const e = new Error('conflito'); e.conflito = true; throw e; }
  if (!r.ok) throw new Error('Falha ao gravar ' + caminho + ' (' + r.status + '): ' + await r.text());
}

// Datas em horário de Brasília (UTC-3)
function brt(d) {
  const x = new Date(new Date(d).getTime() - 3 * 3600000);
  const p = n => String(n).padStart(2, '0');
  return { data: p(x.getUTCDate()) + '/' + p(x.getUTCMonth() + 1) + '/' + x.getUTCFullYear(), hora: p(x.getUTCHours()) + ':' + p(x.getUTCMinutes()), iso: x.getUTCFullYear() + '-' + p(x.getUTCMonth() + 1) + '-' + p(x.getUTCDate()) };
}
const reais = c => Math.round(Number(c || 0)) / 100;

async function lerStark() {
  starkbank.user = new starkbank.Project({ environment: 'production', id: PROJECT_ID, privateKey: PRIVATE_KEY });
  starkbank.language = 'pt-BR';

  const balance = await starkbank.balance.get();

  // Todas as parcelas ainda não pagas (status "created")
  const parcelas = [];
  for await (const p of await starkbank.merchantInstallment.query({ status: 'created' })) parcelas.push(p);

  // Agenda completa de recebimentos: um item por dia, todas as datas futuras
  // (vendas parceladas vão até 12+ meses). Crédito e débito separados.
  const hojeIso = brt(new Date()).iso;
  const limiteIso = brt(Date.now() + DIAS_DETALHE * 86400000).iso;
  const porDia = {};
  let bruto = 0, taxas = 0, protegido = 0, depois = 0, antecipado = 0;
  for (const p of parcelas) {
    const valor = Number(p.amount) || 0, fee = Number(p.fee) || 0;
    bruto += valor; taxas += fee;
    if (p.isProtected) protegido += valor - fee;
    const due = p.due ? brt(p.due) : null;
    // Antecipada = a Stark agendou o pagamento antes do vencimento original
    // da parcela (o D+3 das vendas recentes). Senão, cai na data original.
    const nominal = p.nominalDue ? brt(p.nominalDue) : null;
    const ehAntecipada = !!(due && nominal && due.iso < nominal.iso);
    if (ehAntecipada) antecipado += valor - fee;
    const k = !due || due.iso < hojeIso ? hojeIso : due.iso;     // atrasada/sem data conta como hoje
    if (k > limiteIso) depois += valor - fee;
    if (!porDia[k]) porDia[k] = { iso: k, data: k.split('-').reverse().join('/'), liquido: 0, bruto: 0, taxas: 0, qtd: 0, credito: 0, debito: 0, protegido: 0, antecipado: 0, original: 0, qtdAntecipada: 0 };
    const d = porDia[k];
    d.liquido += valor - fee; d.bruto += valor; d.taxas += fee; d.qtd++;
    if (ehAntecipada) { d.antecipado += valor - fee; d.qtdAntecipada++; } else d.original += valor - fee;
    if (p.fundingType === 'debit') d.debito += valor - fee; else d.credito += valor - fee;
    if (p.isProtected) d.protegido += valor - fee;
  }
  const agora = brt(new Date());
  return {
    origem: 'api',
    saldo: reais(balance.amount),
    aReceberBruto: reais(bruto),
    aReceberTaxas: reais(taxas),
    aReceberLiquido: reais(bruto - taxas),
    aReceberProtegido: reais(protegido),
    aReceberDepois: reais(depois),
    qtdParcelas: parcelas.length,
    porDia: Object.values(porDia).sort((a, b) => a.iso.localeCompare(b.iso)).map(d => ({
      data: d.data, liquido: reais(d.liquido), bruto: reais(d.bruto), taxas: reais(d.taxas), qtd: d.qtd,
      credito: reais(d.credito), debito: reais(d.debito), protegido: reais(d.protegido),
      antecipado: reais(d.antecipado), original: reais(d.original), qtdAntecipada: d.qtdAntecipada
    })),
    aReceberAntecipado: reais(antecipado),
    aReceberOriginal: reais(bruto - taxas - antecipado),
    diasDetalhe: DIAS_DETALHE,
    consultadoEm: agora.data + ' ' + agora.hora,
    consultadoMs: Date.now()
  };
}

async function main() {
  if (!PROJECT_ID || !PRIVATE_KEY) { console.log('STARK_PROJECT_ID/STARK_PRIVATE_KEY não configurados — pulando saldo da Stark.'); return; }
  if (!GH_DATA_TOKEN) { console.log('GH_DATA_TOKEN não configurado — abortando.'); return; }

  let conta;
  try {
    conta = await lerStark();
  } catch (e) {
    // Não derruba o app: registra o erro pra aparecer na aba e sai
    console.error('Erro ao consultar a Stark:', (e && (e.errors ? JSON.stringify(e.errors) : e.message)) || e);
    process.exitCode = 1;
    return;
  }
  console.log('Saldo:', conta.saldo, '| A receber (líquido):', conta.aReceberLiquido, '| parcelas:', conta.qtdParcelas);

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const { json: dados, sha } = await ghGetJSON('data.json');
    if (!dados) { console.log('data.json não encontrado — abortando.'); return; }
    const ant = dados.starkConta || {};
    const semMs = o => JSON.stringify(Object.assign({}, o, { consultadoEm: '', consultadoMs: 0 }));
    const mudou = semMs(ant) !== semMs(conta);
    const velho = !ant.consultadoMs || (Date.now() - ant.consultadoMs) > REGRAVAR_HORAS * 3600000;
    if (!mudou && !velho) { console.log('Nada mudou desde a última consulta.'); return; }

    dados.starkConta = conta;
    // Mantém o saldo da Stark em Gateways em dia também
    if (!Array.isArray(dados.gateways)) dados.gateways = [];
    let gw = dados.gateways.find(g => g.gateway === 'Stark Bank');
    if (!gw) { gw = { id: (dados.nGw || 1), gateway: 'Stark Bank', disponivel: 0, obs: '', atualizadoEm: '' }; dados.nGw = (dados.nGw || 1) + 1; dados.gateways.push(gw); }
    gw.disponivel = conta.saldo;
    gw.atualizadoEm = conta.consultadoEm.split(' ')[0];
    gw.obs = 'Atualizado automaticamente pela API da Stark';

    dados._savedAt = Date.now();
    try {
      await ghPutJSON('data.json', dados, sha, 'Stark: saldo e a receber atualizados');
      console.log('data.json atualizado.');
      await fetch('https://ntfy.sh/zyntra-trigger-gestao-zg2026', { method: 'POST', body: 'sync' }).catch(() => {});
      return;
    } catch (e) {
      if (!e.conflito || tentativa === 3) throw e;
      console.log('Conflito ao gravar — tentando de novo...');
    }
  }
}

main().catch(e => { console.error('Erro:', e.message); process.exitCode = 1; });
