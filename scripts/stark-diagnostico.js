// Diagnóstico (temporário): entende como a Stark antecipa as parcelas.
// Só imprime contagens e diferenças de datas agregadas — nada de cliente,
// valores individuais ou IDs (os logs do Actions deste repositório são públicos).
const starkbank = require('starkbank');
starkbank.user = new starkbank.Project({ environment: 'production', id: process.env.STARK_PROJECT_ID, privateKey: process.env.STARK_PRIVATE_KEY });

const dia = s => s ? String(s).slice(0, 10) : '';
const dd = (a, b) => Math.round((new Date(dia(a)) - new Date(dia(b))) / 86400000);
const conta = (m, k) => { m[k] = (m[k] || 0) + 1; };

(async () => {
  const hoje = new Date().toISOString().slice(0, 10);
  const pend = [];
  for await (const p of await starkbank.merchantInstallment.query({ status: 'created' })) pend.push(p);
  console.log('PENDENTES:', pend.length);
  const difDueNominal = {}, faltaDue = {}, faltaNominal = {}, porDue = {};
  pend.forEach(p => {
    conta(difDueNominal, dd(p.nominalDue, p.due));
    conta(faltaDue, Math.floor(dd(p.due, hoje) / 30) + 'm');
    conta(faltaNominal, Math.floor(dd(p.nominalDue, hoje) / 30) + 'm');
    conta(porDue, dia(p.due));
  });
  console.log('nominalDue - due (dias) => qtd:', JSON.stringify(difDueNominal));
  console.log('due a partir de hoje (meses) => qtd:', JSON.stringify(faltaDue));
  console.log('nominalDue a partir de hoje (meses) => qtd:', JSON.stringify(faltaNominal));
  console.log('datas due (primeiras):', JSON.stringify(Object.keys(porDue).sort().slice(0, 6).map(k => k + ':' + porDue[k])));
  console.log('protegidas:', pend.filter(p => p.isProtected).length);

  // Pagas recentemente: quanto antes do vencimento original elas caíram?
  const desde = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const pagas = [];
  for await (const p of await starkbank.merchantInstallment.query({ status: 'paid', after: desde })) pagas.push(p);
  const recentes = pagas.filter(p => dd(hoje, p.updated) <= 45);
  console.log('PAGAS (criadas desde', desde + '):', pagas.length, '| pagas nos últimos 45 dias:', recentes.length);
  const antecipacao = {}, venda = {};
  recentes.forEach(p => {
    conta(antecipacao, Math.floor(dd(p.nominalDue, p.updated) / 30) + 'm');
    conta(venda, dd(p.updated, p.created) + 'd');
  });
  console.log('pago X meses antes do nominalDue => qtd:', JSON.stringify(antecipacao));
  console.log('pago X dias depois da criação da parcela (venda) => qtd:', JSON.stringify(venda));

  // Por compra: quantas parcelas pagas x pendentes (sem identificar a compra)
  const porCompra = {};
  pagas.concat(pend).forEach(p => { const c = porCompra[p.purchaseId] = porCompra[p.purchaseId] || { pago: 0, pend: 0, venda: dia(p.created) }; if (p.status === 'paid') c.pago++; else c.pend++; });
  const mix = {};
  Object.values(porCompra).forEach(c => conta(mix, c.pago + 'pagas+' + c.pend + 'pend'));
  console.log('compras (pagas+pendentes) => qtd:', JSON.stringify(mix));
})().catch(e => { console.error('Erro:', e.message || e); process.exitCode = 1; });
