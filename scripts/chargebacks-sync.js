// Roda via GitHub Actions (a cada 15 min) e mantém a aba Chargebacks do Zyntra
// Gestão (data.json do repositório de dados) em dia com a Stark Bank, sem
// nenhum cadastro manual.
//
// FONTE PRINCIPAL — a planilha de chargebacks da Stark (Google Sheets privada).
//   Quem lê a planilha é um Apps Script instalado na conta Google que tem acesso
//   a ela (veja docs/chargebacks-apps-script.gs). Ele devolve as linhas em JSON
//   pra quem mandar a chave certa. Este script:
//     - cria um chargeback pra cada processo novo da planilha;
//     - atualiza valor, prazo, tratativa, status etc. quando mudam;
//     - registra no histórico cada mudança de tratativa/status;
//     - manda push pro celular com as novidades.
//
// FONTE ALTERNATIVA — os emails "Resumo de Atualizações: Chargebacks [Stark Bank]"
//   (IMAP da Hostinger). Só é usada se a planilha NÃO estiver configurada. O
//   email não traz número/valor dos chargebacks novos, então nesse modo eles
//   viram um aviso na aba até serem cadastrados.
//
// Também manda, 1x por dia (8h BRT), um lembrete dos chargebacks com prazo de
// defesa acabando.
//
// Secrets: SHEET_URL + SHEET_KEY (planilha) ou IMAP_USER + IMAP_PASS (email);
// GH_DATA_TOKEN (dados); VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (push, opcionais).
// Opcional: SHEET_GID (aba da planilha; sem ele, usa a primeira aba que tiver
// uma coluna "processo").

const P = require('./chargebacks-parser');

const SHEET_URL = process.env.SHEET_URL;
const SHEET_KEY = process.env.SHEET_KEY;
const SHEET_GID = process.env.SHEET_GID || '';
const IMAP_HOST = process.env.IMAP_HOST || 'imap.hostinger.com';
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASS = process.env.IMAP_PASS;
const REMETENTE = process.env.CB_REMETENTE || 'starkbank.com';
const GH_DATA_TOKEN = process.env.GH_DATA_TOKEN;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const DATA_REPO = 'ZyntraGlobal/zyntra-app-data';
const STATE_FILE = 'chargebacks-state.json';
const DIAS_BUSCA = 45;
const MAX_REGISTRO = 400;
const HORA_LEMBRETE = 8;
const PRAZO_PADRAO = 5;

const R = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── GitHub (repositório de dados) ─────────────────────
async function ghGetJSON(caminho) {
  const r = await fetch('https://api.github.com/repos/' + DATA_REPO + '/contents/' + caminho, {
    headers: { 'Authorization': 'Bearer ' + GH_DATA_TOKEN, 'Accept': 'application/vnd.github+json' }
  });
  if (r.status === 404) return { json: null, sha: null };
  if (!r.ok) throw new Error('Falha ao ler ' + caminho + ' (' + r.status + ')');
  const info = await r.json();
  let texto;
  if (info.content && info.encoding === 'base64') {
    texto = Buffer.from(info.content, 'base64').toString('utf8');
  } else {
    // Arquivo > 1 MB: a API não manda o conteúdo junto — baixa pelo blob
    const rb = await fetch(info.git_url, { headers: { 'Authorization': 'Bearer ' + GH_DATA_TOKEN, 'Accept': 'application/vnd.github.raw+json' } });
    if (!rb.ok) throw new Error('Falha ao baixar ' + caminho + ' (' + rb.status + ')');
    texto = await rb.text();
  }
  return { json: JSON.parse(texto), sha: info.sha };
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
  if (r.status === 409 || r.status === 422) { const e = new Error('conflito'); e.conflito = true; throw e; }
  if (!r.ok) throw new Error('Falha ao gravar ' + caminho + ' (' + r.status + '): ' + await r.text());
}

function agoraBRT() {
  const q = P.dataBRT(new Date());
  return q.data + ' ' + q.hora;
}
function excluidosDe(dados) {
  const ex = {};
  (dados.cbExcluidos || []).forEach(x => { ex[String(x.processo)] = x.em || 0; });
  return ex;
}

