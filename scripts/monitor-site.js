// Roda via GitHub Actions a cada ~15 min — vigia o site zyntraglobal.com.br e
// manda push pro celular do dono quando algo SAI do normal (e quando VOLTA).
// É a parte "app fechado" da aba Torre de Comando do Gestão.
//
// O que confere (tudo só leitura, nada é alterado no site ou no DNS):
//  • site no ar (WordPress respondendo) e loja mostrando produtos
//  • domínio nos servidores da Cloudflare (NS)
//  • e-mails apontando pra Hostinger (MX)
//  • assinatura DKIM dos e-mails publicada
//  • e-mails saindo do site (snippet "Zyntra - saude do site para a Torre de Comando")
//  • (opcional) administradores do painel — só se os secrets WP_MONITOR_USER e
//    WP_MONITOR_APP_PASSWORD existirem (senha de aplicativo do WordPress).
//
// Contra alarme falso: um problema só vira aviso depois de falhar em 2
// verificações seguidas. O estado fica em monitor-site-state.json no repo de
// dados e só é regravado quando algo muda.
//
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, GH_DATA_TOKEN
// Disparo manual com TESTE=1 manda uma notificação de teste (e o resumo atual).

let webpush = null; // carregado só na hora de mandar push (o teste local SECO=1 não precisa dele)

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'https://zyntraglobal.github.io/zyntra-app/';
const GH_DATA_TOKEN = process.env.GH_DATA_TOKEN;
const WP_USER = process.env.WP_MONITOR_USER || '';
const WP_APP_PASS = (process.env.WP_MONITOR_APP_PASSWORD || '').replace(/\s+/g, '');
const TESTE = process.env.TESTE === '1';
const SECO = process.env.SECO === '1'; // só mostra no log, não grava estado nem manda push (teste local)
const DATA_REPO = 'ZyntraGlobal/zyntra-app-data';
const STATE_FILE = 'monitor-site-state.json';
const SITE = 'https://zyntraglobal.com.br';
const NS_ESPERADO = ['ignat.ns.cloudflare.com', 'walk.ns.cloudflare.com'];
const FALHAS_PRA_AVISAR = 2;

