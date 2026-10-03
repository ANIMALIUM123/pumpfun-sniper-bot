/**
 * Minimal, dependency-free status dashboard. Served as static strings so the build stays simple.
 * All dynamic values are inserted with `textContent` (token names/symbols are attacker controlled).
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pump.fun Sniper – Dashboard</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --card:#161b22; --muted:#8b949e; --green:#3fb950; --red:#f85149; --border:#30363d; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:var(--bg); color:#e6edf3; }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; padding:16px 24px; border-bottom:1px solid var(--border); }
  h1 { font-size:18px; margin:0; }
  h2 { font-size:15px; margin:0 0 8px; }
  main { padding:16px 24px; display:grid; gap:16px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:12px; }
  .card .label { color:var(--muted); font-size:12px; }
  .card .value { font-size:20px; font-weight:600; margin-top:4px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); white-space:nowrap; }
  th { color:var(--muted); font-weight:500; }
  .section { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:12px; overflow-x:auto; }
  .pos { color:var(--green); } .neg { color:var(--red); } .muted { color:var(--muted); }
  .badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:12px; border:1px solid var(--border); }
  button { background:#21262d; color:#e6edf3; border:1px solid var(--border); border-radius:6px; padding:4px 10px; cursor:pointer; }
  button:hover { background:#30363d; }
  input { background:#0d1117; color:#e6edf3; border:1px solid var(--border); border-radius:6px; padding:4px 8px; }
  #error { color:var(--red); }
</style>
</head>
<body>
<header>
  <h1>⚡ Pump.fun Sniper <span id="mode" class="badge">…</span> <span id="paused" class="badge">…</span></h1>
  <div>
    <input id="apiKey" type="password" placeholder="API key (optional)" autocomplete="off">
    <button id="saveKey">Save</button>
    <button id="pauseBtn">Pause</button>
    <button id="resumeBtn">Resume</button>
  </div>
</header>
<main>
  <div id="error"></div>
  <div class="cards" id="cards"></div>
  <div class="section"><h2>Open positions</h2><table id="openTable"></table></div>
  <div class="section"><h2>Recent tokens</h2><table id="tokensTable"></table></div>
  <div class="section"><h2>Recent trades</h2><table id="tradesTable"></table></div>
</main>
<script src="/dashboard.js"></script>
</body>
</html>`;

export const DASHBOARD_JS = `(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const keyInput = $('apiKey');
  keyInput.value = localStorage.getItem('sniperApiKey') || '';

  function headers() {
    const key = localStorage.getItem('sniperApiKey');
    return key ? { 'x-api-key': key } : {};
  }
  async function api(path, opts) {
    const res = await fetch('/api' + path, Object.assign({ headers: headers() }, opts || {}));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    return body;
  }
  const fmt = (n, d) => (n === null || n === undefined || Number.isNaN(Number(n))) ? '–' : Number(n).toFixed(d === undefined ? 4 : d);
  const short = (s) => s ? s.slice(0, 4) + '…' + s.slice(-4) : '–';
  const ago = (ts) => { if (!ts) return '–'; const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };

  function cell(text, cls) {
    const td = document.createElement('td');
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }
  function link(text, href) {
    const td = document.createElement('td');
    const a = document.createElement('a');
    a.textContent = text; a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.style.color = '#58a6ff';
    td.appendChild(a);
    return td;
  }
  function fillTable(table, columns, rows, render) {
    table.replaceChildren();
    const head = document.createElement('tr');
    columns.forEach((c) => { const th = document.createElement('th'); th.textContent = c; head.appendChild(th); });
    table.appendChild(head);
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = cell('Nothing yet', 'muted'); td.colSpan = columns.length; tr.appendChild(td);
      table.appendChild(tr);
      return;
    }
    rows.forEach((r) => { const tr = document.createElement('tr'); render(r).forEach((td) => tr.appendChild(td)); table.appendChild(tr); });
  }
  function card(label, value, cls) {
    const div = document.createElement('div'); div.className = 'card';
    const l = document.createElement('div'); l.className = 'label'; l.textContent = label;
    const v = document.createElement('div'); v.className = 'value' + (cls ? ' ' + cls : ''); v.textContent = value;
    div.append(l, v);
    return div;
  }
  const pnlClass = (n) => n > 0 ? 'pos' : n < 0 ? 'neg' : '';

  async function refresh() {
    try {
      const [status, metrics, open, tokens, trades] = await Promise.all([
        api('/status'), api('/metrics'), api('/positions/open'), api('/tokens?limit=25'), api('/trades?limit=25'),
      ]);
      $('error').textContent = '';
      $('mode').textContent = status.mode.toUpperCase();
      $('paused').textContent = status.sniper.paused ? 'PAUSED' : 'AUTO-BUY ON';
      $('cards').replaceChildren(
        card('Uptime', ago(Date.now() - status.uptimeSeconds * 1000)),
        card('Wallet SOL', fmt(status.walletBalanceSol, 3)),
        card('Tokens detected', String(status.indexer.tokensDetected)),
        card('Detection latency', status.indexer.avgDetectionLatencyMs === null ? '–' : Math.round(status.indexer.avgDetectionLatencyMs) + ' ms'),
        card('Open positions', String(status.openPositions)),
        card('Closed trades', String(metrics.closedPositions)),
        card('Win rate', fmt(metrics.winRate, 1) + '%'),
        card('Total PnL (SOL)', fmt(metrics.totalPnlSol, 4), pnlClass(metrics.totalPnlSol)),
      );
      fillTable($('openTable'), ['Token', 'Mint', 'Spent', 'Value', 'PnL %', 'Held', ''], open.items, (p) => {
        const btn = document.createElement('button'); btn.textContent = 'Sell';
        btn.onclick = async () => { btn.disabled = true; try { await api('/positions/' + p.mint + '/sell', { method: 'POST' }); } catch (e) { alert(e.message); } refresh(); };
        const td = document.createElement('td'); td.appendChild(btn);
        return [cell(p.symbol), link(short(p.mint), 'https://pump.fun/coin/' + encodeURIComponent(p.mint)), cell(fmt(p.solSpent)), cell(fmt(p.currentValueSol)),
          cell(fmt(p.unrealizedPnlPercent, 1) + '%', pnlClass(p.unrealizedPnlPercent)), cell(Math.round(p.heldSeconds) + 's'), td];
      });
      fillTable($('tokensTable'), ['Age', 'Symbol', 'Name', 'Mint', 'MCap (SOL)', 'Dev buy (SOL)'], tokens.items, (t) => [
        cell(ago(t.detectedAt)), cell(t.symbol), cell(t.name), link(short(t.mint), 'https://pump.fun/coin/' + encodeURIComponent(t.mint)),
        cell(fmt(t.lastMarketCapSol !== null ? t.lastMarketCapSol : t.initialMarketCapSol, 2)), cell(fmt(t.devBuySol, 3)),
      ]);
      fillTable($('tradesTable'), ['Time', 'Side', 'Mint', 'SOL', 'Mode', 'Status', 'Tx'], trades.items, (t) => [
        cell(new Date(t.createdAt).toLocaleTimeString()), cell(t.side.toUpperCase(), t.side === 'buy' ? 'pos' : 'neg'), cell(short(t.mint)), cell(fmt(t.solAmount)),
        cell(t.mode), cell(t.success ? 'ok' : (t.error || 'failed'), t.success ? '' : 'neg'),
        t.signature && t.mode === 'live' ? link(short(t.signature), 'https://solscan.io/tx/' + encodeURIComponent(t.signature)) : cell('–', 'muted'),
      ]);
    } catch (e) {
      $('error').textContent = 'Error: ' + e.message;
    }
  }

  $('saveKey').onclick = () => { localStorage.setItem('sniperApiKey', keyInput.value.trim()); refresh(); };
  $('pauseBtn').onclick = () => api('/bot/pause', { method: 'POST' }).then(refresh).catch((e) => alert(e.message));
  $('resumeBtn').onclick = () => api('/bot/resume', { method: 'POST' }).then(refresh).catch((e) => alert(e.message));
  refresh();
  setInterval(refresh, 3000);
})();
`;