// ── Planilha ──────────────────────────────────────────
async function lerPlanilhaRemota() {
  const url = SHEET_URL + (SHEET_URL.indexOf('?') >= 0 ? '&' : '?') + 'chave=' + encodeURIComponent(SHEET_KEY);
  const r = await fetch(url, { redirect: 'follow' });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('Apps Script não devolveu JSON (HTTP ' + r.status + '). Confira se foi implantado como "Qualquer pessoa".'); }
  if (!j.ok) throw new Error('Apps Script recusou: ' + (j.erro || 'erro desconhecido'));
  const abas = j.abas || [];
  let escolhida = SHEET_GID ? abas.find(a => String(a.gid) === String(SHEET_GID)) : null;
  let lida = escolhida ? P.lerPlanilha(escolhida.linhas) : null;
  if (!lida || !lida.mapa) {
    for (const a of abas) { const t = P.lerPlanilha(a.linhas); if (t.mapa) { escolhida = a; lida = t; break; } }
  }
  if (!lida || !lida.mapa) throw new Error('Nenhuma aba da planilha tem coluna de "processo". Abas: ' + abas.map(a => a.nome).join(', '));
  console.log('Aba lida: "' + escolhida.nome + '" | ' + lida.registros.length + ' processos');
  console.log('Colunas reconhecidas:', JSON.stringify(Object.fromEntries(Object.entries(lida.mapa).map(([k, i]) => [k, lida.cabecalho[i]]))));
  return lida;
}

const CAMPOS_PLANILHA = ['valor', 'recebido', 'prazo', 'tratativa', 'status', 'pedido', 'cliente', 'motivo', 'dataVenda'];

// Aplica a planilha no data.json. Devolve { alteracoes, novidades } —
// novidades são frases pro push (só o que mudou de verdade nesta execução).
function aplicarPlanilha(dados, lida) {
  if (!Array.isArray(dados.chargebacks)) dados.chargebacks = [];
  const excluidos = excluidosDe(dados);
  const quando = agoraBRT();
  let alteracoes = 0;
  const novos = [], mudancas = [];

  for (const r of lida.registros) {
    if (excluidos[r.processo]) continue;
    let c = dados.chargebacks.find(x => String(x.processo) === r.processo);
    if (!c) {
      c = { processo: r.processo, origem: 'planilha', criadoEm: quando, valor: 0, recebido: '', prazo: '', pedido: '', cliente: '', motivo: '', tratativa: '', status: '', obs: '', historico: [
        { quando, campo: 'Cadastro', de: '', para: 'Encontrado na planilha da Stark', origem: 'planilha' }
      ] };
      dados.chargebacks.push(c);
      novos.push(r);
      alteracoes++;
    }
    if (!Array.isArray(c.historico)) c.historico = [];
    let mudou = false;
    for (const k of CAMPOS_PLANILHA) {
      const v = r[k];
      if (v === '' || v === 0 || v == null) continue;
      if (String(c[k] == null ? '' : c[k]) === String(v)) continue;
      if ((k === 'tratativa' || k === 'status') && c[k]) {
        c.historico.push({ quando, campo: k === 'tratativa' ? 'Tratativa' : 'Status', de: c[k], para: v, origem: 'planilha' });
        mudancas.push({ processo: r.processo, para: v });
      }
      c[k] = v;
      mudou = true;
    }
    if (!c.prazo && c.recebido) { c.prazo = P.somarDias(c.recebido, PRAZO_PADRAO); mudou = true; }
    if (JSON.stringify(c.planilha || {}) !== JSON.stringify(r.planilha)) { c.planilha = r.planilha; mudou = true; }
    if (mudou) { c.atualizadoEm = quando; alteracoes++; }
  }

  // Avisos de "novos chargebacks" do modo email não fazem mais sentido: a
  // planilha já traz cada um. Fecha os que estiverem abertos.
  (dados.cbAvisos || []).forEach(a => { if (!a.resolvido) { a.resolvido = true; alteracoes++; } });

  const novidades = [];
  if (novos.length) {
    const total = novos.reduce((s, r) => s + (r.valor || 0), 0);
    novidades.push('🆕 ' + novos.length + ' novo' + (novos.length > 1 ? 's' : '') + ' (' + R(total) + ')' + (novos[0].prazo ? ' — defesa até ' + novos[0].prazo : ''));
    novos.slice(0, 3).forEach(r => novidades.push('   • ' + r.processo + (r.valor ? ' · ' + R(r.valor) : '')));
  }
  mudancas.forEach(m => {
    const ico = /n[aã]o defendido|emissor/i.test(m.para) ? '🔴' : /favor/i.test(m.para) ? '✅' : '✏️';
    novidades.push(ico + ' ' + m.processo + ': ' + m.para);
  });
  return { alteracoes, novidades, qtdNovos: novos.length };
}

