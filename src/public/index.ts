import { escapeHtml } from './util.ts'

export interface IndexContext {
  token: string | null
  publicUrl: string
  relayUrl: string | null
  tunnel: string
  tokenGenerated: boolean
}

const STYLE = `
:root {
  --bg: #0a0c0f; --panel: #0f1216; --panel-2: #141922; --line: #1e2632;
  --fg: #d7e0ea; --dim: #7d8b9c; --faint: #4a5766;
  --green: #4ade80; --amber: #fbbf24; --red: #f87171; --blue: #60a5fa;
  --purple: #c084fc; --cyan: #22d3ee;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg); color: var(--fg); font-family: var(--mono);
  font-size: 13px; line-height: 1.5; -webkit-font-smoothing: antialiased;
}
a { color: var(--blue); text-decoration: none; }
button, input, select { font: inherit; color: inherit; }
.row { display: flex; align-items: center; gap: 8px; }

header {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 10px 14px; border-bottom: 1px solid var(--line); background: var(--panel);
  position: sticky; top: 0; z-index: 5;
}
.brand { font-weight: 700; letter-spacing: -0.5px; display: flex; align-items: center; gap: 7px; }
.brand .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); }
.brand .dot.off { background: var(--faint); box-shadow: none; }
.url {
  display: flex; align-items: center; gap: 6px; background: var(--panel-2);
  border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; max-width: 46ch;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.url .label { color: var(--faint); }
.url .value { color: var(--cyan); }
.spacer { flex: 1; }
.stat { color: var(--dim); white-space: nowrap; }
.stat b { color: var(--fg); font-weight: 600; }
.stat b.warn { color: var(--red); }

button.ghost {
  background: var(--panel-2); border: 1px solid var(--line); color: var(--dim);
  border-radius: 6px; padding: 3px 9px; cursor: pointer;
}
button.ghost:hover { color: var(--fg); border-color: #2c3849; }
button.ghost[aria-pressed="true"] { color: var(--amber); border-color: #3a2f14; background: #1a1509; }

.toolbar {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  padding: 8px 14px; border-bottom: 1px solid var(--line); background: var(--bg);
}
.toolbar input[type="search"], .toolbar select {
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  padding: 4px 9px; outline: none;
}
.toolbar input[type="search"] { min-width: 260px; flex: 1; max-width: 460px; }
.toolbar input[type="search"]:focus, .toolbar select:focus { border-color: #2f3d4f; }
.hint { color: var(--faint); }

main { display: grid; grid-template-columns: minmax(340px, 1fr) 1.4fr; height: calc(100vh - 96px); }
#list { overflow-y: auto; border-right: 1px solid var(--line); }
#detail { overflow-y: auto; padding: 14px 16px; }

.item {
  display: grid; grid-template-columns: 62px 54px 1fr auto; gap: 8px; align-items: center;
  padding: 6px 12px; border-bottom: 1px solid #131a24; cursor: pointer;
}
.item:hover { background: var(--panel); }
.item.sel { background: var(--panel-2); box-shadow: inset 2px 0 0 var(--cyan); }
.item .t { color: var(--faint); font-variant-numeric: tabular-nums; }
.item .type { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .meta { color: var(--faint); font-size: 11px; white-space: nowrap; }
.badge {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px;
  padding: 1px 5px; border-radius: 4px; border: 1px solid var(--line); color: var(--dim);
}
.badge.stripe { color: var(--purple); border-color: #3d2b57; }
.badge.github { color: var(--fg); border-color: #33415a; }
.badge.slack { color: var(--amber); border-color: #4a3a12; }
.badge.svix { color: var(--cyan); border-color: #12414a; }
.badge.shopify { color: var(--green); border-color: #14432a; }
.badge.twilio { color: var(--red); border-color: #4a1f1f; }
.v-valid { color: var(--green); }
.v-invalid { color: var(--red); }
.v-stale { color: var(--amber); }
.v-unverified { color: var(--faint); }
.tag-dup { color: var(--amber); font-size: 11px; }
.tag-replay { color: var(--blue); font-size: 11px; }

.tabs { display: flex; gap: 4px; margin-bottom: 12px; }
.tabs button {
  background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--dim); padding: 4px 8px; cursor: pointer;
}
.tabs button[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--cyan); }
pre {
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px; overflow: auto; margin: 0; font-size: 12.5px; tab-size: 2;
}
.k { color: var(--cyan); }
.s { color: var(--green); }
.n { color: var(--amber); }
.b { color: var(--purple); }
.meta-grid {
  display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin-bottom: 14px;
}
.meta-grid dt { color: var(--faint); }
.meta-grid dd { margin: 0; overflow-wrap: anywhere; }
.empty { color: var(--faint); padding: 40px 20px; text-align: center; }
.kbd {
  border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px;
  padding: 0 4px; background: var(--panel-2); color: var(--dim);
}
#toast {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
  padding: 7px 14px; opacity: 0; transition: opacity 0.15s; pointer-events: none;
}
#toast.show { opacity: 1; }
@media (max-width: 860px) { main { grid-template-columns: 1fr; height: auto; } #list { border-right: none; } }
`

