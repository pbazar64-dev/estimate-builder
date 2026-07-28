'use strict';
// Конструктор смет, КП и договоров для Битрикс24 — бэкенд без внешних зависимостей.
// Слушает порт 3000 (требование платформы Vibecode).

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { seedStore, defaultStages, nid, DEMO_COMPANIES, DEMO_DEALS } = require('./seed');
const { recalc } = require('./calc');
const { buildKP, buildContract } = require('./kp');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

// Каталог данных ДОЛЖЕН быть вне /opt/app: при каждом деплое шаг «clean»
// затирает /opt/app целиком, поэтому store.json внутри приложения пропадал.
// /var/lib/estimate-builder создаётся на этапе деплоя (install-hook, root) и
// принадлежит пользователю приложения — переживает и деплой, и перезагрузку.
// Порядок предпочтения: явный EB_DATA_DIR → /var/lib → /tmp → внутри приложения.
function pickDataDir() {
  const cands = [
    process.env.EB_DATA_DIR,
    '/var/lib/estimate-builder',
    '/tmp/estimate-builder-data',
    path.join(__dirname, 'data'),
  ].filter(Boolean);
  for (const d of cands) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; }
    catch (e) { /* пробуем следующий */ }
  }
  return path.join(__dirname, 'data');
}
const DATA_DIR = pickDataDir();
const DATA_FILE = path.join(DATA_DIR, 'store.json');
// Одноразовая миграция: если в выбранном каталоге данных ещё нет, но они есть
// в запасном месте (напр. остались в /tmp с прошлой версии) — переносим свежайшие.
function migrateOldData() {
  if (fs.existsSync(DATA_FILE)) return;
  const legacy = ['/var/lib/estimate-builder', '/tmp/estimate-builder-data', path.join(__dirname, 'data')]
    .map((d) => path.join(d, 'store.json'))
    .filter((f) => f !== DATA_FILE && fs.existsSync(f));
  let best = null, bestM = 0;
  for (const f of legacy) {
    try { const m = fs.statSync(f).mtimeMs; if (m > bestM) { bestM = m; best = f; } } catch (e) {}
  }
  if (best) { try { fs.copyFileSync(best, DATA_FILE); console.log('Migrated data from', best, '->', DATA_FILE); } catch (e) {} }
}

// Доступ к CRM портала Битрикс24 через API платформы Vibecode.
// Нужен personal-ключ (vibe_api_*): читает crm.* без пользовательской сессии.
// Без ключа CRM-эндпоинты отдают демо-данные (DEMO_COMPANIES/DEMO_DEALS).
const VIBE_BASE = process.env.VIBE_API_BASE || 'https://vibecode.bitrix24.tech/v1';
const VIBE_KEY = process.env.VIBE_API_KEY || '';
const CRM_LIVE = /^vibe_api_/.test(VIBE_KEY);

// Текущий пользователь портала — приходит в заголовках запроса от шлюза Vibecode
// (при открытии приложения внутри Битрикс24). Самый надёжный источник авторства.
function gatewayUser(req) {
  const h = req.headers || {};
  const id = h['x-vibe-user-id'];
  if (!id) return null;
  let name = '';
  const enc = h['x-vibe-user-name-encoded'];
  if (enc) { try { name = decodeURIComponent(enc); } catch (e) { name = ''; } }
  if (!name && h['x-vibe-user-name']) { try { name = Buffer.from(String(h['x-vibe-user-name']), 'latin1').toString('utf8'); } catch (e) { name = String(h['x-vibe-user-name']); } }
  return { id: Number(id) || id, name: name || ('Пользователь #' + id), role: h['x-vibe-user-role'] || null };
}
// Автор операции: приоритет — пользователь из шлюза, затем присланный клиентом, затем дефолт.
function reqAuthor(req, b) {
  const gw = gatewayUser(req);
  if (gw && gw.name) return { id: gw.id, name: gw.name };
  if (b && b.author && b.author.name) return { id: b.author.id || null, name: String(b.author.name) };
  return null;
}

function vibeRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(VIBE_BASE + apiPath);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: Object.assign(
        { 'X-Api-Key': VIBE_KEY, 'Accept': 'application/json' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
      ),
      timeout: 15000,
    }, (r) => {
      let d = ''; r.on('data', (c) => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ success: false, raw: d }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// Нормализация ответа платформы в [{id, title}]
function pickList(resp) {
  const arr = Array.isArray(resp) ? resp
    : (resp && (resp.data || resp.items || (resp.result && resp.result.items))) || [];
  return (Array.isArray(arr) ? arr : []).map((x) => ({
    id: x.id != null ? x.id : x.ID,
    title: x.title || x.TITLE || x.name || ('#' + (x.id != null ? x.id : x.ID)),
    companyId: x.companyId != null ? x.companyId : (x.COMPANY_ID != null ? Number(x.COMPANY_ID) : undefined),
  }));
}

// ---------- Пункт 9: «Запустить проект» — смарт-процесс «Спецификации» (1040) ----------
const SPEC = {
  entityTypeId: 1040,
  categoryId: 29,
  stageEntityId: 'DYNAMIC_1040_STAGE_29',
  licenseField: 'ufCrm13_1768284649304',
  countryField: 'ufCrm13_1768988422809',
  hoursClientField: 'ufCrm13_1775559994',
  hoursExecutorField: 'ufCrm13_1775560009',
  totalField: 'ufCrm13_1775560026',
  startDateField: 'ufCrm13_1775560192',
  planDateField: 'ufCrm13_1777990374',
  durationField: 'ufCrm13_1775560141',
  commentField: 'ufCrm13_1777983822',
  analystField: 'ufCrm13_1779266314',
};
const USERS = { polina: 259, nastasya: 301, andrey: 1, sergey: 71 };
// Смета → страна в смарт-процессе (enum id)
const COUNTRY_ENUM = { ru: 1465 /* РФ */, by: 1463 /* РБ */, kz: 1467 /* РК */ };
const iso = (d) => d.toISOString().slice(0, 10);
function addWorkingDays(date, days) {
  const d = new Date(date.getTime()); let added = 0;
  while (added < days) { d.setDate(d.getDate() + 1); const wd = d.getDay(); if (wd !== 0 && wd !== 6) added++; }
  return d;
}
async function vibeData(method, apiPath, body) {
  const r = await vibeRequest(method, apiPath, body);
  if (r && r.success === false) throw new Error((r.error && r.error.message) || 'vibe error');
  return r && (r.data !== undefined ? r.data : r);
}

// Полная выборка списочного эндпоинта портала через offset-пагинацию.
// Шлюз отдаёт максимум 500 записей за запрос (meta.hasMore=true, если есть ещё),
// поэтому проходим постранично, пока не выберем все записи.
async function vibeListAll(basePath, { pageSize = 500, maxPages = 60 } = {}) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const resp = await vibeRequest('GET', `${basePath}${sep}limit=${pageSize}&offset=${all.length}`);
    const batch = pickList(resp);
    all.push(...batch);
    const hasMore = resp && resp.meta ? !!resp.meta.hasMore : batch.length === pageSize;
    if (!batch.length || !hasMore) break;
  }
  return all;
}

// Кэш всех компаний портала: клиент фильтрует список на своей стороне,
// поэтому серверу нужно вернуть ПОЛНЫЙ список (не только первые 500).
let _companiesCache = { at: 0, items: [] };
const COMPANIES_TTL = 5 * 60 * 1000;
async function getAllCompanies() {
  const now = Date.now();
  if (_companiesCache.items.length && now - _companiesCache.at < COMPANIES_TTL) return _companiesCache.items;
  const raw = await vibeListAll('/companies?select=id,title');
  const items = raw
    .map((x) => ({ id: x.id, title: x.title }))
    .filter((c) => c.id != null && c.title)
    .sort((a, b) => String(a.title).localeCompare(String(b.title), 'ru'));
  if (items.length) _companiesCache = { at: now, items };
  return items;
}

// ---------- Хранилище (in-memory + persist на диск, каталог вне /opt/app) ----------
let store;
try { migrateOldData(); } catch (e) { /* ignore */ }
try {
  if (fs.existsSync(DATA_FILE)) {
    store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
} catch (e) { /* ignore */ }
if (!store) store = seedStore();
console.log('Data dir:', DATA_DIR, '| store loaded:', fs.existsSync(DATA_FILE), '| estimates:', (store.estimates || []).length);

function persist() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, DATA_FILE); // атомарная запись — не бьём файл при сбое
  } catch (e) { console.error('persist failed:', e && e.message); }
}