// ── Email (alternativa) ───────────────────────────────
async function lerEmails(jaVistos) {
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: true, auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false });
  await client.connect();
  const lidos = [];
  try {
    const pastas = ['INBOX'];
    try { (await client.list()).filter(m => m.specialUse === '\\Junk').forEach(m => pastas.push(m.path)); } catch (e) {}
    const desde = new Date(Date.now() - DIAS_BUSCA * 86400000);
    for (const pasta of pastas) {
      let lock;
      try { lock = await client.getMailboxLock(pasta, { readOnly: true }); }
      catch (e) { console.log('Não abriu a pasta ' + pasta + ': ' + e.message); continue; }
      try {
        const uids = await client.search({ since: desde, from: REMETENTE, subject: 'Chargebacks' }, { uid: true });
        if (!uids || !uids.length) continue;
        const candidatos = [];
        for await (const msg of client.fetch(uids, { envelope: true, internalDate: true }, { uid: true })) {
          const id = (msg.envelope && msg.envelope.messageId) || (pasta + ':' + msg.uid + ':' + String(msg.internalDate));
          if (!jaVistos.has(id)) candidatos.push({ uid: msg.uid, id });
        }
        for (const c of candidatos) {
          const msg = await client.fetchOne(String(c.uid), { source: true, internalDate: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const mail = await simpleParser(msg.source);
          const html = mail.html || '';
          const r = P.interpretarResumo(html ? P.htmlParaTexto(html) : String(mail.text || ''));
          const quandoEm = mail.date || msg.internalDate || new Date();
          const q = P.dataBRT(quandoEm);
          lidos.push({ id: c.id, assunto: mail.subject || '', quandoMs: new Date(quandoEm).getTime(), data: q.data, hora: q.hora, link: P.acharLinkPlanilha(html), novos: r.novos, mudancas: r.mudancas });
          jaVistos.add(c.id);
        }
      } finally { lock.release(); }
    }
  } finally { await client.logout().catch(() => {}); }
  return lidos;
}

// Reaplica todo o registro de emails, de forma idempotente (cada mudança tem
// uma chave guardada no histórico do chargeback).
function aplicarEmails(dados, registro) {
  if (!Array.isArray(dados.chargebacks)) dados.chargebacks = [];
  if (!Array.isArray(dados.cbAvisos)) dados.cbAvisos = [];
  const excluidos = excluidosDe(dados);
  let n = 0;
  for (const em of registro.slice().sort((a, b) => a.quandoMs - b.quandoMs)) {
    if (em.novos && em.novos.qtd > 0 && !dados.cbAvisos.some(a => a.id === em.id)) {
      dados.cbAvisos.push({ id: em.id, origem: 'email', data: em.data, hora: em.hora, qtd: em.novos.qtd, total: em.novos.total, prazoDias: em.novos.prazoDias, prazo: P.somarDias(em.data, em.novos.prazoDias), link: em.link || '', cadastrados: 0, resolvido: false });
      n++;
    }
    (em.mudancas || []).forEach((m, i) => {
      const chave = em.id + '#' + i, proc = String(m.processo);
      if (excluidos[proc] && em.quandoMs <= excluidos[proc]) return;
      let c = dados.chargebacks.find(x => String(x.processo) === proc);
      if (c && (c.historico || []).some(h => h.chave === chave)) return;
      if (!c) { c = { processo: proc, origem: 'email', criadoEm: em.data + ' ' + em.hora, valor: 0, recebido: '', prazo: '', pedido: '', cliente: '', motivo: '', tratativa: '', status: '', obs: '', historico: [] }; dados.chargebacks.push(c); }
      if (!Array.isArray(c.historico)) c.historico = [];
      const campo = m.campo === 'tratativa' ? 'tratativa' : 'status';
      c.historico.push({ quando: em.data + ' ' + em.hora, campo: campo === 'tratativa' ? 'Tratativa' : 'Status', de: m.de, para: m.para + (m.nota ? ' (' + m.nota + ')' : ''), origem: 'email', chave });
      if (em.quandoMs >= (c['_ms_' + campo] || 0)) { c[campo] = m.para; c['_ms_' + campo] = em.quandoMs; }
      c.atualizadoEm = em.data + ' ' + em.hora;
      n++;
    });
  }
  return n;
}

// ── Push ──────────────────────────────────────────────
async function enviarPush(titulo, corpo, tag) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) { console.log('Sem chaves VAPID — push não enviado.'); return false; }
  const webpush = require('web-push');
  const { json: subRaw } = await ghGetJSON('push-sub.json');
  const lista = Array.isArray(subRaw) ? subRaw : (subRaw && subRaw.endpoint ? [subRaw] : []);
  const subs = lista.filter(s => s.role === 'dono' || !s.role);
  if (!subs.length) { console.log('Nenhum aparelho inscrito.'); return false; }
  webpush.setVapidDetails('mailto:contato@zyntraglobal.com.br', VAPID_PUBLIC, VAPID_PRIVATE);
  const payload = JSON.stringify({ title: titulo, body: corpo, icon: '/zyntra-app/icon-192.png', badge: '/zyntra-app/icon-192.png', tag: tag + '-' + Date.now() });
  let ok = 0;
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload); ok++; }
    catch (err) { console.log('Erro push [' + (s.deviceId || '?') + ']:', err.statusCode); }
  }
  console.log('Push "' + titulo + '": ' + ok + '/' + subs.length);
  return ok > 0;
}

