// Roda via GitHub Actions (agendado) — manda notificação push avisando sobre
// pendências vencidas ou urgentes, independente do desktop ou iPhone estarem ligados.
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

// Título tem que caber numa linha só (o iOS corta e não expande sozinho na
// tela de bloqueio) — detalhes (títulos das pendências) vão no corpo.
const FRASES = [
  '📌 {qtd} pendência(s) te esperando',
  '⚠️ {qtd} pendência(s) em aberto',
  '🔴 {qtd} pendência(s) precisam de atenção'
];

// Horário-alvo (hora cheia, BRT) em que a notificação deve disparar.
// O workflow roda a cada 15 min — isso aqui decide SE é a hora certa.
const HORAS_ALVO = [8];
const STATE_PATH = path.join(__dirname, '..', 'notif-state-pendencias.json');

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
  if (!dataStr) return 0;
  const p = dataStr.split('/');
  if (p.length !== 3) return 0;
  const d = Date.UTC(Number(p[2]), Number(p[1]) - 1, Number(p[0]));
  const h = hojeBRT();
  const hUTC = Date.UTC(h.ano, h.mes - 1, h.dia);
  return Math.floor((hUTC - d) / (1000 * 60 * 60 * 24));
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

  const pendencias = dados.pendencias || [];
  const abertas = pendencias.filter(p => p.status === 'Aberta' || p.status === 'Em Andamento');
  const relevantes = abertas.filter(p => (p.prazo && diasEmAberto(p.prazo) >= 0) || p.prioridade === 'Urgente');

  console.log('Pendências vencidas/urgentes hoje:', relevantes.length);
  if (relevantes.length === 0) {
    console.log('Nada vencido/urgente — não envia notificação.');
    return;
  }

  const valorTotal = relevantes.reduce((a, p) => a + (Number(p.valor) || 0), 0);
  const frase = FRASES[Math.floor(Math.random() * FRASES.length)];
  const titulo = frase.replace('{qtd}', relevantes.length);
  const linhas = relevantes.slice(0, 5).map(p => '• ' + p.titulo + (p.prioridade === 'Urgente' ? ' 🔴' : ''));
  const valorFmt = valorTotal > 0 ? '\n💰 R$ ' + valorTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' envolvidos' : '';
  const corpo = linhas.join('\n') + (relevantes.length > 5 ? '\n…+' + (relevantes.length - 5) + ' mais' : '') + valorFmt;

  webpush.setVapidDetails('mailto:contato@zyntraglobal.com.br', VAPID_PUBLIC, VAPID_PRIVATE);

  const payload = JSON.stringify({ title: titulo, body: corpo, icon: '/zyntra-app/icon-192.png', badge: '/zyntra-app/icon-192.png', tag: 'zyntra-gestao-pendencias-' + Date.now() });

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