// Миграция базы формулы для «Написание ТЗ/ЛТ» и «Тестирование и корректировки»:
// часы считаются от суммы «Настройка штатного функционала» + «Разработка» (без
// управления проектом), а не только от «Настройки». Обновляем и каталог, и уже
// созданные сметы (draft + слепки версий). Идемпотентно: строки с массивом base
// пропускаются. Существующие сметы при этом не теряются.
function migrateFormulaBases() {
  // Целевые формулы авто-услуг: часы = pct × (услуги «Настройка» без УП + услуги «Разработка» без УП).
  // baseSum по определению не включает управление проектом, поэтому база = ['setup','development'].
  const DESIRED = [
    { match: 'Написание ТЗ', base: ['setup', 'development'], pct: 0.3 },
    { match: 'Написание ЛТ', base: ['setup', 'development'], pct: 0.15 },
    { match: 'Тестирование и корректировки', base: ['setup', 'development'], pct: 0.15 },
    { match: 'Запись обучающих видео', base: ['setup', 'development'], pct: 0.02 },
  ];
  const fix = (l, isCatalog) => {
    if (!l || !l.formula || !l.name) return false;
    const d = DESIRED.find((x) => String(l.name).indexOf(x.match) !== -1);
    if (!d) return false;
    let changed = false;
    const curBase = Array.isArray(l.formula.base) ? l.formula.base.join(',') : String(l.formula.base);
    if (curBase !== d.base.join(',') || l.formula.pct !== d.pct) {
      l.formula = { base: d.base.slice(), pct: d.pct };
      changed = true;
    }
    // В каталоге у авто-услуг убираем «проставленные» часы (считаются автоматически).
    if (isCatalog && ((Number(l.hoursExecutor) || 0) !== 0 || (Number(l.hoursClient) || 0) !== 0)) {
      l.hoursExecutor = 0; l.hoursClient = 0; changed = true;
    }
    return changed;
  };
  let changed = false;
  for (const c of (store.catalog || [])) if (fix(c, true)) changed = true;
  for (const e of (store.estimates || [])) {
    for (const l of ((e.draft && e.draft.lines) || [])) if (fix(l, false)) changed = true;
    for (const v of (e.versions || [])) for (const l of ((v.snapshot && v.snapshot.lines) || [])) if (fix(l, false)) changed = true;
  }
  if (changed) { persist(); console.log('migrateFormulaBases: updated auto-service formulas'); }
}
try { migrateFormulaBases(); } catch (e) { console.error('migrateFormulaBases failed:', e && e.message); }

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

// Активная (действующая) версия сметы: e.activeVersion, иначе последняя.
function activeVersionOf(e) {
  if (!e.versions || !e.versions.length) return null;
  const latest = e.versions.reduce((m, v) => Math.max(m, v.number), 0);
  const num = e.activeVersion || latest;
  return e.versions.find((v) => v.number === num) || e.versions[e.versions.length - 1];
}

