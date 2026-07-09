// Roda via GitHub Actions (agendado) — manda notificação push avisando quanto
// precisa investir em compras hoje, independente do desktop ou iPhone estarem ligados.
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

// Título tem que caber numa linha só (o iOS corta e não expande sozinho na
// tela de bloqueio) — por isso é bem curto, só o valor. Detalhes (produtos,
// quantidade) vão no corpo, que consegue mostrar várias linhas sem cortar.
const FRASES = [
  '💰 Investir: {valor}',
  '🛒 Compre hoje: {valor}',
  '📦 Falta comprar: {valor}'
];

// Horário-alvo (hora cheia, BRT) em que a notificação deve disparar.
// O workflow roda a cada 15 min — isso aqui decide SE é a hora certa.
const HORAS_ALVO = [8];
const STATE_PATH = path.join(__dirname, '..', 'notif-state-diaria.json');

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

function diasEmAberto(dataStr) {
  // Aceita "/" ou "-" como separador e ano com 2 ou 4 dígitos. Se não der pra
  // entender, devolve um número bem negativo (não 0 — 0 significaria "vence
  // hoje" e dispararia notificação de vencido indevidamente).
  if (!dataStr) return -999999;
  const p = dataStr.trim().split(/[\/\-]/);
  if (p.length !== 3) return -999999;
  let dia = Number(p[0]), mes = Number(p[1]), ano = Number(p[2]);
  if (!dia || !mes || !ano) return -999999;
  if (ano < 100) ano += 2000;
  const d = Date.UTC(ano, mes - 1, dia);
  if (isNaN(d)) return -999999;
  const h = hojeBRT();
  const hUTC = Date.UTC(h.ano, h.mes - 1, h.dia);
  return Math.floor((hUTC - d) / (1000 * 60 * 60 * 24));
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

  // O GitHub Actions não garante disparo exato a cada 15 min (pode atrasar horas
  // em repos de baixa atividade) — em vez de exigir bater a hora exata, verifica
  // se algum horário-alvo já passou e ainda não foi notificado hoje, e recupera
  // no próximo run que rodar (evita perder o dia inteiro por causa do atraso).
  const passados = HORAS_ALVO.filter(h => h <= agora.hora);
  const state = lerState();
  const enviadosHoje = state.dia === hoje ? (state.enviados || []) : [];
  const faltando = passados.filter(h => !enviadosHoje.includes(h));
  if (faltando.length === 0) {
    console.log('Nenhum horário-alvo pendente ainda (hora atual: ' + agora.hora + 'h BRT).');
    return;
  }

  const dados = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const sub = JSON.parse(fs.readFileSync(subPath, 'utf8'));

  const compras = dados.compras || [];
  const pendentesVencidos = compras.filter(c => c.status === 'Pendente' && diasEmAberto(c.dataCompra || c.data) >= 0);

  console.log('Compras pendentes vencidas hoje:', pendentesVencidos.length);
  if (pendentesVencidos.length === 0) {
    console.log('Nada vencido hoje — não envia notificação.');
    return;
  }

  const total = pendentesVencidos.reduce((a, c) => a + custoTotalCompra(c), 0);
  const valorFmt = 'R$ ' + total.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qtdFmt = pendentesVencidos.length + ' produto' + (pendentesVencidos.length > 1 ? 's' : '');
  const frase = FRASES[Math.floor(Math.random() * FRASES.length)];
  const titulo = frase.replace('{valor}', valorFmt);
  const produtos = pendentesVencidos.slice(0, 5).map(c => '• ' + c.produto + ' (' + c.qtd + 'x)').join('\n');
  const corpo = qtdFmt + ' pendente' + (pendentesVencidos.length > 1 ? 's' : '') + ':\n' + produtos + (pendentesVencidos.length > 5 ? '\n…+' + (pendentesVencidos.length - 5) + ' mais' : '');

  webpush.setVapidDetails('mailto:contato@zyntraglobal.com.br', VAPID_PUBLIC, VAPID_PRIVATE);

  const payload = JSON.stringify({ title: titulo, body: corpo, icon: '/zyntra-app/icon-192.png', badge: '/zyntra-app/icon-192.png', tag: 'zyntra-gestao-diaria-' + Date.now() });

  try {
    await webpush.sendNotification(sub, payload);
    console.log('Push enviado com sucesso:', titulo);
    salvarState({ dia: hoje, enviados: passados });
  } catch (err) {
    console.log('Erro ao enviar push. statusCode:', err.statusCode, '| body:', err.body);
    process.exitCode = 1;
  }
}

main();
