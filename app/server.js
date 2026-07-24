'use strict';
// Конструктор смет, КП и договоров для Битрикс24 — бэкенд без внешних зависимостей.
// Слушает порт 3000 (требование платформы Vibecode).

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { seedStore, defaultStages, nid, DEMO_COMPANIES, DEMO_DEALS } = require('./seed');
const { recalc } = require('./calc');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'store.json');

// Доступ к CRM портала Битрикс24 через API платформы Vibecode.
// Нужен personal-ключ (vibe_api_*): читает crm.* без пользовательской сессии.
// Без ключа CRM-эндпоинты отдают демо-данные (DEMO_COMPANIES/DEMO_DEALS).
const VIBE_BASE = process.env.VIBE_API_BASE || 'https://vibecode.bitrix24.tech/v1';
const VIBE_KEY = process.env.VIBE_API_KEY || '';
const CRM_LIVE = /^vibe_api_/.test(VIBE_KEY);

// ---------- Идентификация пользователя через OAuth-сессию (vibe_app_*) ----------
// Используется ТОЛЬКО чтобы узнать, кто сейчас в приложении (автор/ответственный).
// CRM-операции остаются на персональном ключе VIBE_API_KEY.
const VIBE_APP_KEY = process.env.VIBE_APP_KEY || '';
const OAUTH_ENABLED = /^vibe_app_/.test(VIBE_APP_KEY);
const oauthSessions = new Map(); // sid -> { session, user, exp }
const oauthStates = new Map();   // state -> exp
const _oauthCleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthSessions) if (v.exp < now) oauthSessions.delete(k);
  for (const [k, v] of oauthStates) if (v < now) oauthStates.delete(k);
}, 300000);
if (_oauthCleanup.unref) _oauthCleanup.unref();

function httpsJson(method, fullUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(fullUrl);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: Object.assign({ Accept: 'application/json' }, headers || {},
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      timeout: 15000,
    }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: r.statusCode, json: j, raw: d }); }); });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}