// ---------- Обогащение сметы вычислениями ----------
function estimateSummary(e) {
  const rate = e.rate;
  const active = activeVersionOf(e);
  const snap = (active && active.snapshot) ? active.snapshot : e.draft;
  const r = recalc(snap, rate);
  const launched = !!(e.launch && e.launch.specId) || e.status === 'launched';
  return {
    id: e.id, title: e.title, dealId: e.dealId, dealTitle: e.dealTitle,
    companyId: e.companyId, company: e.company, contact: e.contact,
    responsible: e.responsible, countryId: e.countryId, currency: e.currency, rate: e.rate,
    status: e.status, launched, isArchived: e.isArchived,
    currentVersion: active ? active.number : 0,
    activeVersion: active ? active.number : null,
    versionCount: (e.versions || []).length,
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
      me: { name: 'Пользователь Битрикс24', role: 'user', portal: 'avrika.bitrix24.ru' },
      countries: store.countries, stages: store.stages, catalog: store.catalog,
      crmLive: CRM_LIVE,
    });
  }

  // GET /api/health
  if (parts[1] === 'health') return sendJSON(res, 200, { ok: true, ts: Date.now() });

  // GET /api/whoami — текущий пользователь из заголовков шлюза Vibecode (открытие внутри портала)
  if (method === 'GET' && parts[1] === 'whoami') {
    const gw = gatewayUser(req);
    return sendJSON(res, 200, { user: gw || null, source: gw ? 'gateway' : null });
  }

  // GET /api/launch-meta — данные для формы «Запустить проект»
  if (method === 'GET' && parts[1] === 'launch-meta') {
    if (!CRM_LIVE) return sendJSON(res, 200, { crmLive: false, licenses: [], stages: [], projects: [] });
    try {
      const fdata = await vibeData('GET', '/items/1040/fields');
      const lf = fdata.fields[SPEC.licenseField];
      const licenses = (lf && lf.items || []).map((x) => ({ id: x.ID || x.id, name: x.VALUE || x.value }));
      const st = await vibeData('GET', `/statuses?entityId=${SPEC.stageEntityId}&limit=50`);
      const stages = (Array.isArray(st) ? st : (st.items || [])).map((x) => ({ id: x.statusId, name: x.name }));
      const wg = await vibeData('GET', '/workgroups?limit=200&select=id,name,isProject');
      const projects = (Array.isArray(wg) ? wg : (wg.items || []))
        .filter((g) => g.isProject).map((g) => ({ id: g.id, name: g.name }));
      return sendJSON(res, 200, { crmLive: true, licenses, stages, projects });
    } catch (err) {
      return sendJSON(res, 200, { crmLive: true, licenses: [], stages: [], projects: [], warning: String(err && err.message) });
    }
  }

  // GET /api/crm/users — активные сотрудники портала (для фильтра «Ответственный»)
  if (method === 'GET' && parts[1] === 'crm' && parts[2] === 'users') {
    const fallback = [
      { id: USERS.polina, name: 'Полина Базар' }, { id: USERS.nastasya, name: 'Настасья Бондаренко' },
      { id: USERS.andrey, name: 'Андрей Шидловский' }, { id: USERS.sergey, name: 'Сергей Горелышев' },
    ];
    if (!CRM_LIVE) return sendJSON(res, 200, { source: 'demo', items: fallback });
    try {
      const resp = await vibeRequest('GET', '/users?limit=500&active=true&select=id,name,lastName');
      const arr = Array.isArray(resp) ? resp : (resp && (resp.data || resp.items)) || [];
      let items = (Array.isArray(arr) ? arr : []).map((u) => ({
        id: u.id != null ? u.id : u.ID,
        name: [u.name || u.NAME, u.lastName || u.LAST_NAME].filter(Boolean).join(' ').trim() || u.email || ('#' + (u.id || u.ID)),
      })).filter((u) => u.id && u.name);
      items.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      if (!items.length) items = fallback;
      return sendJSON(res, 200, { source: 'portal', items });
    } catch (e) {
      return sendJSON(res, 200, { source: 'demo', items: fallback, warning: String(e && e.message) });
    }
  }

  // ---------- CRM портала (компании / сделки) ----------
  // GET /api/crm/companies?q=
  if (method === 'GET' && parts[1] === 'crm' && parts[2] === 'companies') {
    if (!CRM_LIVE) {
      const q = (query.q || '').toLowerCase();
      const list = DEMO_COMPANIES.filter((c) => !q || c.title.toLowerCase().includes(q));
      return sendJSON(res, 200, { source: 'demo', items: list });
    }
    try {
      const all = await getAllCompanies();
      const q = (query.q || '').toLowerCase().trim();
      const items = q ? all.filter((c) => (c.title || '').toLowerCase().includes(q)) : all;
      return sendJSON(res, 200, { source: 'portal', items, total: all.length });
    } catch (e) {
      return sendJSON(res, 200, { source: 'demo', items: DEMO_COMPANIES, warning: String(e && e.message) });
    }
  }

  // GET /api/crm/deals?companyId=
  if (method === 'GET' && parts[1] === 'crm' && parts[2] === 'deals') {
    const companyId = Number(query.companyId);
    if (!companyId) return sendJSON(res, 200, { source: CRM_LIVE ? 'portal' : 'demo', items: [] });
    if (!CRM_LIVE) {
      return sendJSON(res, 200, { source: 'demo', items: DEMO_DEALS[companyId] || [] });
    }
    try {
      const resp = await vibeRequest('POST', '/deals/search',
        { filter: { companyId }, select: ['id', 'title', 'companyId'], limit: 200, sort: { id: 'desc' } });
      const items = pickList(resp).map((x) => ({ id: x.id, title: x.title }));
      return sendJSON(res, 200, { source: 'portal', items });
    } catch (e) {
      return sendJSON(res, 200, { source: 'demo', items: DEMO_DEALS[companyId] || [], warning: String(e && e.message) });
    }
  }

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
      const auth = reqAuthor(req, b);
      const who = auth ? auth.name : (b.responsible || 'Пользователь Битрикс24');
      const whoId = auth ? auth.id : null;
      const e = {
        id: nid('est'), title: b.title || 'Новая смета',
        dealId: b.dealId || null, dealTitle: b.dealTitle || '',
        companyId: b.companyId || null, company: b.company || '', contact: b.contact || '',
        responsible: who, responsibleId: whoId,
        countryId: c.id, currency: c.currency, rate: c.rate,
        status: 'draft', isArchived: false,
        createdAt: now, updatedAt: now, createdBy: who, createdById: whoId, updatedBy: who,
        draft: { stages: defaultStages(), lines: [] }, versions: [],
      };
      store.estimates.unshift(e); persist();
      return sendJSON(res, 201, estimateSummary(e));
    }

    const e = findEstimate(parts[2]);
    if (!e) return sendJSON(res, 404, { error: 'not found' });
    const sub = parts[3];

    // GET /api/estimates/:id  (full). computed — по действующей версии (или черновику, если версий нет)
    if (method === 'GET' && !sub) {
      const active = activeVersionOf(e);
      const snap = (active && active.snapshot) ? active.snapshot : e.draft;
      const r = recalc(snap, e.rate);
      return sendJSON(res, 200, { ...e, computed: r, summary: estimateSummary(e) });
    }
    // DELETE /api/estimates/:id  (полное удаление из реестра)
    if (method === 'DELETE' && !sub) {
      store.estimates = store.estimates.filter((x) => x.id !== e.id);
      persist();
      return sendJSON(res, 200, { ok: true });
    }
    // GET /api/estimates/:id/kp[?v=N] — генерация КП в .docx по шаблону страны
    if (method === 'GET' && sub === 'kp') {
      const active = activeVersionOf(e);
      let snap = (active && active.snapshot) ? active.snapshot : e.draft;
      if (query.v) { const v = (e.versions || []).find((x) => x.number === Number(query.v)); if (v && v.snapshot) snap = v.snapshot; }
      try {
        const buf = buildKP(e, snap, store.stages, path.join(__dirname, 'templates'));
        const base = ((e.company ? e.company + ' — ' : '') + 'КП').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'КП';
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': "attachment; filename=\"KP.docx\"; filename*=UTF-8''" + encodeURIComponent(base) + '.docx',
          'Content-Length': buf.length, 'Cache-Control': 'no-store',
        });
        return res.end(buf);
      } catch (err) {
        return sendJSON(res, 500, { error: 'kp_failed', message: String(err && err.message) });
      }
    }
    // POST /api/estimates/:id/contract — генерация договора в .docx (форма в теле, ?v=N)
    if (method === 'POST' && sub === 'contract') {
      const b = await readBody(req);
      const active = activeVersionOf(e);
      let snap = (active && active.snapshot) ? active.snapshot : e.draft;
      if (b.v) { const v = (e.versions || []).find((x) => x.number === Number(b.v)); if (v && v.snapshot) snap = v.snapshot; }
      try {
        const buf = buildContract(e, snap, store.stages, b, path.join(__dirname, 'templates'));
        const base = ((e.company ? e.company + ' — ' : '') + 'Договор').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Договор';
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': "attachment; filename=\"Contract.docx\"; filename*=UTF-8''" + encodeURIComponent(base) + '.docx',
          'Content-Length': buf.length, 'Cache-Control': 'no-store',
        });
        return res.end(buf);
      } catch (err) {
        return sendJSON(res, 500, { error: 'contract_failed', message: String(err && err.message) });
      }
    }
    // PUT /api/estimates/:id/draft
    if (method === 'PUT' && sub === 'draft') {
      const b = await readBody(req);
      if (b.stages) e.draft.stages = b.stages;
      if (b.lines) e.draft.lines = b.lines;
      e.updatedAt = new Date().toISOString();
      { const a = reqAuthor(req, b); if (a) e.updatedBy = a.name; }
      persist();
      return sendJSON(res, 200, { ok: true, computed: recalc(e.draft, e.rate) });
    }
    // POST /api/estimates/:id/blank-draft — начать новую версию с чистого листа
    // (стандартный набор этапов, без услуг). Компания/сделка/страна/название — из сметы.
    if (method === 'POST' && sub === 'blank-draft') {
      e.draft = { stages: defaultStages(), lines: [] };
      e.editingFrom = null;
      e.updatedAt = new Date().toISOString();
      persist();
      return sendJSON(res, 200, { ok: true, computed: recalc(e.draft, e.rate) });
    }
    // POST /api/estimates/:id/edit-version { number } — загрузить снимок версии в черновик
    if (method === 'POST' && sub === 'edit-version') {
      const b = await readBody(req);
      const v = (e.versions || []).find((x) => x.number === Number(b.number));
      if (!v) return sendJSON(res, 404, { error: 'version not found' });
      e.draft = JSON.parse(JSON.stringify(v.snapshot));
      e.editingFrom = v.number;
      e.updatedAt = new Date().toISOString();
      persist();
      return sendJSON(res, 200, { ok: true, editingFrom: v.number, computed: recalc(e.draft, e.rate) });
    }
    // POST /api/estimates/:id/versions/:num/activate — сделать версию действующей
    if (method === 'POST' && sub === 'versions' && parts[4] && parts[5] === 'activate') {
      const num = Number(parts[4]);
      const v = (e.versions || []).find((x) => x.number === num);
      if (!v) return sendJSON(res, 404, { error: 'version not found' });
      e.activeVersion = num;
      e.updatedAt = new Date().toISOString();
      persist();
      return sendJSON(res, 200, { ok: true, activeVersion: num });
    }
    // DELETE /api/estimates/:id/versions/:num — удалить версию
    if (method === 'DELETE' && sub === 'versions' && parts[4]) {
      const num = Number(parts[4]);
      const idx = (e.versions || []).findIndex((x) => x.number === num);
      if (idx === -1) return sendJSON(res, 404, { error: 'version not found' });
      e.versions.splice(idx, 1);
      // если удалили действующую — назначаем действующей самую свежую из оставшихся
      if (e.activeVersion === num) {
        e.activeVersion = e.versions.length ? e.versions.reduce((m, v) => Math.max(m, v.number), 0) : null;
      }
      if (e.editingFrom === num) e.editingFrom = null;
      e.updatedAt = new Date().toISOString();
      persist();
      return sendJSON(res, 200, { ok: true, activeVersion: e.activeVersion, versionCount: e.versions.length });
    }
    // POST /api/estimates/:id/recalc
    if (method === 'POST' && sub === 'recalc') {
      const b = await readBody(req);
      const draft = b.draft || e.draft;
      return sendJSON(res, 200, recalc(draft, e.rate));
    }
    // POST /api/estimates/:id/versions  (создать новую версию)
    // По умолчанию — снимок текущего черновика. Если передан { from: N } (из карточки),
    // новая версия создаётся как копия версии N.
    if (method === 'POST' && sub === 'versions' && !parts[4]) {
      const b = await readBody(req);
      let baseSnap = e.draft, basedOn = e.editingFrom || null;
      if (b.from != null) {
        const fv = (e.versions || []).find((x) => x.number === Number(b.from));
        if (fv && fv.snapshot) { baseSnap = fv.snapshot; basedOn = fv.number; }
      }
      const r = recalc(baseSnap, e.rate);
      const number = (e.versions.reduce((m, v) => Math.max(m, v.number), 0)) + 1;
      const a = reqAuthor(req, b);
      const who = a ? a.name : (e.updatedBy || e.responsible || 'Пользователь Битрикс24');
      const v = {
        number, author: who, comment: b.comment || '',
        basedOn,
        currency: e.currency, rate: e.rate, totalAmount: r.total, durationDays: r.durationDays,
        createdAt: new Date().toISOString(),
        snapshot: JSON.parse(JSON.stringify(baseSnap)),
      };
      e.versions.push(v);
      e.activeVersion = number; // новая версия становится действующей
      e.editingFrom = null;
      e.updatedAt = v.createdAt;
      if (a) e.updatedBy = who;
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
      if (item.formula) line.formula = item.formula; // услуга-формула (авто-часы)
      e.draft.lines.push(line);
      // авто-включаем этап услуги, чтобы добавленная строка была видна и редактируема
      const st = e.draft.stages.find((s) => s.code === item.stage);
      if (st && !st.on) st.on = true;
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
    // POST /api/estimates/:id/payment — параметры графика платежей
    if (method === 'POST' && sub === 'payment') {
      const b = await readBody(req);
      e.payment = { mode: b.mode || null, signDate: b.signDate || null };
      e.updatedAt = new Date().toISOString();
      persist();
      return sendJSON(res, 200, { ok: true, payment: e.payment });
    }
    // PATCH /api/estimates/:id/status
    if (method === 'POST' && sub === 'status') {
      const b = await readBody(req);
      if (b.status) e.status = b.status;
      persist();
      return sendJSON(res, 200, { ok: true, status: e.status });
    }
    // POST /api/estimates/:id/launch — запуск проекта (смарт-процесс + группа + задачи)
    if (method === 'POST' && sub === 'launch') {
      if (!CRM_LIVE) return sendJSON(res, 400, { error: 'CRM недоступна: нужен personal-ключ vibe_api_*' });
      const b = await readBody(req);
      { const a = reqAuthor(req, b); if (a) b.author = a; } // запускающий = пользователь из шлюза
      try {
        const result = await launchProject(e, b);
        e.status = 'launched';
        e.launch = result;
        e.updatedAt = new Date().toISOString();
        persist();
        return sendJSON(res, 201, result);
      } catch (err) {
        return sendJSON(res, 502, { error: 'launch_failed', message: String(err && err.message) });
      }
    }
  }

  return sendJSON(res, 404, { error: 'unknown endpoint' });
}