async function ghGetJSON(caminho) {
  const r = await fetch('https://api.github.com/repos/' + DATA_REPO + '/contents/' + caminho, {
    headers: { 'Authorization': 'Bearer ' + GH_DATA_TOKEN, 'Accept': 'application/vnd.github+json' }
  });
  if (r.status === 404) return { json: null, sha: null };
  if (!r.ok) throw new Error('Falha ao ler ' + caminho + ' (' + r.status + ')');
  const info = await r.json();
  return { json: JSON.parse(Buffer.from(info.content, 'base64').toString('utf8')), sha: info.sha };
}
async function ghPutJSON(caminho, obj, sha, mensagem) {
  const body = { message: mensagem, content: Buffer.from(JSON.stringify(obj, null, 2) + '\n').toString('base64') };
  if (sha) body.sha = sha;
  const r = await fetch('https://api.github.com/repos/' + DATA_REPO + '/contents/' + caminho, {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + GH_DATA_TOKEN, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('Falha ao gravar ' + caminho + ' (' + r.status + '): ' + await r.text());
}

async function buscar(url, opts = {}, ms = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': 'zyntra-monitor', ...(opts.headers || {}) } }); }
  finally { clearTimeout(t); }
}

// DNS público (Cloudflare e, se falhar, Google). Lança erro se os dois falharem —
// erro de consulta NÃO conta como "DNS mudou".
async function dns(nome, tipo) {
  const urls = [
    'https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(nome) + '&type=' + tipo,
    'https://dns.google/resolve?name=' + encodeURIComponent(nome) + '&type=' + tipo
  ];
  for (const u of urls) {
    try {
      const r = await buscar(u, { headers: { accept: 'application/dns-json' } }, 15000);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.Status !== 0 && j.Status !== 3) continue;
      return (j.Answer || []).map(a => ({ t: a.type, d: String(a.data || '').replace(/^"|"$/g, '').replace(/" "/g, '').replace(/\.$/, '').toLowerCase() }));
    } catch (e) { /* tenta o próximo */ }
  }
  throw new Error('DNS público sem resposta');
}

// Cada verificação devolve { ok: true|false, detalhe } ou lança erro (= "não deu pra conferir",
// que não conta como falha nem como volta ao normal).
const VERIFICACOES = [
  { id: 'site', nome: 'Site fora do ar', voltou: 'Site voltou ao ar', rede: true, fn: async () => {
    const t0 = Date.now();
    const r = await buscar(SITE + '/wp-json/?_fields=name', { cache: 'no-store' });
    if (!r.ok) return { ok: false, detalhe: 'O site respondeu com erro ' + r.status + '.' };
    await r.json();
    return { ok: true, detalhe: 'respondeu em ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s' };
  } },
  { id: 'loja', nome: 'Loja sem mostrar produtos', voltou: 'Loja voltou a mostrar produtos', rede: true, fn: async () => {
    const r = await buscar(SITE + '/wp-json/wp/v2/product?per_page=1&_fields=id', { cache: 'no-store' });
    if (!r.ok) return { ok: false, detalhe: 'A lista de produtos respondeu com erro ' + r.status + '.' };
    const j = await r.json();
    return Array.isArray(j) && j.length ? { ok: true, detalhe: 'catálogo ok' } : { ok: false, detalhe: 'A loja respondeu sem nenhum produto publicado.' };
  } },
  { id: 'ns', nome: 'Domínio saiu da Cloudflare', voltou: 'Domínio voltou para a Cloudflare', fn: async () => {
    const a = (await dns('zyntraglobal.com.br', 'NS')).filter(x => x.t === 2).map(x => x.d).sort();
    const ok = a.length === NS_ESPERADO.length && NS_ESPERADO.every(n => a.includes(n));
    return { ok, detalhe: ok ? a.join(', ') : 'Servidores do domínio agora: ' + (a.join(', ') || 'nenhum') + '. Alguém mexeu no registro do domínio.' };
  } },
  { id: 'mx', nome: 'E-mails não apontam mais pra Hostinger', voltou: 'E-mails voltaram a apontar pra Hostinger', fn: async () => {
    const a = (await dns('zyntraglobal.com.br', 'MX')).filter(x => x.t === 15).map(x => x.d);
    const ok = a.some(x => /mx1\.hostinger\.com$/.test(x)) && a.some(x => /mx2\.hostinger\.com$/.test(x));
    return { ok, detalhe: ok ? a.join(' · ') : 'Destino dos e-mails agora: ' + (a.join(', ') || 'nenhum') + '.' };
  } },
  { id: 'dkim', nome: 'Assinatura DKIM dos e-mails sumiu', voltou: 'Assinatura DKIM voltou', fn: async () => {
    const a = await dns('hostingermail-a._domainkey.zyntraglobal.com.br', 'TXT');
    const txt = a.filter(x => x.t === 16).map(x => x.d).join('');
    const ok = /v=dkim1/.test(txt) && /p=\S{20,}/.test(txt);
    return { ok, detalhe: ok ? 'publicada' : 'Na Cloudflare, os registros hostingermail-a/b/c._domainkey precisam estar como "Somente DNS" (nuvem cinza). Sem isso os e-mails caem no spam ou somem.' };
  } },
  // Resumo do snippet "Zyntra - saude do site" (/wp-json/zyntra/v1/saude). Falha = 2+ erros de
  // envio nas últimas 2 h e nenhum e-mail saiu depois do último erro. Se o site não responder,
  // isso fica "não conferido" (quem avisa é a verificação do site).
  { id: 'email', nome: 'Site não está conseguindo enviar e-mails', voltou: 'Site voltou a enviar e-mails', fn: async () => {
    const r = await buscar(SITE + '/wp-json/zyntra/v1/saude', { cache: 'no-store' });
    if (!r.ok) throw new Error('resumo de saúde respondeu ' + r.status);
    const e = (await r.json()).email || {};
    const falhando = e.ultimo_erro && (!e.ultimo_ok || e.ultimo_erro > e.ultimo_ok) && e.erros_2h >= 2;
    return { ok: !falhando, detalhe: falhando
      ? e.erros_2h + ' erros de envio nas últimas 2 h e nenhum e-mail saiu depois disso. Clientes podem não receber senha e confirmação de pedido — veja WP Mail SMTP → Eventos de depuração.'
      : (e.ok_24h || 0) + ' enviados e ' + (e.erros_24h || 0) + ' erros nas últimas 24 h' };
  } }
];

async function adminsAtuais() {
  if (!WP_USER || !WP_APP_PASS) return null;
  const auth = 'Basic ' + Buffer.from(WP_USER + ':' + WP_APP_PASS).toString('base64');
  const r = await buscar(SITE + '/wp-json/wp/v2/users?roles=administrator&context=edit&per_page=100&_fields=username', { headers: { Authorization: auth } });
  if (!r.ok) throw new Error('usuários: erro ' + r.status);
  return (await r.json()).map(u => u.username).sort();
}

async function enviarPush(subs, titulo, corpo, tag) {
  const payload = JSON.stringify({ title: titulo, body: corpo, icon: '/zyntra-app/icon-192.png', badge: '/zyntra-app/icon-192.png', tag: tag + '-' + Date.now() });
  let ok = 0;
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload); ok++; }
    catch (err) { console.log('Erro ao enviar push [' + (s.deviceId || '?') + ']:', err.statusCode, err.body); }
  }
  console.log('Push "' + titulo + '": ' + ok + '/' + subs.length + ' aparelhos');
  return ok;
}

