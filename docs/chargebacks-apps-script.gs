/**
 * Zyntra Gestão — ponte da planilha de Chargebacks da Stark Bank.
 *
 * Este código roda NA CONTA GOOGLE que tem acesso à planilha (não no GitHub).
 * Ele lê a planilha e devolve as linhas em JSON só pra quem mandar a CHAVE
 * certa — quem chama é a tarefa automática do GitHub (scripts/chargebacks-sync.js).
 *
 * Instalação (uma vez só):
 *  1. Entre em https://script.google.com com a conta que abre a planilha.
 *  2. "Novo projeto" → apague o que vier e cole este código.
 *  3. Preencha ID_PLANILHA e CHAVE abaixo (a chave é uma senha longa qualquer,
 *     a mesma que vai no secret SHEET_KEY do GitHub).
 *  4. Rode a função "testar" uma vez (botão ▶ Executar) e autorize o acesso.
 *  5. "Implantar" → "Nova implantação" → tipo "App da Web":
 *       Executar como: Eu
 *       Quem pode acessar: Qualquer pessoa
 *     Copie a URL que termina em /exec → é o secret SHEET_URL do GitHub.
 *
 * "Qualquer pessoa" só quer dizer que a URL não pede login do Google — sem a
 * CHAVE certa ela não devolve nada da planilha.
 */

const ID_PLANILHA = 'COLE_AQUI_O_ID_DA_PLANILHA';
const CHAVE = 'COLE_AQUI_A_CHAVE_SECRETA';

function doGet(e) {
  const chave = e && e.parameter ? e.parameter.chave : '';
  if (!chave || chave !== CHAVE) return json_({ ok: false, erro: 'chave inválida' });
  try {
    return json_({ ok: true, lidoEm: new Date().toISOString(), abas: lerAbas_() });
  } catch (err) {
    return json_({ ok: false, erro: String(err && err.message || err) });
  }
}

function lerAbas_() {
  const ss = SpreadsheetApp.openById(ID_PLANILHA);
  // getDisplayValues: datas e valores exatamente como aparecem na tela
  return ss.getSheets().map(function (sh) {
    return { nome: sh.getName(), gid: sh.getSheetId(), linhas: sh.getDataRange().getDisplayValues() };
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Rode esta função pelo editor pra autorizar e conferir se a planilha abre.
function testar() {
  const abas = lerAbas_();
  abas.forEach(function (a) {
    Logger.log('Aba "' + a.nome + '" (gid ' + a.gid + '): ' + a.linhas.length + ' linhas');
    Logger.log('  Cabeçalho: ' + (a.linhas[0] || []).join(' | '));
  });
}