// Список услуг сметы для задач (кроме «Управление проектом»), с эффективными часами.
// Для блока «Настройка штатного функционала» (setup) — одна общая задача,
// плановые часы = подытог часов исполнителя по блоку (без управления проектом).
function estimateServices(e) {
  const r = recalc(e.draft, e.rate);
  const out = [];
  e.draft.stages.filter((s) => s.on).sort((a, b) => a.order - b.order).forEach((s) => {
    const lines = e.draft.lines.filter((l) => l.stage === s.code && !l.isGroup && !/^управление проектом/i.test(l.name || ''));
    if (s.code === 'setup') {
      const pm = (r.stagePM && r.stagePM[s.code]) || { itemsExec: 0 };
      if (lines.length || pm.itemsExec) {
        out.push({
          name: 'настройки штатного функционала',
          description: 'Настройка штатного функционала Битрикс24 по согласованному составу работ сметы.',
          hoursExecutor: pm.itemsExec,
        });
      }
      return;
    }
    lines.forEach((l) => {
      const h = (r.lineHours && r.lineHours[l.id]) || { exec: Number(l.hoursExecutor) || 0 };
      out.push({ name: l.name, description: l.description || '', hoursExecutor: h.exec });
    });
  });
  return { services: out, computed: r };
}

async function launchProject(e, form) {
  const { services, computed } = estimateServices(e);
  const today = new Date();
  const planDate = addWorkingDays(today, computed.durationDays || 1);
  // запускающий = авторизованный в Б24 пользователь (иначе — владелец ключа)
  const launcher = (form.author && form.author.id) ? Number(form.author.id) : USERS.andrey;

  // 1) Элемент смарт-процесса «Спецификации» (1040)
  const observers = [USERS.andrey];
  if (e.countryId === 'ru' || e.countryId === 'kz') observers.push(USERS.sergey);
  const fields = {
    title: e.title,
    categoryId: SPEC.categoryId,
    assignedById: USERS.polina,
    observers,
    [SPEC.analystField]: USERS.nastasya,
    [SPEC.hoursClientField]: computed.hoursClient,
    [SPEC.hoursExecutorField]: computed.hoursExecutor,
    [SPEC.totalField]: Math.round(computed.total),
    [SPEC.durationField]: computed.durationDays,
    [SPEC.startDateField]: iso(today),
    [SPEC.planDateField]: iso(planDate),
  };
  if (form.stageId) fields.stageId = form.stageId;
  if (form.license) fields[SPEC.licenseField] = form.license;
  if (form.comment) fields[SPEC.commentField] = form.comment;
  if (COUNTRY_ENUM[e.countryId]) fields[SPEC.countryField] = COUNTRY_ENUM[e.countryId];
  if (e.companyId) fields.companyId = e.companyId;
  const specItem = await vibeData('POST', '/items/1040', fields);
  const si = (specItem && specItem.item) ? specItem.item : specItem;
  const specId = (si && (si.id != null ? si.id : si.ID)) || null;
  // привязка задач к элементу смарт-процесса «Спецификации» (UF_CRM_TASK: T<entityTypeId>_<id>)
  const crmBind = specId ? ['T' + SPEC.entityTypeId + '_' + specId] : undefined;

  // 2) Группа-проект
  let groupId = form.projectId ? Number(form.projectId) : null;
  let groupCreated = false;
  if (form.createNewFolder) {
    const grp = await vibeData('POST', '/workgroups', {
      name: e.title, ownerId: USERS.polina, isProject: true, opened: true, visible: true,
      members: [USERS.polina, USERS.nastasya, launcher],
    });
    groupId = (grp && (grp.id || (grp.workgroup && grp.workgroup.id))) || null;
    groupCreated = true;
    // create игнорирует opened → делаем группу открытой отдельным PATCH
    if (groupId) { try { await vibeData('PATCH', '/workgroups/' + groupId, { opened: true, visible: true }); } catch (x) { /* не критично */ } }
  }

  // 3) Задача «…: взять в работу»
  const taskIds = [];
  const intakeDesc = [form.comment || '', form.contacts ? ('Контактные данные: ' + form.contacts) : ''].filter(Boolean).join('\n\n');
  const intake = await vibeData('POST', '/tasks', {
    title: `${e.title}: взять в работу`,
    responsibleId: USERS.polina,
    createdBy: launcher,
    accomplices: [String(USERS.nastasya)],
    description: intakeDesc,
    deadline: addWorkingDays(today, 2).toISOString(),
    groupId: groupId || undefined,
    ufCrmTask: crmBind,
  });
  const intakeId = intake && (intake.id || (intake.task && intake.task.id));
  if (intakeId) taskIds.push(intakeId);

  // 4) Задачи по услугам
  const planIso = planDate.toISOString();
  for (const svc of services) {
    try {
      const t = await vibeData('POST', '/tasks', {
        title: `${e.title}: ${svc.name}`,
        description: svc.description,
        responsibleId: USERS.nastasya,
        createdBy: USERS.polina,
        timeEstimate: Math.round((svc.hoursExecutor || 0) * 3600),
        deadline: planIso,
        groupId: groupId || undefined,
        ufCrmTask: crmBind,
      });
      const tid = t && (t.id || (t.task && t.task.id));
      if (tid) taskIds.push(tid);
    } catch (e2) { /* пропускаем сбойную задачу */ }
  }

  return {
    specId, groupId, groupCreated, taskIds,
    specUrl: specId ? `https://avrika.bitrix24.ru/crm/type/1040/details/${specId}/` : null,
    tasksCreated: taskIds.length,
  };
}

