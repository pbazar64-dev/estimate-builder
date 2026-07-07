'use strict';
// Конструктор смет, КП и договоров для Битрикс24 — бэкенд без внешних зависимостей.
// Слушает порт 3000 (требование платформы Vibecode).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { seedStore, defaultStages, nid } = require('./seed');
const { recalc } = require('./calc');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'store.json');

// ---------- Хранилище (in-memory + best-effort persist на диск) ----------
let store;
try {
  if (fs.existsSync(DATA_FILE)) {
    store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
} catch (e) { /* ignore */ }
if (!store) store = seedStore();

function persist() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(store));
  } catch (e) { /* read-only fs — работаем из памяти */ }
}

const findEstimate = (id) => store.estimates.find((e) => e.id === id);
const country = (id) => store.countries.find((c) => c.id === id);

// ---------- Утилиты HTTP ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  const filePath = path.normalize(path.join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA fallback → index.html
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(idx);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- Обогащение сметы вычислениями ----------
function estimateSummary(e) {
  const rate = e.rate;
  const r = recalc(e.draft, rate);
  const cur = e.versions.length ? e.versions[e.versions.length - 1] : null;
  return {
    id: e.id, title: e.title, dealId: e.dealId, company: e.company, contact: e.contact,
    responsible: e.responsible, countryId: e.countryId, currency: e.currency, rate: e.rate,
    status: e.status, isArchived: e.isArchived,
    currentVersion: cur ? cur.number : 0,
    totalAmount: r.total, durationDays: r.durationDays,
    hoursClient: r.hoursClient, hoursExecutor: r.hoursExecutor,
    createdAt: e.createdAt, updatedAt: e.updatedAt,
    createdBy: e.createdBy, updatedBy: e.updatedBy,
  };
}

