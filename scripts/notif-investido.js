// Roda via GitHub Actions (agendado) — manda notificação push avisando quanto
// JÁ FOI investido em compras hoje. Separada da notificação da manhã (quanto
// falta investir) pra não estourar o limite de caracteres do título no iOS.
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

const FRASES = [
  '💵 Você investiu {valor} hoje em {qtd}',
  '✅ Fechamento do dia: {valor} investidos em {qtd}',
  '📦 Hoje entrou {valor} em {qtd} pro estoque',
  '💪 Resultado de hoje: {valor} investidos em {qtd}'
];

function hojeBRT() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000); // America/Sao_Paulo, UTC-3 fixo (sem horário de verão)
  return { ano: brt.getUTCFullYear(), mes: brt.getUTCMonth() + 1, dia: brt.getUTCDate() };
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

  const dataPath = path.join(__dirname, '..', 'data.json');
  const subPath = path.join(__dirname, '..', 'push-sub.json');

  if (!fs.existsSync(dataPath) || !fs.existsSync(subPath)) {
    console.log('data.json ou push-sub.json não encontrado — abortando.');
    return;
  }

  const dados = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const sub = JSON.parse(fs.readFileSync(subPath, 'utf8'));

  const compras = dados.compras || [];
  const hoje = hojeStr();
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
  const titulo = frase.replace('{valor}', valorFmt).replace('{qtd}', qtdFmt);
  const produtos = investidasHoje.slice(0, 5).map(c => '• ' + c.produto + ' (' + c.qtd + 'x)').join('\n');
  const corpo = produtos + (investidasHoje.length > 5 ? '\n…+' + (investidasHoje.length - 5) + ' mais' : '');

  webpush.setVapidDetails('mailto:contato@zyntraglobal.com.br', VAPID_PUBLIC, VAPID_PRIVATE);

  const payload = JSON.stringify({ title: titulo, body: corpo, icon: '/zyntra-app/icon-192.png', badge: '/zyntra-app/icon-192.png', tag: 'zyntra-gestao-investido-' + Date.now() });

  try {
    await webpush.sendNotification(sub, payload);
    console.log('Push enviado com sucesso:', titulo);
  } catch (err) {
    console.log('Erro ao enviar push. statusCode:', err.statusCode, '| body:', err.body);
    process.exitCode = 1;
  }
}

main();
