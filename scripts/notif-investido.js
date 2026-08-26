// Roda via GitHub Actions (agendado) — manda notificação push avisando quanto
// JÁ FOI investido em compras hoje. Separada da notificação da manhã (quanto
// falta investir) pra não estourar o limite de caracteres do título no iOS.
const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const GH_DATA_TOKEN = process.env.GH_DATA_TOKEN;
const DATA_REPO = 'ZyntraGlobal/zyntra-app-data';

async function ghGetJSON(caminho) {
  const r = await fetch('https://api.github.com/repos/' + DATA_REPO + '/contents/' + caminho, {
    headers: { 'Authorization': 'Bearer ' + GH_DATA_TOKEN, 'Accept': 'application/vnd.github+json' }
  });
  if (r.status === 404) return { json: null, sha: null };
  if (!r.ok) throw new Error('Falha ao ler ' + caminho + ' (' + r.status + ')');
  const info = await r.json();
  const json = JSON.parse(Buffer.from(info.content, 'base64').toString('utf8'));
  return { json, sha: info.sha };
}

async function ghPutJSON(caminho, obj, sha, mensagem) {
  const content = Buffer.from(JSON.stringify(obj, null, 2) + '\n').toString('base64');
  const body = { message: mensagem, content };
  if (sha) body.sha = sha;
  const r = await fetch('https://api.github.com/repos/' + DATA_REPO + '/contents/' + caminho, {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + GH_DATA_TOKEN, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('Falha ao gravar ' + caminho + ' (' + r.status + '): ' + await r.text());
}

// Título tem que caber numa linha só (o iOS corta e não expande sozinho na
// tela de bloqueio) — por isso é bem curto, só o valor. Detalhes (produtos,
// quantidade) vão no corpo, que consegue mostrar várias linhas sem cortar.
const FRASES = [
  '💵 Investido: {valor}',
  '✅ Investi hoje: {valor}',
  '💪 Resultado: {valor}'
];

// Horário-alvo (hora cheia, BRT) em que a notificação deve disparar.
// O workflow roda a cada 15 min — isso aqui decide SE é a hora certa.
const HORAS_ALVO = [20];
const STATE_FILE = 'notif-state-investido.json';

function hojeBRT() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000); // America/Sao_Paulo, UTC-3 fixo (sem horário de verão)
  return { ano: brt.getUTCFullYear(), mes: brt.getUTCMonth() + 1, dia: brt.getUTCDate(), hora: brt.getUTCHours() };
}

function hojeStr() {
  const h = hojeBRT();
  const pad = n => String(n).padStart(2, '0');
  return pad(h.dia) + '/' + pad(h.mes) + '/' + h.ano;
}

function custoTotalCompra(c) {
  const custoBase = Number(c.valorCompra) || 0;
  const frete = Number(c.freteUnit) || 0;
  const impPct = Number(c.impostoPct) || 0;
  const qtd = Number(c.qtd) || 0;
  return (custoBase + frete + custoBase * (impPct / 100)) * qtd;
}

async function main() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.log('VAPID keys não configuradas (secrets ausentes) — abortando.');
    return;
  }
  if (!GH_DATA_TOKEN) {
    console.log('GH_DATA_TOKEN não configurado (secret ausente) — abortando.');
    return;
  }

  const agora = hojeBRT();
  const hoje = hojeStr();

  // O GitHub Actions não garante disparo exato a cada 15 min (pode atrasar horas
  // em repos de baixa atividade) — em vez de exigir bater a hora exata, verifica
  // se algum horário-alvo já passou e ainda não foi notificado hoje, e recupera
  // no próximo run que rodar (evita perder o dia inteiro por causa do atraso).
  const disparoManual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const passados = HORAS_ALVO.filter(h => h <= agora.hora);
  const { json: stateAtual, sha: stateSha } = await ghGetJSON(STATE_FILE);
  const state = stateAtual || {};
  const enviadosHoje = state.dia === hoje ? (state.enviados || []) : [];
  const faltando = passados.filter(h => !enviadosHoje.includes(h));
  if (faltando.length === 0 && !disparoManual) {
    console.log('Nenhum horário-alvo pendente ainda (hora atual: ' + agora.hora + 'h BRT).');
    return;
  }

  const { json: dados } = await ghGetJSON('data.json');
  const { json: subRaw } = await ghGetJSON('push-sub.json');
  if (!dados) { console.log('data.json não encontrado no repositório de dados — abortando.'); return; }
  const listaCompleta = Array.isArray(subRaw) ? subRaw : (subRaw && subRaw.endpoint ? [subRaw] : []);
  const subs = listaCompleta.filter(s => s.role === 'dono' || !s.role);

  const compras = dados.compras || [];
  const investidasHoje = compras.filter(c => c.status === 'Comprado' && (c.dataCompra || c.data) === hoje);

  console.log('Compras investidas hoje:', investidasHoje.length);

  let titulo, corpo;
  if (investidasHoje.length === 0) {
    titulo = '📭 Nada investido hoje';
    corpo = 'Nenhuma compra marcada como comprada hoje.';
  } else {
    const total = investidasHoje.reduce((a, c) => a + custoTotalCompra(c), 0);
    const valorFmt = 'R$ ' + total.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const qtdFmt = investidasHoje.length + ' produto' + (investidasHoje.length > 1 ? 's' : '');
    const frase = FRASES[Math.floor(Math.random() * FRASES.length)];
    titulo = frase.replace('{valor}', valorFmt);
    const produtos = investidasHoje.slice(0, 5).map(c => '• ' + c.produto + ' (' + c.qtd + 'x)').join('\n');
    corpo = qtdFmt + ' comprado' + (investidasHoje.length > 1 ? 's' : '') + ' hoje:\n' + produtos + (investidasHoje.length > 5 ? '\n…+' + (investidasHoje.length - 5) + ' mais' : '');
  }

  webpush.setVapidDetails('mailto:contato@zyntraglobal.com.br', VAPID_PUBLIC, VAPID_PRIVATE);

  const payload = JSON.stringify({ title: titulo, body: corpo, icon: '/zyntra-app/icon-192.png', badge: '/zyntra-app/icon-192.png', tag: 'zyntra-gestao-investido-' + Date.now() });

  if (subs.length === 0) {
    console.log('Nenhum aparelho inscrito em push-sub.json.');
    process.exitCode = 1;
    return;
  }
  let okCount = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload);
      okCount++;
    } catch (err) {
      console.log('Erro ao enviar push [' + (s.deviceId || '?') + ']. statusCode:', err.statusCode, '| body:', err.body);
    }
  }
  if (okCount > 0) {
    console.log('Push enviado com sucesso (' + okCount + '/' + subs.length + ' aparelhos):', titulo);
    await ghPutJSON(STATE_FILE, { dia: hoje, enviados: passados }, stateSha, 'Atualiza estado da notificacao').catch(e => console.log('Aviso: falha ao salvar estado:', e.message));
  } else {
    process.exitCode = 1;
  }
}

main();