// ---------- Роутинг API ----------
async function api(req, res, parts, query) {
  const method = req.method;

  // GET /api/bootstrap
  if (method === 'GET' && parts[1] === 'bootstrap') {
    return sendJSON(res, 200, {
      me: { name: 'А. Шидловский', role: 'company_head', portal: 'avrika.bitrix24.ru' },
      countries: store.countries, stages: store.stages, catalog: store.catalog,
    });
  }

  // GET /api/health
  if (parts[1] === 'health') return sendJSON(res, 200, { ok: true, ts: Date.now() });

  // /api/catalog
  if (method === 'GET' && parts[1] === 'catalog') return sendJSON(res, 200, store.catalog);

  // /api/countries (settings CRUD)
  if (parts[1] === 'countries') {
    if (method === 'GET') return sendJSON(res, 200, store.countries);
    if (method === 'POST') {
      const b = await readBody(req);
      const c = { id: nid('c'), name: b.name || 'Страна', currency: b.currency || 'RUB', rate: Number(b.rate) || 0 };
      store.countries.push(c); persist(); return sendJSON(res, 201, c);
    }
    if (method === 'PUT' && parts[2]) {
      const c = country(parts[2]); if (!c) return sendJSON(res, 404, { error: 'not found' });
      const b = await readBody(req);
      if (b.name != null) c.name = b.name;
      if (b.currency != null) c.currency = b.currency;
      if (b.rate != null) c.rate = Number(b.rate) || 0;
      persist(); return sendJSON(res, 200, c);
    }
    if (method === 'DELETE' && parts[2]) {
      store.countries = store.countries.filter((c) => c.id !== parts[2]); persist();
      return sendJSON(res, 200, { ok: true });
    }
  }

  // /api/estimates
  if (parts[1] === 'estimates') {
    // GET /api/estimates  (list)
    if (method === 'GET' && !parts[2]) {
      let items = store.estimates.map(estimateSummary);
      const q = (query.q || '').toLowerCase();
      if (q) items = items.filter((e) => (e.title + e.company).toLowerCase().includes(q));
      if (query.status) items = items.filter((e) => e.status === query.status);
      const archived = query.archived === 'true';
      items = items.filter((e) => !!e.isArchived === archived);
      return sendJSON(res, 200, items);
    }
    // POST /api/estimates  (create)
    if (method === 'POST' && !parts[2]) {
      const b = await readBody(req);
      const c = country(b.countryId) || store.countries[0];
      const now = new Date().toISOString();
      const e = {
        id: nid('est'), title: b.title || 'Новая смета',
        dealId: b.dealId || null, company: b.company || '', contact: b.contact || '',
        responsible: b.responsible || 'А. Шидловский',
        countryId: c.id, currency: c.currency, rate: c.rate,
        status: 'draft', isArchived: false,
        createdAt: now, updatedAt: now, createdBy: 'А. Шидловский', updatedBy: 'А. Шидловский',
        draft: { stages: defaultStages(), lines: [] }, versions: [],
      };
      store.estimates.unshift(e); persist();
      return sendJSON(res, 201, estimateSummary(e));
    }

    const e = findEstimate(parts[2]);
    if (!e) return sendJSON(res, 404, { error: 'not found' });
    const sub = parts[3];

    // GET /api/estimates/:id  (full)
    if (method === 'GET' && !sub) {
      const r = recalc(e.draft, e.rate);
      return sendJSON(res, 200, { ...e, computed: r, summary: estimateSummary(e) });
    }
    // PUT /api/estimates/:id/draft
    if (method === 'PUT' && sub === 'draft') {
      const b = await readBody(req);
      if (b.stages) e.draft.stages = b.stages;
      if (b.lines) e.draft.lines = b.lines;
      e.updatedAt = new Date().toISOString();
      persist();
      return sendJSON(res, 200, { ok: true, computed: recalc(e.draft, e.rate) });
    }
    // POST /api/estimates/:id/recalc
    if (method === 'POST' && sub === 'recalc') {
      const b = await readBody(req);
      const draft = b.draft || e.draft;
      return sendJSON(res, 200, recalc(draft, e.rate));
    }
    // POST /api/estimates/:id/versions
    if (method === 'POST' && sub === 'versions') {
      const b = await readBody(req);
      const r = recalc(e.draft, e.rate);
      const number = (e.versions.reduce((m, v) => Math.max(m, v.number), 0)) + 1;
      const v = {
        number, author: 'А. Шидловский', comment: b.comment || '',
        currency: e.currency, rate: e.rate, totalAmount: r.total, durationDays: r.durationDays,
        createdAt: new Date().toISOString(),
        snapshot: JSON.parse(JSON.stringify(e.draft)),
      };
      e.versions.push(v);
      e.updatedAt = v.createdAt;
      persist();
      return sendJSON(res, 201, v);
    }
    // POST /api/estimates/:id/catalog-insert
    if (method === 'POST' && sub === 'catalog-insert') {
      const b = await readBody(req);
      const item = store.catalog.find((c) => c.id === b.catalogItemId);
      if (!item) return sendJSON(res, 404, { error: 'catalog item not found' });
      const line = {
        id: nid('ln'), stage: item.stage, level: 2, parentId: null,
        name: item.name, description: item.description,
        qty: 1, hoursExecutor: item.hoursExecutor, hoursClient: item.hoursClient, isGroup: false,
      };
      e.draft.lines.push(line);
      e.updatedAt = new Date().toISOString();
      persist();
      return sendJSON(res, 201, { line, computed: recalc(e.draft, e.rate) });
    }
    // POST /api/estimates/:id/archive | /restore
    if (method === 'POST' && (sub === 'archive' || sub === 'restore')) {
      e.isArchived = sub === 'archive';
      persist();
      return sendJSON(res, 200, { ok: true });
    }
    // PATCH /api/estimates/:id/status
    if (method === 'POST' && sub === 'status') {
      const b = await readBody(req);
      if (b.status) e.status = b.status;
      persist();
      return sendJSON(res, 200, { ok: true, status: e.status });
    }
  }

  return sendJSON(res, 404, { error: 'unknown endpoint' });
}

// ---------- Сервер ----------
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const query = Object.fromEntries(u.searchParams.entries());
    if (u.pathname.startsWith('/api/')) {
      const parts = u.pathname.split('/').filter(Boolean); // ['api', ...]
      return await api(req, res, parts, query);
    }
    return serveStatic(res, u.pathname);
  } catch (err) {
    sendJSON(res, 500, { error: 'internal', message: String(err && err.message) });
  }
});

server.listen(PORT, () => {
  console.log(`Estimate Builder listening on :${PORT}`);
});
