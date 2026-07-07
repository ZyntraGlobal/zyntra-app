// Roda via GitHub Actions (agendado) — manda notificação push avisando quanto
// JÁ FOI investido em compras hoje. Separada da notificação da manhã (quanto
// falta investir) pra não estourar o limite de caracteres do título no iOS.
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

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
const STATE_PATH = path.join(__dirname, '..', 'notif-state-investido.json');

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

function lerState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) { return {}; }
}

function salvarState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
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

  const dataPath = path.join(__dirname, '..', 'data.json');
  const subPath = path.join(__dirname, '..', 'push-sub.json');

  if (!fs.existsSync(dataPath) || !fs.existsSync(subPath)) {
    console.log('data.json ou push-sub.json não encontrado — abortando.');
    return;
  }

  const agora = hojeBRT();
  const hoje = hojeStr();

  // O workflow roda a cada 15 min o dia inteiro — só segue se a hora atual
  // for a hora-alvo, e só se esse horário ainda não foi enviado hoje (evita
  // duplicar caso o workflow rode mais de uma vez dentro da mesma hora).
  if (!HORAS_ALVO.includes(agora.hora)) {
    console.log('Fora do horário-alvo (hora atual: ' + agora.hora + 'h BRT) — não é hora de notificar.');
    return;
  }
  const slotAtual = hoje + '-' + agora.hora;
  const state = lerState();
  if (state.ultimoSlot === slotAtual) {
    console.log('Slot ' + slotAtual + ' já foi notificado hoje — pulando.');
    return;
  }

  const dados = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const sub = JSON.parse(fs.readFileSync(subPath, 'utf8'));

  const compras = dados.compras || [];
  const investidasHoje = compras.filter(c => c.status === 'Comprado' && (c.dataCompra || c.data) === hoje);

  console.log('Compras investidas hoje:', investidasHoje.length);
  if (investidasHoje.length === 0) {
    console.log('Nada investido hoje — não envia notificação.');
    return;
  }

  const total = investidasHoje.reduce((a, c) => a + custoTotalCompra(c), 0);
  const valorFmt = 'R$ ' + total.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qtdFmt = investidasHoje.length + ' produto' + (investidasHoje.length > 1 ? 's' : '');
  const frase = FRASES[Math.floor(Math.random() * FRASES.length)];
  const titulo = frase.replace('{valor}', valorFmt);
  const produtos = investidasHoje.slice(0, 5).map(c => '• ' + c.produto + ' (' + c.qtd + 'x)').join('\n');
  const corpo = qtdFmt + ' comprado' + (investidasHoje.length > 1 ? 's' : '') + ' hoje:\n' + produtos + (investidasHoje.length > 5 ? '\n…+' + (investidasHoje.length - 5) + ' mais' : '');

  webpush.setVapidDetails('mailto:contato@zyntraglobal.com.br', VAPID_PUBLIC, VAPID_PRIVATE);

  const payload = JSON.stringify({ title: titulo, body: corpo, icon: '/zyntra-app/icon-192.png', badge: '/zyntra-app/icon-192.png', tag: 'zyntra-gestao-investido-' + Date.now() });

  try {
    await webpush.sendNotification(sub, payload);
    console.log('Push enviado com sucesso:', titulo);
    salvarState({ ultimoSlot: slotAtual });
  } catch (err) {
    console.log('Erro ao enviar push. statusCode:', err.statusCode, '| body:', err.body);
    process.exitCode = 1;
  }
}

main();
