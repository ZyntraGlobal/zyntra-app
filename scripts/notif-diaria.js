// Roda via GitHub Actions (agendado) — manda notificação push avisando quanto
// precisa investir em compras hoje, independente do desktop ou iPhone estarem ligados.
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

const FRASES = [
  '💰 Hoje você precisa investir {valor} em {qtd} na Zyntra',
  '🛒 De olho no caixa: {valor} em {qtd} esperando por você hoje',
  '📦 Hora de comprar! {valor} em {qtd} te esperando hoje',
  '⚡ Investimento do dia: {valor} em {qtd} pra manter o estoque girando',
  '🎯 Foco de hoje: {valor} em {qtd} pra fechar'
];

function hojeBRT() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000); // America/Sao_Paulo, UTC-3 fixo (sem horário de verão)
  return { ano: brt.getUTCFullYear(), mes: brt.getUTCMonth() + 1, dia: brt.getUTCDate() };
}

function diasEmAberto(dataStr) {
  if (!dataStr) return 0;
  const p = dataStr.split('/');
  if (p.length !== 3) return 0;
  const d = Date.UTC(Number(p[2]), Number(p[1]) - 1, Number(p[0]));
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
  const titulo = frase.replace('{valor}', valorFmt).replace('{qtd}', qtdFmt);
  const produtos = pendentesVencidos.slice(0, 5).map(c => '• ' + c.produto + ' (' + c.qtd + 'x)').join('\n');
  const corpo = produtos + (pendentesVencidos.length > 5 ? '\n…+' + (pendentesVencidos.length - 5) + ' mais' : '');

  webpush.setVapidDetails('mailto:contato@zyntraglobal.com.br', VAPID_PUBLIC, VAPID_PRIVATE);

  const payload = JSON.stringify({ title: titulo, body: corpo, icon: '/zyntra-app/icon-192.png', badge: '/zyntra-app/icon-192.png', tag: 'zyntra-gestao-diaria-' + Date.now() });

  try {
    await webpush.sendNotification(sub, payload);
    console.log('Push enviado com sucesso:', titulo);
  } catch (err) {
    console.log('Erro ao enviar push. statusCode:', err.statusCode, '| body:', err.body);
    process.exitCode = 1;
  }
}

main();