function diasAte(dataStr, hojeMs) {
  const p = String(dataStr || '').split('/');
  if (p.length !== 3) return null;
  const d = Date.UTC(Number(p[2]), Number(p[1]) - 1, Number(p[0]));
  return isNaN(d) ? null : Math.round((d - hojeMs) / 86400000);
}
function precisaDefesa(c) {
  const st = (c.status || '').toUpperCase(), tr = (c.tratativa || '').toUpperCase();
  if (/EMISSOR|FAVOR/.test(st)) return false;
  if (/N[AÃ]O DEFENDIDO|ACEITO/.test(tr)) return false;
  return /AGUARDANDO CLIENTE/.test(tr) || /AGUARDANDO CLIENTE/.test(st) || (!tr && !st);
}

// ── Principal ─────────────────────────────────────────
async function main() {
  if (!GH_DATA_TOKEN) { console.log('GH_DATA_TOKEN não configurado — abortando.'); return; }
  const modoPlanilha = !!(SHEET_URL && SHEET_KEY);
  const modoEmail = !modoPlanilha && !!(IMAP_USER && IMAP_PASS);
  if (!modoPlanilha && !modoEmail) { console.log('Nem SHEET_URL/SHEET_KEY nem IMAP_USER/IMAP_PASS configurados — nada a fazer.'); return; }
  console.log('Modo:', modoPlanilha ? 'planilha' : 'email');

  const { json: stAtual, sha: stSha } = await ghGetJSON(STATE_FILE);
  const estado = stAtual || {};
  const novoEstado = Object.assign({}, estado);

  // Busca a fonte ANTES de ler o data.json (deixa a janela de conflito curta)
  let lida = null, registro = Array.isArray(estado.emails) ? estado.emails : [], emailsNovos = [];
  if (modoPlanilha) {
    lida = await lerPlanilhaRemota();
  } else {
    const vistos = new Set(registro.map(e => e.id).concat(estado.ignorados || []));
    const ignorados = (estado.ignorados || []).slice();
    for (const e of await lerEmails(vistos)) {
      if (!e.novos && !e.mudancas.length) { console.log('Email sem nada reconhecível (' + e.assunto + ') — formato mudou?'); ignorados.push(e.id); continue; }
      registro.push(e); emailsNovos.push(e);
    }
    novoEstado.emails = registro.sort((a, b) => a.quandoMs - b.quandoMs).slice(-MAX_REGISTRO);
    novoEstado.ignorados = ignorados.slice(-200);
    console.log('Emails novos:', emailsNovos.length);
  }

  let res = { alteracoes: 0, novidades: [], qtdNovos: 0 }, dadosFinal = null;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const { json: dados, sha } = await ghGetJSON('data.json');
    if (!dados) { console.log('data.json não encontrado — abortando.'); return; }
    if (modoPlanilha) res = aplicarPlanilha(dados, lida);
    else res = { alteracoes: aplicarEmails(dados, registro), novidades: [], qtdNovos: 0 };
    dadosFinal = dados;
    if (!res.alteracoes) break;
    dados._savedAt = Date.now();
    try {
      await ghPutJSON('data.json', dados, sha, 'Chargebacks: ' + res.alteracoes + ' atualização(ões) da Stark');
      console.log('data.json atualizado (' + res.alteracoes + ' alterações).');
      break;
    } catch (e) {
      if (!e.conflito || tentativa === 3) throw e;
      console.log('Conflito ao gravar data.json — tentando de novo...');
    }
  }
  // Avisa o app desktop na hora (mesmo gatilho usado quando o app salva)
  if (res.alteracoes) await fetch('https://ntfy.sh/zyntra-trigger-gestao-zg2026', { method: 'POST', body: 'sync' }).catch(() => {});

  // Push das novidades. Na primeira leitura da planilha tudo é "novo" — manda
  // só um resumo em vez de anunciar o histórico inteiro como chargeback novo.
  if (modoPlanilha) {
    if (!estado.planilhaIniciada) {
      const n = (dadosFinal.chargebacks || []).length;
      await enviarPush('⚖️ Chargebacks conectados à planilha da Stark', n + ' processo(s) importado(s). A partir de agora, novidades chegam aqui.', 'zyntra-cb').catch(e => console.log('Falha no push:', e.message));
      novoEstado.planilhaIniciada = true;
    } else if (res.novidades.length) {
      const titulo = res.qtdNovos ? '⚖️ ' + res.qtdNovos + ' chargeback(s) novo(s) na Stark' : '⚖️ Chargebacks atualizados';
      await enviarPush(titulo, res.novidades.slice(0, 6).join('\n') + (res.novidades.length > 6 ? '\n…+' + (res.novidades.length - 6) + ' mais' : ''), 'zyntra-cb').catch(e => console.log('Falha no push:', e.message));
    }
  } else if (emailsNovos.length) {
    const linhas = [];
    emailsNovos.forEach(e => {
      if (e.novos) linhas.push('🆕 ' + e.novos.qtd + ' novo(s) (' + R(e.novos.total) + ') — cadastre na aba');
      e.mudancas.forEach(m => linhas.push((/n[aã]o defendido|emissor/i.test(m.para) ? '🔴 ' : '✏️ ') + m.processo + ': ' + m.para));
    });
    if (linhas.length) await enviarPush('⚖️ Resumo de chargebacks da Stark', linhas.slice(0, 6).join('\n'), 'zyntra-cb').catch(e => console.log('Falha no push:', e.message));
  }

  // Lembrete diário de prazo
  const agora = new Date(Date.now() - 3 * 3600000);
  const hojeData = P.dataBRT(new Date()).data;
  const hojeMs = Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate());
  if (agora.getUTCHours() >= HORA_LEMBRETE && estado.lembreteDia !== hojeData && dadosFinal) {
    const linhas = [];
    (dadosFinal.chargebacks || []).forEach(c => {
      const d = diasAte(c.prazo, hojeMs);
      if (precisaDefesa(c) && d !== null && d >= 0 && d <= 2) linhas.push('• ' + c.processo + (c.valor ? ' · ' + R(c.valor) : '') + ' — ' + (d === 0 ? 'vence HOJE' : 'faltam ' + d + 'd'));
    });
    (dadosFinal.cbAvisos || []).forEach(a => {
      const d = diasAte(a.prazo, hojeMs);
      if (!a.resolvido && (a.qtd || 0) > (a.cadastrados || 0) && d !== null && d >= 0) linhas.push('• ' + ((a.qtd || 0) - (a.cadastrados || 0)) + ' sem cadastro (email de ' + a.data + ') — prazo ' + a.prazo);
    });
    if (linhas.length) await enviarPush('⏰ Chargebacks com prazo de defesa acabando', linhas.slice(0, 6).join('\n'), 'zyntra-cb-prazo').catch(e => console.log('Falha no push:', e.message));
    novoEstado.lembreteDia = hojeData;
  }

  if (JSON.stringify(novoEstado) !== JSON.stringify(estado)) {
    await ghPutJSON(STATE_FILE, novoEstado, stSha, 'Chargebacks: estado da sincronização').catch(e => console.log('Aviso: falha ao salvar estado:', e.message));
  }
}

main().catch(e => { console.error('Erro:', e.message); process.exitCode = 1; });