function parseCookies(req) {
  const h = req.headers.cookie || ''; const o = {};
  h.split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function cookieHeader(name, val, maxAge) {
  return `${name}=${encodeURIComponent(val)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None`;
}
const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || '').replace(/\/+$/, '');
function publicOrigin(req) {
  if (APP_PUBLIC_URL) return APP_PUBLIC_URL; // зафиксированный публичный URL = зарегистрированный redirect_uri
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
function extractUser(o) {
  if (!o || typeof o !== 'object') return null;
  const id = o.id != null ? o.id : (o.ID != null ? o.ID : (o.userId != null ? o.userId : (o.USER_ID != null ? o.USER_ID : null)));
  const name = [o.name || o.NAME || o.firstName || o.first_name, o.lastName || o.LAST_NAME || o.last_name].filter(Boolean).join(' ').trim()
    || o.fullName || o.FULL_NAME || o.title || o.email || o.EMAIL || null;
  if (id == null && !name) return null;
  return { id: id != null ? (Number(id) || id) : null, name: name || ('#' + id) };
}
// Разрешить текущего пользователя по сессии Vibecode (несколько источников — платформа/шейпы разнятся)
async function resolveSessionUser(session) {
  const H = { 'X-Api-Key': VIBE_APP_KEY, Authorization: 'Bearer ' + session };
  const tries = ['/me', '/users/current', '/user/current', '/profile'];
  for (const p of tries) {
    try {
      const r = await httpsJson('GET', VIBE_BASE + p, H);
      const d = (r.json && (r.json.data !== undefined ? r.json.data : r.json)) || {};
      const u = extractUser(d.user || d.currentUser || d.profile || d);
      if (u && (u.id != null || u.name)) return u;
    } catch (e) { /* следующий источник */ }
  }
  return null;
}
async function oauthRoute(req, res, pathname, query) {
  const redirectUri = publicOrigin(req) + '/oauth/callback';
  if (pathname === '/oauth/login') {
    if (!OAUTH_ENABLED) { res.writeHead(302, { Location: '/?auth=disabled' }); return res.end(); }
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, Date.now() + 600000);
    const auth = `${VIBE_BASE}/oauth/authorize?app_key=${encodeURIComponent(VIBE_APP_KEY)}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.writeHead(302, { 'Set-Cookie': cookieHeader('eb_ostate', state, 600), Location: auth });
    return res.end();
  }
  if (pathname === '/oauth/callback') {
    const code = query.code, state = query.state, cookies = parseCookies(req);
    if (!code || !state || !oauthStates.has(state) || (cookies.eb_ostate && cookies.eb_ostate !== state)) {
      res.writeHead(302, { Location: '/?auth=err&reason=state' }); return res.end();
    }
    oauthStates.delete(state);
    try {
      const tok = await httpsJson('POST', `${VIBE_BASE}/oauth/token`, { 'X-Api-Key': VIBE_APP_KEY }, { app_key: VIBE_APP_KEY, code, redirect_uri: redirectUri });
      const td = (tok.json && (tok.json.data !== undefined ? tok.json.data : tok.json)) || {};
      const session = td.session || td.token || td.access_token || td.sessionToken || td.accessToken;
      if (!session) { res.writeHead(302, { Location: '/?auth=err&reason=token' }); return res.end(); }
      let user = extractUser(td.user || td.currentUser);
      if (!user) user = await resolveSessionUser(session);
      const sid = crypto.randomBytes(24).toString('hex');
      oauthSessions.set(sid, { session, user, exp: Date.now() + 8 * 3600 * 1000 });
      // Пробрасываем и в куке, и во фрагменте URL (на случай блокировки сторонних кук в iframe)
      const frag = '#uid=' + encodeURIComponent((user && user.id) || '') + '&uname=' + encodeURIComponent((user && user.name) || '') + '&sid=' + sid;
      res.writeHead(302, { 'Set-Cookie': cookieHeader('eb_sid', sid, 8 * 3600), Location: '/?auth=ok' + frag });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: '/?auth=err&reason=exchange' }); return res.end();
    }
  }
  res.writeHead(404); res.end('not found');
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

  // GET /api/whoami — текущий пользователь по OAuth-сессии (куки eb_sid или заголовок X-EB-SID)
  if (method === 'GET' && parts[1] === 'whoami') {
    const cookies = parseCookies(req);
    const sid = cookies.eb_sid || req.headers['x-eb-sid'] || query.sid || '';
    const s = sid && oauthSessions.get(sid);
    if (s && s.exp > Date.now()) return sendJSON(res, 200, { user: s.user || null, hasSession: true });
    return sendJSON(res, 200, { user: null, needsAuth: OAUTH_ENABLED, loginUrl: '/oauth/login' });
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

  // ---------- CRM портала (компании / сделки) ----------
  // GET /api/crm/companies?q=
  if (method === 'GET' && parts[1] === 'crm' && parts[2] === 'companies') {
    if (!CRM_LIVE) {
      const q = (query.q || '').toLowerCase();
      const list = DEMO_COMPANIES.filter((c) => !q || c.title.toLowerCase().includes(q));
      return sendJSON(res, 200, { source: 'demo', items: list });
    }
    try {
      const resp = await vibeRequest('GET', '/companies?limit=500&select=id,title&order[title]=asc');
      let items = pickList(resp).map((x) => ({ id: x.id, title: x.title }));
      const q = (query.q || '').toLowerCase();
      if (q) items = items.filter((c) => (c.title || '').toLowerCase().includes(q));
      return sendJSON(res, 200, { source: 'portal', items });
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
      const who = (b.author && b.author.name) ? String(b.author.name) : (b.responsible || 'Пользователь Битрикс24');
      const whoId = (b.author && b.author.id) ? b.author.id : null;
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
    // PUT /api/estimates/:id/draft
    if (method === 'PUT' && sub === 'draft') {
      const b = await readBody(req);
      if (b.stages) e.draft.stages = b.stages;
      if (b.lines) e.draft.lines = b.lines;
      e.updatedAt = new Date().toISOString();
      if (b.author && b.author.name) e.updatedBy = String(b.author.name);
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
    // POST /api/estimates/:id/recalc
    if (method === 'POST' && sub === 'recalc') {
      const b = await readBody(req);
      const draft = b.draft || e.draft;
      return sendJSON(res, 200, recalc(draft, e.rate));
    }
    // POST /api/estimates/:id/versions  (создать новую версию из текущего черновика)
    if (method === 'POST' && sub === 'versions' && !parts[4]) {
      const b = await readBody(req);
      const r = recalc(e.draft, e.rate);
      const number = (e.versions.reduce((m, v) => Math.max(m, v.number), 0)) + 1;
      const who = (b.author && b.author.name) ? String(b.author.name) : (e.updatedBy || e.responsible || 'Пользователь Битрикс24');
      const v = {
        number, author: who, comment: b.comment || '',
        basedOn: e.editingFrom || null,
        currency: e.currency, rate: e.rate, totalAmount: r.total, durationDays: r.durationDays,
        createdAt: new Date().toISOString(),
        snapshot: JSON.parse(JSON.stringify(e.draft)),
      };
      e.versions.push(v);
      e.activeVersion = number; // новая версия становится действующей
      e.editingFrom = null;
      e.updatedAt = v.createdAt;
      if (b.author && b.author.name) e.updatedBy = who;
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
    if (u.pathname.startsWith('/oauth/')) return await oauthRoute(req, res, u.pathname, query);
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