const SCRIPT = String.raw`
const TOKEN = __TOKEN__;
const PUBLIC_URL = __PUBLIC_URL__;
const state = { events: [], sel: null, tab: 'body', q: '', provider: '', dup: false, invalid: false };

const $ = (sel) => document.querySelector(sel);
const api = (path) => {
  const url = new URL('/_hookline' + path, location.origin);
  return fetch(url, { headers: TOKEN ? { 'x-hookline-token': TOKEN } : {} }).then((r) => r.json());
};
const post = (path) => fetch(new URL('/_hookline' + path, location.origin), {
  method: 'POST', headers: TOKEN ? { 'x-hookline-token': TOKEN } : {} },
).then((r) => r.json());

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
function bytes(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
  return (n / 1024 / 1024).toFixed(1) + 'M';
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function highlight(text) {
  return esc(text).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'n';
      if (/^"/.test(match)) cls = /:$/.test(match) ? 'k' : 's';
      else if (/true|false|null/.test(match)) cls = 'b';
      return '<span class="' + cls + '">' + match + '</span>';
    },
  );
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1400);
}
async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast('copied ' + (label || ''));
  } catch {
    toast('clipboard blocked — select manually');
  }
}
function query() {
  const p = new URLSearchParams();
  p.set('limit', '100');
  if (state.q) p.set('q', state.q);
  if (state.provider) p.set('provider', state.provider);
  if (state.dup) p.set('dup', '1');
  if (state.invalid) p.set('invalid', '1');
  return p.toString();
}
async function load() {
  const [list, stats] = await Promise.all([api('/api/events?' + query()), api('/api/stats')]);
  state.events = list.events;
  render();
  const total = $('#s-total'), inv = $('#s-invalid'), dup = $('#s-dupes');
  total.textContent = stats.total;
  inv.textContent = stats.invalid;
  inv.className = stats.invalid > 0 ? 'warn' : '';
  dup.textContent = stats.duplicates;
  $('#s-live').textContent = stats.lastEventAt ? ago(Date.now() - stats.lastEventAt) + ' ago' : '—';
}
function render() {
  const list = $('#list');
  if (state.events.length === 0) {
    list.innerHTML = '<div class="empty">no events yet<br><span class="hint">point a provider at ' +
      esc(PUBLIC_URL) + '</span></div>';
    $('#detail').innerHTML = '<div class="empty">select an event</div>';
    return;
  }
  list.innerHTML = state.events.map((e) => {
    const marks = (e.duplicateOf ? '<span class="tag-dup">dup</span> ' : '') +
      (e.replayOf ? '<span class="tag-replay">replay</span>' : '');
    return '<div class="item' + (state.sel === e.id ? ' sel' : '') + '" data-id="' + e.id + '">' +
      '<span class="t">' + ago(Date.now() - e.receivedAt) + '</span>' +
      '<span class="badge ' + e.provider + '">' + e.provider.slice(0, 7) + '</span>' +
      '<span class="type">' + esc(e.eventType || e.path) + ' ' + marks + '</span>' +
      '<span class="meta v-' + e.verdict + '">' + e.verdict.slice(0, 4) + ' · ' + bytes(e.size) + '</span>' +
      '</div>';
  }).join('');
}
function renderDetail() {
  const e = state.events.find((x) => x.id === state.sel);
  if (!e) {
    $('#detail').innerHTML = '<div class="empty">select an event</div>';
    return;
  }
  const tabs = ['body', 'headers', 'curl', 'share'];
  const head = '<div class="tabs">' + tabs.map((t) =>
    '<button data-tab="' + t + '" aria-selected="' + (state.tab === t) + '">' + t + '</button>').join('') +
    '</div>';
  const meta = '<dl class="meta-grid">' +
    '<dt>id</dt><dd>' + e.id + '</dd>' +
    '<dt>received</dt><dd>' + new Date(e.receivedAt).toISOString() + ' (' + ago(Date.now() - e.receivedAt) + ' ago)</dd>' +
    '<dt>provider</dt><dd>' + e.provider + '</dd>' +
    '<dt>event</dt><dd>' + esc(e.eventType || '—') + '</dd>' +
    '<dt>signature</dt><dd class="v-' + e.verdict + '">' + e.verdict + ' <span class="hint">' + e.signatureScheme + '</span></dd>' +
    (e.signatureError ? '<dt>why</dt><dd>' + esc(e.signatureError) + '</dd>' : '') +
    (e.duplicateOf ? '<dt>duplicate of</dt><dd>' + e.duplicateOf + '</dd>' : '') +
    (e.replayOf ? '<dt>replay of</dt><dd>' + e.replayOf + '</dd>' : '') +
    (e.note ? '<dt>note</dt><dd>' + esc(e.note) + '</dd>' : '') +
    '<dt>request</dt><dd>' + e.method + ' ' + esc(e.path) + (e.query ? '?' + esc(e.query) : '') + '</dd>' +
    '<dt>size</dt><dd>' + bytes(e.size) + '</dd>' +
    '<dt>from</dt><dd>' + esc(e.remoteAddr || '—') + '</dd>' +
    '</dl>';
  const actions = '<div class="row" style="margin:0 0 12px">' +
    '<button class="ghost" id="replay">replay</button>' +
    '<button class="ghost" id="chaos">chaos…</button>' +
    '<button class="ghost" id="copycurl">copy curl</button>' +
    '<span class="hint"><span class="kbd">j</span><span class="kbd">k</span> move · ' +
    '<span class="kbd">r</span> replay · <span class="kbd">c</span> curl · <span class="kbd">/</span> search</span>' +
    '</div>';
  let body = '';
  if (state.tab === 'body') {
    body = '<pre>' + (e.pretty ? highlight(e.pretty) : highlight(e.body || '(empty body)')) + '</pre>';
  } else if (state.tab === 'headers') {
    const rows = Object.entries(e.headers).sort().map(([k, v]) =>
      '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('');
    body = '<pre>' + highlight(JSON.stringify(e.headers, null, 2)) + '</pre>';
  } else if (state.tab === 'curl') {
    body = '<pre id="curl">' + esc(e.curl || 'loading…') + '</pre>';
  } else {
    const link = location.origin + '/_hookline/p/' + e.id;
    body = '<p>Public, unlisted link to this exact event. <b>Anyone with the link sees the full body</b> — signature headers are stripped unless you also send the token.</p>' +
      '<pre>' + esc(link) + '\n\n' + esc(link + '.json') + '</pre>' +
      '<div class="row" style="margin-top:10px">' +
      '<button class="ghost" id="copylink">copy link</button>' +
      '<button class="ghost" id="copyjson">copy .json</button></div>';
  }
  $('#detail').innerHTML = meta + actions + head + body;
  $('#replay').onclick = () => doReplay(null);
  $('#chaos').onclick = () => doReplay(prompt('chaos mode: strip, truncate, mutate, corrupt, delay') || '');
  $('#copycurl').onclick = () => copy(e.curl || '', 'curl');
  if ($('#copylink')) $('#copylink').onclick = () => copy(location.origin + '/_hookline/p/' + e.id, 'link');
  if ($('#copyjson')) $('#copyjson').onclick = () => copy(location.origin + '/_hookline/p/' + e.id + '.json', 'json url');
  for (const b of document.querySelectorAll('.tabs button')) {
    b.onclick = () => { state.tab = b.dataset.tab; renderDetail(); };
  }
}
async function doReplay(chaos) {
  if (!state.sel) return;
  const path = '/api/events/' + state.sel + '/replay' + (chaos ? '?chaos=' + chaos : '');
  const r = await post(path);
  if (r.ok) { toast('replayed' + (r.chaos !== 'none' ? ' · chaos: ' + r.chaos : '')); load(); }
  else toast(r.error || 'replay failed');
}
function select(id) {
  state.sel = id;
  const e = state.events.find((x) => x.id === id);
  if (e) { e.curl = e.curl || ''; }
  render();
  renderDetail();
  if (e) {
    api('/api/events/' + id + '/curl').then((r) => {
      const target = state.events.find((x) => x.id === id);
      if (target) { target.curl = r.curl; if (state.sel === id && state.tab === 'curl') renderDetail(); }
    });
  }
}
$('#list').addEventListener('click', (ev) => {
  const item = ev.target.closest('.item');
  if (item) select(item.dataset.id);
});
let timer;
$('#q').addEventListener('input', (ev) => {
  state.q = ev.target.value;
  clearTimeout(timer);
  timer = setTimeout(load, 120);
});
$('#provider').addEventListener('change', (ev) => { state.provider = ev.target.value; load(); });
$('#dup').addEventListener('click', (ev) => {
  state.dup = !state.dup;
  ev.currentTarget.setAttribute('aria-pressed', String(state.dup));
  load();
});
$('#invalid').addEventListener('click', (ev) => {
  state.invalid = !state.invalid;
  ev.currentTarget.setAttribute('aria-pressed', String(state.invalid));
  load();
});
$('#refresh').addEventListener('click', load);
$('#copypublic').addEventListener('click', () => copy(PUBLIC_URL, 'url'));
document.addEventListener('keydown', (ev) => {
  const typing = ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT';
  if (ev.key === '/' && !typing) { ev.preventDefault(); $('#q').focus(); return; }
  if (ev.key === 'Escape') { $('#q').blur(); return; }
  if (typing) return;
  const index = state.events.findIndex((e) => e.id === state.sel);
  if (ev.key === 'j' || ev.key === 'k') {
    ev.preventDefault();
    const next = Math.max(0, Math.min(state.events.length - 1, index + (ev.key === 'j' ? 1 : -1)));
    const target = state.events[next];
    if (target) { select(target.id); $('#list').children[next].scrollIntoView({ block: 'nearest' }); }
    return;
  }
  if (ev.key === 'r') doReplay(null);
  if (ev.key === 'c') { const e = state.events.find((x) => x.id === state.sel); if (e?.curl) copy(e.curl, 'curl'); }
  if (ev.key === '1' || ev.key === '2' || ev.key === '3' || ev.key === '4') {
    state.tab = ['body', 'headers', 'curl', 'share'][Number(ev.key) - 1];
    renderDetail();
  }
});
function stream() {
  const url = new URL('/_hookline/api/stream', location.origin);
  if (TOKEN) url.searchParams.set('t', TOKEN);
  const es = new EventSource(url);
  es.addEventListener('event', (msg) => {
    const e = JSON.parse(msg.data);
    state.events.unshift(e);
    if (state.events.length > 200) state.events.pop();
    render();
    if (state.sel) renderDetail();
  });
  es.onopen = () => $('#live').classList.remove('off');
  es.onerror = () => $('#live').classList.add('off');
}
stream();
load();
setInterval(() => render(), 5000);
`