function agoraBR() {
  const d = new Date(Date.now() - 3 * 3600000), p = n => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

async function main() {
  if (!SECO && (!VAPID_PUBLIC || !VAPID_PRIVATE || !GH_DATA_TOKEN)) { console.log('Secrets ausentes — abortando.'); return; }

  // 1) Roda as verificações (as de rede tentam de novo uma vez antes de dar falha)
  const res = {};
  for (const v of VERIFICACOES) {
    try {
      let r = await v.fn();
      if (!r.ok && v.rede) { await new Promise(s => setTimeout(s, 20000)); r = await v.fn(); }
      res[v.id] = r;
    } catch (e) {
      if (v.rede) res[v.id] = { ok: false, detalhe: 'Sem resposta do site (' + (e.name === 'AbortError' ? 'demorou demais' : e.message) + ').' };
      else res[v.id] = { erro: e.message };
    }
    console.log(v.id.padEnd(5), res[v.id].erro ? 'NÃO CONFERIDO: ' + res[v.id].erro : (res[v.id].ok ? 'ok  ' : 'FALHA ') + res[v.id].detalhe);
  }
  let admins = null;
  try { admins = await adminsAtuais(); console.log(admins ? 'admins ' + admins.join(', ') : 'admins (sem senha de aplicativo configurada — pulado)'); }
  catch (e) { console.log('admins NÃO CONFERIDO:', e.message); }

  if (SECO) return;

  // 2) Compara com o estado anterior
  const { json: antigo, sha } = await ghGetJSON(STATE_FILE);
  const st = antigo || { checks: {}, admins: null };
  st.checks = st.checks || {};
  const avisos = [];
  let mudou = !antigo;
  for (const v of VERIFICACOES) {
    const r = res[v.id], c = st.checks[v.id] || { falhas: 0, alertado: false };
    if (r.erro) continue;
    if (r.ok) {
      if (c.alertado) avisos.push({ t: '✅ ' + v.voltou, b: 'Normalizou às ' + agoraBR() + '. ' + (r.detalhe || ''), tag: 'zyntra-monitor-' + v.id });
      if (c.falhas || c.alertado) mudou = true;
      st.checks[v.id] = { falhas: 0, alertado: false };
    } else {
      c.falhas = (c.falhas || 0) + 1; mudou = true;
      if (c.falhas >= FALHAS_PRA_AVISAR && !c.alertado) {
        avisos.push({ t: '🔴 ' + v.nome, b: r.detalhe + ' (conferido às ' + agoraBR() + ')', tag: 'zyntra-monitor-' + v.id });
        c.alertado = true; c.desde = agoraBR();
      }
      st.checks[v.id] = c;
    }
  }
  if (admins) {
    if (!st.admins) { st.admins = admins; mudou = true; console.log('Referência de administradores gravada:', admins.join(', ')); }
    else {
      const novos = admins.filter(u => !st.admins.includes(u)), sairam = st.admins.filter(u => !admins.includes(u));
      if (novos.length) avisos.push({ t: '🔴 Novo administrador no site', b: 'Apareceu: ' + novos.join(', ') + '. Se não foi você, troque as senhas agora.', tag: 'zyntra-monitor-admin' });
      if (sairam.length) avisos.push({ t: '🟡 Administrador removido do site', b: 'Saiu: ' + sairam.join(', ') + '.', tag: 'zyntra-monitor-admin' });
      if (novos.length || sairam.length) { st.admins = admins; mudou = true; }
    }
  }

  // 3) Avisa
  if (avisos.length || TESTE) {
    const { json: subRaw } = await ghGetJSON('push-sub.json');
    const lista = Array.isArray(subRaw) ? subRaw : (subRaw && subRaw.endpoint ? [subRaw] : []);
    const subs = lista.filter(s => s.role === 'dono' || !s.role);
    if (!subs.length) { console.log('Nenhum aparelho do dono inscrito.'); process.exitCode = 1; }
    else {
      webpush = require('web-push');
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
      if (TESTE) {
        const falhas = VERIFICACOES.filter(v => res[v.id] && res[v.id].ok === false).map(v => v.nome);
        await enviarPush(subs, '🗼 Teste da Torre de Comando', falhas.length ? 'Teste ok. Agora com problema: ' + falhas.join(', ') + '.' : 'Teste ok — site, loja, domínio, e-mail, DKIM e envio de e-mails normais. Você será avisado aqui se algo mudar.', 'zyntra-monitor-teste');
      }
      for (const a of avisos) await enviarPush(subs, a.t, a.b, a.tag);
    }
  }
  if (mudou) {
    st.atualizado = agoraBR();
    await ghPutJSON(STATE_FILE, st, sha, 'Monitor do site: atualiza estado').catch(e => console.log('Aviso: falha ao salvar estado:', e.message));
  } else console.log('Tudo como antes — nada a gravar.');
}

main().catch(e => { console.log('Erro:', e.message); process.exitCode = 1; });
