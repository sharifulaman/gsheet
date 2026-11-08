// Truck Lagbe – Shifting Requests live table + Google Sheets sync (zero dependencies, Node 18+)
// Run:  node server.js   →   http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

// Minimal .env loader
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const PORT = Number(process.env.PORT) || 3000;
const COOKIE = process.env.COOKIE || '';
const SHEET_WEBHOOK = process.env.SHEET_WEBHOOK || '';
const SHEET_SECRET = process.env.SHEET_SECRET || '';
const BACKFILL = /^(1|true|yes)$/i.test(process.env.BACKFILL || '');
const SYNC_SECONDS = 60;
const PAGE_SIZE = 20;

const BASE = 'https://trucklagbe.com';
const ENDPOINT = BASE + '/wp-admin/admin-ajax.php';
const PASSTHROUGH = ['period', 'status', 's', 'start_date', 'end_date', 'paged'];

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// ---------- upstream table API ----------
async function fetchTable(params) {
  const qs = new URLSearchParams({ action: 'tl_get_shifting_requests_table', ...params });
  const r = await fetch(`${ENDPOINT}?${qs}`, {
    headers: {
      Cookie: COOKIE,
      Referer: `${BASE}/shifting-request/`,
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (shifting-live-table)',
    },
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!json || !json.success || !json.data) {
    const err = new Error('Upstream did not return table data. The PIN session has probably expired – unlock the page again and update COOKIE in .env.');
    err.status = r.status;
    throw err;
  }
  return json;
}

async function handleApi(url, res) {
  if (!COOKIE) {
    return send(res, 500, { error: 'COOKIE is not set. Copy .env.example to .env and paste your unlocked-session cookie.' });
  }
  const params = {};
  for (const k of PASSTHROUGH) {
    const v = url.searchParams.get(k);
    if (v) params[k] = v;
  }
  try {
    return send(res, 200, await fetchTable(params));
  } catch (e) {
    const code = e.status ? 502 : 504;
    return send(res, code, { error: e.status ? e.message : 'Could not reach trucklagbe.com: ' + e.message, status: e.status });
  }
}

// ---------- HTML rows → plain objects ----------
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
const text = h => decode(h.replace(/<[^>]*>/g, ' ')).replace(/[\u{1F4DE}\u{1F4C5}]/gu, '').replace(/\s+/g, ' ').trim();

function parseRows(html) {
  const rows = [];
  const re = /<tr[^>]*data-row-id="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(html || ''))) {
    const tds = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => x[1]);
    const t = i => text(tds[i] || '');
    const sel = (tds[8] || '').match(/<option[^>]*value="(\w+)"[^>]*selected/);
    const email = t(4);
    rows.push({
      id: Number(m[1]), name: t(2), phone: t(3), email: email === '—' ? '' : email,
      date: t(5), pickup: t(6), drop: t(7),
      status: sel ? sel[1] : t(8).toLowerCase(), submitted: t(9),
    });
  }
  return rows;
}

// ---------- Google Sheets sync ----------
const sent = new Map();           // id -> status we last pushed
const syncInfo = { last: null, ok: null, message: 'not run yet' };

async function pushToSheet(rows) {
  const r = await fetch(SHEET_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: SHEET_SECRET, rows }),
    redirect: 'follow',
    signal: AbortSignal.timeout(60000),
  });
  const body = await r.text();
  let json = null;
  try { json = JSON.parse(body); } catch {}
  if (!json || !json.ok) throw new Error('Sheet webhook error: ' + (json?.error || body.slice(0, 160)));
  return json;
}

let firstRun = true;
async function syncOnce() {
  if (!SHEET_WEBHOOK || !COOKIE) return;
  try {
    const first = await fetchTable({ period: 'all' });
    let rows = parseRows(first.data.rows_html);

    if (firstRun && BACKFILL) {
      const pages = Math.ceil(Number(first.data.total_items || 0) / PAGE_SIZE);
      for (let p = 2; p <= pages; p++) {
        rows = rows.concat(parseRows((await fetchTable({ period: 'all', paged: String(p) })).data.rows_html));
      }
      console.log(`[sync] backfill: ${rows.length} rows across ${pages} pages`);
    }
    firstRun = false;

    const changed = rows.filter(r => sent.get(r.id) !== r.status).sort((a, b) => a.id - b.id);
    if (!changed.length) { syncInfo.message = 'nothing new'; syncInfo.ok = true; syncInfo.last = new Date(); return; }

    let added = 0, updated = 0;
    for (let i = 0; i < changed.length; i += 200) {
      const res = await pushToSheet(changed.slice(i, i + 200));
      added += res.added || 0; updated += res.updated || 0;
    }
    changed.forEach(r => sent.set(r.id, r.status));
    syncInfo.ok = true; syncInfo.last = new Date();
    syncInfo.message = `${added} added, ${updated} updated`;
    console.log(`[sync] ${new Date().toLocaleTimeString()} → ${syncInfo.message}`);
  } catch (e) {
    syncInfo.ok = false; syncInfo.last = new Date(); syncInfo.message = e.message;
    console.error('[sync] failed:', e.message);
  }
}

// ---------- server ----------
if (require.main === module) {
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/requests') return handleApi(url, res);
    if (url.pathname === '/api/sync-status') return send(res, 200, { enabled: !!SHEET_WEBHOOK, ...syncInfo });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    send(res, 404, { error: 'Not found' });
  }).listen(PORT, () => {
    console.log(`Live table running → http://localhost:${PORT}`);
    if (!COOKIE) console.log('⚠  COOKIE is empty – create .env (see .env.example)');
    if (SHEET_WEBHOOK) {
      console.log(`Google Sheets sync ON (every ${SYNC_SECONDS}s${BACKFILL ? ', backfilling all history on first run' : ''})`);
      syncOnce();
      setInterval(syncOnce, SYNC_SECONDS * 1000);
    } else {
      console.log('Google Sheets sync OFF – set SHEET_WEBHOOK in .env to enable');
    }
  });
}

module.exports = { parseRows };
