/** Dependency-free dashboard: untrusted values only enter the DOM via textContent. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pump.fun Sniper — Painel</title>
<style>
:root{color-scheme:dark;--bg:#0d1117;--card:#161b22;--border:#30363d;--muted:#a5afbc}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#e6edf3;font:14px/1.5 system-ui,sans-serif}
header,main,nav{padding:16px 24px}header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;border-bottom:1px solid var(--border)}
h1{font-size:20px;margin:0}h2{font-size:18px}h3{font-size:15px}.badge{border:1px solid var(--border);padding:4px 10px;border-radius:12px;display:inline-block}
nav{display:flex;gap:8px;flex-wrap:wrap}button,input,select{font:inherit;border:1px solid var(--border);border-radius:6px;padding:8px;background:#21262d;color:inherit}
button{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}button[aria-selected="true"]{background:#174c37;border-color:#3fb950}
label{display:flex;flex-direction:column;gap:4px}form,.controls{display:flex;gap:12px;align-items:end;flex-wrap:wrap}input{max-width:100%;min-width:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.card,.section{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:16px}
.section{overflow-x:auto}.muted{color:var(--muted)}.value{font-size:21px;font-weight:bold}.danger,#error{color:#ff8983}#notice{color:#71d898}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--border);white-space:nowrap}th{color:var(--muted)}
[hidden]{display:none!important}pre{white-space:pre-wrap;overflow-wrap:anywhere}.hint{max-width:900px}a{color:#58a6ff}
@media(max-width:600px){header,main,nav{padding:12px}nav button{flex:1 0 40%}form label{width:100%}form input,form select{width:100%}h1{font-size:17px}.grid{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<header><h1>⚡ Pump.fun Sniper <span id="mode" class="badge">…</span> <span id="operation" class="badge">…</span></h1>
<form id="authForm"><label>Chave da API (somente nesta sessão)<input id="apiKey" type="password" autocomplete="off"></label><button>Conectar</button><button type="button" id="forgetKey">Esquecer chave</button></form></header>
<nav role="tablist" aria-label="Áreas do painel">
<button id="tab-sniper" role="tab" aria-selected="true" aria-controls="panel-sniper" data-tab="sniper">Sniper</button>
<button id="tab-copy" role="tab" aria-selected="false" aria-controls="panel-copy" data-tab="copy" tabindex="-1">Copy Trade</button>
<button id="tab-wallet" role="tab" aria-selected="false" aria-controls="panel-wallet" data-tab="wallet" tabindex="-1">Carteira</button>
<button id="tab-settings" role="tab" aria-selected="false" aria-controls="panel-settings" data-tab="settings" tabindex="-1">Configurações</button>
</nav>
<main>
<p id="error" role="alert"></p><p id="notice" role="status"></p>
<div class="grid" id="cards"></div>
<section id="panel-sniper" role="tabpanel" aria-labelledby="tab-sniper">
<div class="section"><h2>Sniper</h2><p>Compra automática de novos tokens. Apenas um modo operacional pode ficar ativo por vez.</p>
<div class="controls"><button id="startSniper">Iniciar Sniper</button><button id="stopSniper">Pausar Sniper</button></div>
<p class="muted">Pausar não vende posições. Saídas de proteção podem continuar. Liquidar é uma ação separada.</p></div>
<div class="section"><h2>Tokens recentes</h2><table id="tokensTable"></table></div>
</section>
<section id="panel-copy" role="tabpanel" aria-labelledby="tab-copy" hidden>
<div class="section"><h2>Copy Trade</h2><p>Replica sinais da carteira acompanhada dentro dos limites configurados. Trocar abas nunca inicia ou pausa operações.</p>
<form id="copyForm">
<label>Endereço Solana acompanhado<input id="followedAddress" required maxlength="44" autocomplete="off"></label>
<label>Dimensionamento<select id="sizing"><option value="fixed">Fixo</option><option value="proportional">Proporcional com teto</option></select></label>
<label>Execução<select id="copyExecution"><option value="paper">PAPER — simulação</option><option value="live" disabled>LIVE — indisponível, sem execução verificada</option></select></label>
<label>Compra fixa (SOL)<input id="fixedSol" type="number" min="0.000001" max="10" step="0.000001" value="0.01" required></label>
<label>Fração proporcional (0–1)<input id="proportion" type="number" min="0.0001" max="1" step="0.0001" value="0.1" required></label>
<label>Teto por compra (SOL)<input id="capSol" type="number" min="0.000001" max="10" step="0.000001" value="0.05" required></label>
<label>Máximo de posições<input id="maxCopyPositions" type="number" min="1" max="100" step="1" value="3" required></label>
<label>Exposição máxima (SOL)<input id="maxExposure" type="number" min="0.000001" max="100" step="0.000001" value="0.15" required></label>
<label>Gasto diário máximo (SOL)<input id="maxDailySpend" type="number" min="0.000001" max="100" step="0.000001" value="0.5" required></label>
<label>Idade máxima do sinal (segundos)<input id="maxSignalAge" type="number" min="1" max="300" value="30" required></label>
<label>Copiar vendas fracionárias<input id="copySells" type="checkbox" checked></label>
<button>Salvar configuração</button></form>
<p class="muted">0,1 = 10%. A fração de venda (0–1) acompanha a redução da posição na carteira de origem. Sinais repetidos não devem produzir novas compras. Sinais e execuções são distintos.</p>
<div class="controls"><button id="startCopy">Iniciar Copy Trade</button><button id="stopCopy">Pausar Copy Trade</button></div></div>
</section>
<section id="panel-wallet" role="tabpanel" aria-labelledby="tab-wallet" hidden>
<div class="section"><h2>Carteira local protegida</h2><p id="walletStatus">Indisponível</p>
<p class="hint">A senha fica somente em memória durante a solicitação. A chave privada nunca aparece no painel. Criar não importa uma chave e não envia SOL.</p>
<form id="walletForm"><label>Senha da carteira<input id="walletPassword" type="password" minlength="12" maxlength="256" autocomplete="off" required></label>
<button id="createWallet" type="button">Criar carteira</button><button id="unlockWallet" type="button">Desbloquear</button><button id="lockWallet" type="button">Bloquear</button></form>
<h3>Exportação sensível</h3><p class="danger">O JSON exportado contém a chave privada. Qualquer pessoa com esse arquivo controla seus fundos. Guarde offline; nunca compartilhe.</p>
<button id="exportWallet">Reautenticar e exportar JSON</button></div>
<div class="section"><h2>Carteira externa (navegador)</h2><p>Conexão para leitura de endereço. Assinatura manual depende de suporte explícito; nenhuma negociação automática usa carteiras externas. Não solicitamos assinaturas arbitrárias.</p>
<label>Carteiras descobertas<select id="externalWallet"></select></label><button id="discoverWallets">Atualizar descoberta</button><button id="connectExternal">Conectar para leitura</button><p id="externalStatus">Não conectada — somente leitura</p></div>
</section>
<section id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" hidden>
<div class="section"><h2>Configurações do servidor</h2><p>RPC e Jupiter são configurados por variáveis de ambiente no servidor. URLs e credenciais não são retornadas ao navegador. A chave da API é obrigatória para controles.</p><pre id="configView"></pre></div>
</section>
<div class="section"><h2>Posições — todos os modos</h2><table id="positionsTable"></table><p>Venda manual exige confirmação. PAPER é simulação; LIVE usa fundos reais.</p><button id="liquidate" class="danger">Liquidar posições (ação separada)</button></div>
<div class="section"><h2>Histórico — todos os modos</h2><table id="tradesTable"></table></div>
<div class="section"><h2>Eventos e tempo de execução</h2><table id="logsTable"></table></div>
</main><script src="/dashboard.js"></script>
</body></html>`;

export const DASHBOARD_JS = `(() => {
'use strict';
const $ = id => document.getElementById(id);
let apiKey = '', activeMode = 'idle', activePaused = true, busy = false, refreshing = false;
const wallets = [];
const walletListeners = { register: new Set(), unregister: new Set() };
const walletApi = {
 register: (...items) => {
  const added = items.filter(w => w && Array.isArray(w.chains) && w.chains.some(c => typeof c === 'string' && c.startsWith('solana:')) && !wallets.includes(w)).slice(0, Math.max(0,20-wallets.length));
  wallets.push(...added); walletListeners.register.forEach(fn => fn(...added));
  return () => { added.forEach(w => { const i=wallets.indexOf(w); if(i >= 0) wallets.splice(i,1); }); walletListeners.unregister.forEach(fn => fn(...added)); };
 },
 get: () => wallets.slice(),
 on: (event, fn) => { const listeners=walletListeners[event]; if(!listeners || typeof fn !== 'function') return () => {}; listeners.add(fn); return () => listeners.delete(fn); }
};
window.addEventListener('wallet-standard:register-wallet', event => { if (typeof event.detail === 'function') event.detail(walletApi); });
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: walletApi }));
const fmt = (n, d = 4) => n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(d);
const short = s => s ? String(s).slice(0, 6) + '…' + String(s).slice(-4) : '—';
const time = ts => ts ? new Date(ts).toLocaleString('pt-BR') : '—';
async function api(path, method = 'GET', body) {
 const headers = apiKey ? { 'x-api-key': apiKey } : {};
 if (body !== undefined) headers['Content-Type'] = 'application/json';
 const res = await fetch('/api' + path, { method, headers, cache: 'no-store', credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
 const data = await res.json().catch(() => ({}));
 if (!res.ok) throw new Error(data.error || 'Solicitação recusada (' + res.status + ')');
 return data;
}
function table(id, columns, rows, render) {
 const target = $(id), head = document.createElement('tr');
 columns.forEach(c => { const th = document.createElement('th'); th.textContent = c; head.append(th); });
 target.replaceChildren(head);
 if (!rows.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns.length; td.textContent = 'Nenhum registro'; row.append(td); target.append(row); }
 rows.forEach(item => { const row = document.createElement('tr'); render(item).forEach(value => { const td = document.createElement('td'); if (value instanceof Node) td.append(value); else td.textContent = value == null ? '—' : String(value); row.append(td); }); target.append(row); });
}
function card(label, value) { const div = document.createElement('div'), l = document.createElement('div'), v = document.createElement('div'); div.className='card'; l.className='muted'; v.className='value'; l.textContent=label; v.textContent=value; div.append(l,v); return div; }
function selectTab(name) {
 document.querySelectorAll('[data-tab]').forEach(button => { const selected = button.dataset.tab === name; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; $('panel-' + button.dataset.tab).hidden = !selected; });
}
document.querySelectorAll('[data-tab]').forEach((button, index, all) => {
 button.onclick = () => selectTab(button.dataset.tab);
 button.onkeydown = event => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length; all[next].focus(); selectTab(all[next].dataset.tab); };
});
function controls() {
 $('startSniper').disabled = busy || !apiKey || activeMode === 'sniper' && !activePaused;
 $('startCopy').disabled = busy || !apiKey || activeMode === 'copytrade' && !activePaused;
 $('stopSniper').disabled = busy || !apiKey || activeMode !== 'sniper';
 $('stopCopy').disabled = busy || !apiKey || activeMode !== 'copytrade';
}
async function action(message, fn) {
 if (busy || !apiKey) { $('error').textContent = 'Conecte usando a chave da API para controlar.'; return; }
 if (message && !window.confirm(message)) return;
 busy = true; controls(); $('error').textContent = ''; $('notice').textContent = '';
 try { await fn(); $('notice').textContent = 'Solicitação concluída.'; } catch (error) { $('error').textContent = error.message; }
 finally { busy = false; controls(); await refresh(); }
}
const operation = mode => action(mode === 'idle' ? 'Pausar novas entradas? Isso NÃO vende as posições.' : 'Iniciar ' + (mode === 'copytrade' ? 'Copy Trade' : 'Sniper') + '? O outro modo será pausado. Em LIVE há risco de perda real.', () => api('/operation', 'POST', { mode, confirmed: true }));
$('startSniper').onclick = () => operation('sniper'); $('startCopy').onclick = () => operation('copytrade');
$('stopSniper').onclick = () => operation('idle'); $('stopCopy').onclick = () => operation('idle');
$('liquidate').onclick = () => action('LIQUIDAR posições abertas? Isto vende ativos e é diferente de pausar. Em LIVE usa fundos reais.', () => api('/positions/liquidate', 'POST', { confirmed: true }));
$('authForm').onsubmit = event => { event.preventDefault(); apiKey = $('apiKey').value.trim(); $('apiKey').value = ''; controls(); refresh(); metadata(); loadCopy(); };
$('forgetKey').onclick = () => { apiKey = ''; $('apiKey').value = ''; controls(); $('notice').textContent = 'Chave removida da memória.'; refresh(); };
$('copyForm').onsubmit = event => { event.preventDefault(); action('Salvar limites de Copy Trade? Isso habilita a configuração, mas não inicia o modo.', () => api('/copy/settings','PUT', { enabled:true, wallets:[$('followedAddress').value.trim()], execution:$('copyExecution').value, sizing: $('sizing').value, fixedSol: Number($('fixedSol').value), proportionBps: Math.round(Number($('proportion').value)*10000), maxBuySol: Number($('capSol').value), maxOpenPositions:Number($('maxCopyPositions').value), maxExposureSol:Number($('maxExposure').value), maxDailySpendSol:Number($('maxDailySpend').value), maxSignalAgeSeconds:Number($('maxSignalAge').value), copySells:$('copySells').checked })); };
async function loadCopy() {
 try {
  const c=await api('/copy/settings');
  $('followedAddress').value=(c.wallets || [])[0] || ''; $('sizing').value=c.sizing; $('copyExecution').value=c.execution;
  $('fixedSol').value=c.fixedSol; $('proportion').value=c.proportionBps/10000; $('capSol').value=c.maxBuySol; $('copySells').checked=c.copySells;
  $('maxCopyPositions').value=c.maxOpenPositions; $('maxExposure').value=c.maxExposureSol; $('maxDailySpend').value=c.maxDailySpendSol; $('maxSignalAge').value=c.maxSignalAgeSeconds;
 } catch(error) { /* Configuration remains unavailable until authenticated. */ }
}
async function walletAction(path) {
 const password = $('walletPassword').value; $('walletPassword').value = '';
 await action(path === 'create' ? 'Criar uma carteira local criptografada? Guarde sua senha.' : null, () => api('/wallet/' + path, 'POST', path === 'lock' ? {} : { password }));
}
$('createWallet').onclick = () => walletAction('create'); $('unlockWallet').onclick = () => walletAction('unlock'); $('lockWallet').onclick = () => walletAction('lock');
$('walletForm').onsubmit = event => event.preventDefault();
$('exportWallet').onclick = () => {
 const password = $('walletPassword').value; $('walletPassword').value = '';
 action('PERIGO: o JSON contém sua chave privada. Exportar somente para armazenamento seguro offline?', async () => {
  const data = await api('/wallet/export','POST',{ password, confirmed: true });
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type:'application/json' })), a = document.createElement('a');
  a.href=url; a.download='carteira-solana-privada.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
 });
};
function discover() {
 const select = $('externalWallet'); select.replaceChildren();
 wallets.forEach((w,i) => { const o=document.createElement('option'); o.value=String(i); o.textContent=w.name || 'Carteira Solana'; select.append(o); });
 if (window.solana && typeof window.solana.connect === 'function') { const o=document.createElement('option'); o.value='injected'; o.textContent='Provedor Solana injetado'; select.append(o); }
 $('connectExternal').disabled = select.options.length === 0;
}
$('discoverWallets').onclick = discover;
$('connectExternal').onclick = async () => {
 try {
  let address, manual=false;
  if ($('externalWallet').value === 'injected') { const provider=window.solana; await provider.connect(); address=provider.publicKey && provider.publicKey.toString(); manual=typeof provider.signTransaction === 'function'; }
  else { const w=wallets[Number($('externalWallet').value)], connect=w && w.features['standard:connect']; if (!connect) throw new Error('Carteira sem interface de conexão'); const result=await connect.connect(); const account=result.accounts.find(a => a.chains.some(c => c.startsWith('solana:'))); address=account && account.address; manual=Boolean(w.features['solana:signTransaction']); }
  if (!address) throw new Error('Nenhum endereço Solana');
  $('externalStatus').textContent=address + ' — leitura; ' + (manual ? 'assinatura manual disponível no provedor, não habilitada neste painel' : 'sem assinatura') + '; automação proibida';
 } catch(error) { $('externalStatus').textContent='Conexão recusada: ' + error.message; }
};
async function refresh() {
 if (refreshing) return; refreshing=true;
 try {
  const [status, positions, tokens, trades, op, logs] = await Promise.all([api('/status'),api('/positions?limit=50'),api('/tokens?limit=25'),api('/trades?limit=50'),api('/operation'),api('/operation/logs')]);
  activeMode=op.mode; activePaused=op.paused; controls(); $('mode').textContent=status.mode.toUpperCase(); $('operation').textContent=op.paused || activeMode === 'idle' ? 'PAUSADO' : activeMode === 'copytrade' ? 'COPY TRADE ATIVO' : 'SNIPER ATIVO';
  $('cards').replaceChildren(card('Execução',status.mode === 'paper' ? 'PAPER • simulação' : 'LIVE • fundos reais'),card('Saldo SOL',fmt(status.walletBalanceSol,3)),card('Tokens detectados',status.indexer.tokensDetected),card('Latência de detecção',fmt(status.indexer.avgDetectionLatencyMs,0)+' ms'));
  table('positionsTable',['Token','Estado','Modo','Origem','Carteira / sinal','SOL gasto','Valor SOL','PnL %','Aberta em','Ação'],positions.items,p => {
   const button=document.createElement('button'); button.textContent='Vender'; button.disabled=!apiKey || p.status !== 'open';
   button.onclick=() => action('Vender posição ' + short(p.mint) + ' (' + p.mode + ')?',()=>api('/positions/'+encodeURIComponent(p.mint)+'/sell','POST',{confirmed:true}));
   return [p.symbol || short(p.mint),p.status,p.mode,p.origin || 'sniper',short(p.sourceWallet)+' / '+short(p.sourceSignature),fmt(p.solSpent),fmt(p.lastValueSol),fmt(p.pnlPercent,2),time(p.openedAt),button];
  });
  table('tokensTable',['Token','Nome','Endereço','Detectado em'],tokens.items,t => [t.symbol,t.name,short(t.mint),time(t.detectedAt)]);
  table('tradesTable',['Hora','Lado','Token','SOL','Modo','Origem','Sinal / carteira','Resultado','Tempo'],trades.items,t => [time(t.createdAt),t.side,short(t.mint),fmt(t.solAmount),t.mode,t.origin || 'sniper',short(t.sourceWallet)+' / '+short(t.sourceSignature),t.success ? 'OK' : 'Falhou',t.latencyMs == null ? '—' : t.latencyMs+' ms']);
  table('logsTable',['Hora','Modo','Evento','Detalhe','Tempo'],logs.items,l => [time(l.createdAt),l.detail && l.detail.mode,l.event,JSON.stringify(l.detail || {}),l.detail && l.detail.durationMs != null ? l.detail.durationMs+' ms' : '—']);
 } catch(error) { $('error').textContent=error.message; }
 finally { refreshing=false; }
}
async function metadata() {
 try {
  const config=await api('/config');
  let jupiter; try { jupiter=await api('/jupiter/status'); } catch(error) { jupiter={ configured:false,quoteOnly:true,liveExecutionSupported:false }; }
  $('configView').textContent=JSON.stringify({ configuration:config,jupiter },null,2);
 } catch(error) { $('configView').textContent='Configuração protegida ou indisponível.'; }
 try { const w=await api('/wallet/status'); $('walletStatus').textContent=(w.publicKey || 'Sem carteira')+' — '+(w.locked ? 'bloqueada' : 'desbloqueada')+' — '+(w.capability || 'somente leitura')+' — saldo SOL: '+fmt(w.balanceSol,3); } catch(error) { $('walletStatus').textContent='Carteira local indisponível ou protegida.'; }
}
controls(); discover(); refresh(); metadata(); loadCopy(); setInterval(() => { refresh(); metadata(); },5000);
})();`;