export function renderIndex(context: IndexContext): string {
  const token = context.token ?? ''
  const script = SCRIPT.replace('__TOKEN__', JSON.stringify(token)).replace(
    '__PUBLIC_URL__',
    JSON.stringify(context.publicUrl),
  )
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>hookline</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <span class="brand"><span class="dot" id="live"></span> hookline</span>
  <span class="url" title="click to copy">
    <span class="label">public</span>
    <span class="value" id="pub">${escapeHtml(context.publicUrl)}</span>
    <button class="ghost" id="copypublic">copy</button>
  </span>
  <span class="spacer"></span>
  <span class="stat">last <b id="s-live">—</b></span>
  <span class="stat">events <b id="s-total">0</b></span>
  <span class="stat">invalid <b id="s-invalid">0</b></span>
  <span class="stat">dupes <b id="s-dupes">0</b></span>
</header>
<div class="toolbar">
  <input type="search" id="q" placeholder="search bodies, paths, headers…  ( / )" autocomplete="off">
  <select id="provider">
    <option value="">all providers</option>
    <option value="stripe">stripe</option>
    <option value="github">github</option>
    <option value="slack">slack</option>
    <option value="svix">svix</option>
    <option value="shopify">shopify</option>
    <option value="twilio">twilio</option>
    <option value="generic">generic</option>
    <option value="unknown">unknown</option>
  </select>
  <button class="ghost" id="dup" aria-pressed="false">duplicates only</button>
  <button class="ghost" id="invalid" aria-pressed="false">invalid signatures only</button>
  <button class="ghost" id="refresh">refresh</button>
</div>
<main>
  <div id="list"><div class="empty">loading…</div></div>
  <div id="detail"><div class="empty">select an event</div></div>
</main>
<div id="toast"></div>
<script>${script}</script>
</body>
</html>`
}

export function renderShare(
  event: {
    id: string
    receivedAt: number
    provider: string
    eventType: string
    verdict: string
    method: string
    path: string
    query: string
    size: number
    signatureScheme: string
    signatureError: string | null
    body: string
    pretty: string | null
    headers: Record<string, string>
  },
  context: { curl: string; redacted?: number },
): string {
  const body = event.pretty ?? event.body
  const redacted = context.redacted ?? 0
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(event.provider)} · ${escapeHtml(event.eventType || event.path)} · hookline</title>
<style>${STYLE}
main { display: block; height: auto; max-width: 1000px; margin: 0 auto; padding: 20px 14px 60px; }
h1 { font-size: 15px; margin: 0 0 4px; }
.sharebar { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0 18px; }
</style>
</head>
<body>
<main>
  <h1><span class="badge ${escapeHtml(event.provider)}">${escapeHtml(event.provider)}</span>
    ${escapeHtml(event.eventType || event.path)}
    <span class="v-${escapeHtml(event.verdict)}">· ${escapeHtml(event.verdict)}</span></h1>
  <div class="hint">${escapeHtml(event.method)} ${escapeHtml(event.path)}${event.query ? '?' + escapeHtml(event.query) : ''}
    · ${new Date(event.receivedAt).toISOString()} · ${event.size} bytes
    · signature: ${escapeHtml(event.signatureScheme)}${event.signatureError ? ' — ' + escapeHtml(event.signatureError) : ''}</div>
  ${
    redacted > 0
      ? `<div class="hint" style="color:#fbbf24">${redacted} signature header(s) hidden on this public page — add <code>?raw=1</code> and the inbox token to reveal them.</div>`
      : ''
  }
  <div class="sharebar">
    <button class="ghost" id="copycurl">copy curl</button>
    <button class="ghost" id="copybody">copy body</button>
    <a class="ghost" href="?format=json">raw json</a>
  </div>
  <div class="tabs">
    <button aria-selected="true">body</button>
    <button aria-selected="false">headers</button>
    <button aria-selected="false">curl</button>
  </div>
  <pre id="pane">${escapeHtml(body || '(empty body)')}</pre>
</main>
<div id="toast"></div>
<script>
const panes = { body: ${JSON.stringify(body || '(empty body)')}, headers: ${JSON.stringify(JSON.stringify(event.headers, null, 2))}, curl: ${JSON.stringify(context.curl)} };
const keys = ['body', 'headers', 'curl'];
document.querySelectorAll('.tabs button').forEach((b, i) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', 'false'));
    b.setAttribute('aria-selected', 'true');
    document.getElementById('pane').textContent = panes[keys[i]];
  };
});
const toast = (m) => { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1400); };
const copy = async (text, label) => { try { await navigator.clipboard.writeText(text); toast('copied ' + label); } catch { toast('clipboard blocked'); } };
document.getElementById('copycurl').onclick = () => copy(panes.curl, 'curl');
document.getElementById('copybody').onclick = () => copy(panes.body, 'body');
</script>
</body>
</html>`
}

export function renderNotFound(): string {
  return `<!doctype html><meta charset="utf-8"><title>not found</title>
<style>${STYLE}</style>
<body><div class="empty" style="padding-top:80px">no such event<br>
<span class="hint">it may have been purged by retention</span></div></body>`
}