// ---------- Сервер ----------
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const query = Object.fromEntries(u.searchParams.entries());
    // ---- Резервная копия / восстановление всего хранилища (для отката состояния) ----
    // Защищено токеном EB_ADMIN_TOKEN (задаётся в env при деплое).
    if (u.pathname === '/api/admin/backup' || u.pathname === '/api/admin/restore') {
      const token = process.env.EB_ADMIN_TOKEN || '';
      if (!token || query.token !== token) return sendJSON(res, 403, { error: 'forbidden' });
      if (u.pathname === '/api/admin/backup' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="estimate-store-backup.json"',
          'Cache-Control': 'no-store',
        });
        return res.end(JSON.stringify(store, null, 2));
      }
      if (u.pathname === '/api/admin/restore' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || !Array.isArray(body.estimates)) return sendJSON(res, 400, { error: 'invalid store: estimates[] required' });
        // перед заменой сохраняем текущее состояние рядом с данными (на случай ошибки)
        try { fs.writeFileSync(path.join(DATA_DIR, 'store.prerestore-' + Date.now() + '.json'), JSON.stringify(store)); } catch (e) { /* ignore */ }
        store = body;
        persist();
        return sendJSON(res, 200, { ok: true, estimates: (store.estimates || []).length });
      }
      return sendJSON(res, 405, { error: 'method not allowed' });
    }
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
