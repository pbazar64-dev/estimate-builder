'use strict';
/* Конструктор смет — клиентская логика (vanilla JS, без сборки). */

const App = { boot: null, estimate: null, saveTimer: null, me: null };
const $ = (s, r = document) => r.querySelector(s);

// Текущий пользователь Битрикс24 (через JS SDK портала). Нужен для авторства смет.
function resolveB24User() {
  return new Promise((resolve) => {
    if (typeof BX24 === 'undefined' || !BX24) return resolve(null);
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => fin(null), 4000);
    try {
      BX24.init(function () {
        BX24.callMethod('user.current', {}, function (res) {
          if (res.error && res.error()) return fin(null);
          const u = res.data() || {};
          const name = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ').trim();
          fin({ id: Number(u.ID) || null, name: name || u.EMAIL || null });
        });
      });
    } catch (e) { fin(null); }
  });
}
function author() {
  return (App.me && (App.me.id || App.me.name)) ? { id: App.me.id, name: App.me.name } : undefined;
}
function portalBase() { return 'https://' + ((App.boot && App.boot.me && App.boot.me.portal) || 'avrika.bitrix24.ru'); }
const api = (url, opts) => fetch('/api' + url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts)).then(r => r.json());
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
const money = (n, cur) => fmt(n) + ' ' + (cur || '');

const stageTitle = (code) => (App.boot.stages.find(s => s.code === code) || {}).title || code;

function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
}

/* ---------- Клиентский пересчёт (зеркало server/calc.js, без маржи) ----------
   «Управление проектом на этапе» — авто-строка: 20% от суммы часов пунктов этапа. */
const PM_FACTOR = 0.2;
const _ceilH = (x) => Math.ceil(x - 1e-9);
function effHours(line, baseSum) {
  if (line.formula && baseSum[line.formula.base]) {
    const b = baseSum[line.formula.base];
    return { exec: _ceilH(line.formula.pct * b.exec), client: _ceilH(line.formula.pct * b.client), computed: true };
  }
  return { exec: Number(line.hoursExecutor) || 0, client: Number(line.hoursClient) || 0, computed: false };
}
function recalc(draft, rate) {
  const lines = draft.lines || [], stages = draft.stages || [];
  const enabled = new Set(stages.filter(s => s.on).map(s => s.code));
  // базовые суммы часов (для формул) — по не-групповым, не формульным строкам
  const baseSum = {};
  for (const l of lines) {
    if (l.isGroup || l.formula) continue;
    if (!baseSum[l.stage]) baseSum[l.stage] = { exec: 0, client: 0 };
    const qty = l.qty == null ? 1 : (Number(l.qty) || 0);
    baseSum[l.stage].exec += (Number(l.hoursExecutor) || 0) * qty;
    baseSum[l.stage].client += (Number(l.hoursClient) || 0) * qty;
  }
  const lineHours = {};
  for (const l of lines) lineHours[l.id] = effHours(l, baseSum);

  const byParent = new Map();
  for (const l of lines) { const k = l.parentId || ('root:' + l.stage); (byParent.get(k) || byParent.set(k, []).get(k)).push(l); }
  const amountById = {};
  function amt(line) {
    const ch = byParent.get(line.id) || [];
    if (ch.length) { const s = ch.reduce((a, c) => a + amt(c), 0); amountById[line.id] = s; return s; }
    if (line.isGroup) { amountById[line.id] = 0; return 0; }
    const qty = line.qty == null ? 1 : (Number(line.qty) || 0);
    const a = rate * lineHours[line.id].client * qty; amountById[line.id] = a; return a;
  }
  for (const l of lines) if (l.parentId == null) amt(l);
  for (const l of lines) if (!(l.id in amountById)) amt(l);

  const agg = {};
  for (const c of enabled) agg[c] = { exec: 0, client: 0, itemsAmount: 0 };
  for (const l of lines) {
    if (!enabled.has(l.stage) || l.isGroup) continue;
    const qty = l.qty == null ? 1 : (Number(l.qty) || 0);
    agg[l.stage].exec += lineHours[l.id].exec * qty;
    agg[l.stage].client += lineHours[l.id].client * qty;
  }
  for (const l of lines) if (l.parentId == null && enabled.has(l.stage)) agg[l.stage].itemsAmount += amountById[l.id] || 0;

  const ceilH = _ceilH;
  const stagePM = {}, stageTotals = {}; let total = 0, hoursClient = 0, hoursExecutor = 0;
  for (const c of enabled) {
    const a = agg[c];
    const pmExec = ceilH(a.exec * PM_FACTOR), pmClient = ceilH(a.client * PM_FACTOR);
    const pmAmount = rate * pmClient, stageTotal = a.itemsAmount + pmAmount;
    stagePM[c] = { itemsExec: a.exec, itemsClient: a.client, itemsAmount: a.itemsAmount, pmExec, pmClient, pmAmount, total: stageTotal, stageExec: a.exec + pmExec, stageClient: a.client + pmClient };
    stageTotals[c] = stageTotal; total += stageTotal;
    hoursClient += a.client + pmClient; hoursExecutor += a.exec + pmExec;
  }
  const durationDays = Math.max(1, Math.round(hoursClient * 0.5));
  return { amountById, lineHours, baseSum, stageTotals, stagePM, total, hoursClient, hoursExecutor, durationDays, pmFactor: PM_FACTOR };
}

/* ---------- График платежей ----------
   Варианты: staged «Поэтапно», 5050 «50 на 50», prepay «Предоплата».
   Если этап один — доступны prepay и 5050; иначе staged и 5050. */
function parseDate(s) { if (!s) return null; const p = String(s).slice(0, 10).split('-'); return p.length === 3 ? new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])) : null; }
function isoDate(d) { return d ? d.toISOString().slice(0, 10) : ''; }
function addWorkingDaysC(date, days) {
  if (!date) return null;
  const d = new Date(date.getTime()); let added = 0;
  while (added < days) { d.setUTCDate(d.getUTCDate() + 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) added++; }
  return d;
}
function dayWord(n) { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return 'дней'; if (b === 1) return 'день'; if (b > 1 && b < 5) return 'дня'; return 'дней'; }
function fmtDateRu(d) { return d ? String(d.getUTCDate()).padStart(2, '0') + '.' + String(d.getUTCMonth() + 1).padStart(2, '0') + '.' + d.getUTCFullYear() : '—'; }
function paymentOptions(n) {
  return n <= 1
    ? [{ id: 'prepay', name: 'Предоплата' }, { id: '5050', name: '50 на 50' }]
    : [{ id: 'staged', name: 'Поэтапно' }, { id: '5050', name: '50 на 50' }];
}
// snapshot = {stages, lines}; payment = {mode, signDate}
function paymentSchedule(snapshot, rate, payment) {
  const r = recalc(snapshot, rate);
  const enabled = (snapshot.stages || []).filter(s => s.on).sort((a, b) => a.order - b.order);
  const amounts = enabled.map(s => r.stageTotals[s.code] || 0);
  const n = enabled.length, total = r.total, dur = r.durationDays;
  const opts = paymentOptions(n);
  let mode = (payment && payment.mode) || opts[0].id;
  if (!opts.some(o => o.id === mode)) mode = opts[0].id;
  const sign = parseDate(payment && payment.signDate);
  const ceilD = (x) => Math.ceil(x - 1e-9);
  const termPrev = (days) => `${days} рабочих ${dayWord(days)} с момента предыдущей оплаты`;
  const AVANS_TERM = '3 банковских дня с момента подписания';
  const rows = [];
  if (mode === 'prepay') {
    rows.push({ no: 1, name: 'Предоплата', sum: Math.round(total), term: AVANS_TERM, date: addWorkingDaysC(sign, 3), docs: 'Акт' });
  } else if (mode === '5050') {
    const p1 = Math.round(total * 0.5), p2 = Math.round(total) - p1;
    const d1 = addWorkingDaysC(sign, 3), d2 = d1 ? addWorkingDaysC(d1, dur) : null;
    rows.push({ no: 1, name: 'Аванс', sum: p1, term: AVANS_TERM, date: d1, docs: 'Акт' });
    rows.push({ no: 2, name: 'Окончательный расчёт', sum: p2, term: termPrev(dur), date: d2, docs: 'Акт' });
  } else { // staged
    const p1 = Math.round(total * 0.5);
    const d1 = addWorkingDaysC(sign, 3);
    rows.push({ no: 1, name: 'Аванс', sum: p1, term: AVANS_TERM, date: d1, docs: 'Акт' });
    // 2-й платёж: сумма 2-го этапа − аванс + сумма 1-го этапа
    let prevSum = p1, prevDate = d1;
    if (n >= 2) {
      const t2 = ceilD(prevSum / rate / 3);
      const d2 = prevDate ? addWorkingDaysC(prevDate, t2) : null;
      const s2 = (amounts[1] || 0) - p1 + (amounts[0] || 0);
      rows.push({ no: 2, name: 'Доплата за этап 2', sum: s2, term: termPrev(t2), date: d2, docs: 'Акт' });
      prevSum = s2; prevDate = d2;
    }
    // платежи 3..n: равны сумме соответствующего этапа
    for (let k = 3; k <= n; k++) {
      const tk = ceilD(prevSum / rate / 3);
      const dk = prevDate ? addWorkingDaysC(prevDate, tk) : null;
      const sk = amounts[k - 1] || 0;
      rows.push({ no: k, name: 'Предоплата за этап ' + k, sum: sk, term: termPrev(tk), date: dk, docs: 'Акт' });
      prevSum = sk; prevDate = dk;
    }
  }
  return { mode, options: opts, rows, stagesCount: n, hasSign: !!sign };
}
function estimateSnapshot(e) {
  const num = e.summary ? e.summary.activeVersion : null;
  const v = num ? (e.versions || []).find(x => x.number === num) : null;
  return (v && v.snapshot) ? v.snapshot : e.draft;
}
function payRowsHtml(sched, currency) {
  return sched.rows.map(p => `<tr>
    <td class="tnum">${p.no}</td>
    <td class="co">${esc(p.name)}</td>
    <td class="r num co">${p.sum != null ? fmt(p.sum) + ' ' + esc(currency) : '—'}</td>
    <td class="sub">${esc(p.term)}</td>
    <td class="tnum">${p.date ? fmtDateRu(p.date) : '<span class="sub">укажите дату</span>'}</td>
    <td>${esc(p.docs)}</td></tr>`).join('')
    || '<tr><td colspan="6" class="sub" style="padding:14px">Нет активных этапов для расчёта платежей.</td></tr>';
}
function paymentSectionHtml(e, snapshot) {
  const sched = paymentSchedule(snapshot, e.rate, e.payment);
  const opts = sched.options.map(o => `<option value="${o.id}" ${o.id === sched.mode ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  const signVal = (e.payment && e.payment.signDate) ? String(e.payment.signDate).slice(0, 10) : '';
  return `<div class="panel" style="margin-top:20px">
    <div class="stagebar" style="gap:16px;flex-wrap:wrap">
      <span class="eyebrow" style="margin-right:auto">График платежей</span>
      <label class="payctl">Вариант
        <select id="pay_mode">${opts}</select></label>
      <label class="payctl">Ориент. дата подписания договора
        <input type="date" id="pay_date" value="${signVal}"></label>
    </div>
    <div class="tblwrap"><table><thead><tr>
      <th style="width:52px">№ п/п</th><th>Наименование</th><th class="r">Сумма</th><th>Срок</th><th>Ориент. дата</th><th>Документы</th>
    </tr></thead><tbody id="pay_rows">${payRowsHtml(sched, e.currency)}</tbody></table></div>
  </div>`;
}
function wirePaymentSection(e, getSnapshot) {
  const modeSel = $('#pay_mode'), dateInp = $('#pay_date');
  if (!modeSel) return;
  const refresh = () => { const sched = paymentSchedule(getSnapshot(), e.rate, e.payment); $('#pay_rows').innerHTML = payRowsHtml(sched, e.currency); };
  const save = async () => {
    e.payment = { mode: modeSel.value, signDate: dateInp.value || null };
    refresh();
    try { await api('/estimates/' + e.id + '/payment', { method: 'POST', body: JSON.stringify(e.payment) }); } catch (x) {}
  };
  modeSel.onchange = save;
  dateInp.onchange = save;
}

/* ---------- Роутер ---------- */
function router() {
  const h = location.hash.replace(/^#\/?/, '');
  const [seg, id] = h.split('/');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === (seg || '')));
  if (seg === 'e' && id) return viewCard(id);
  if (seg === 'edit' && id) return viewEditor(id);
  if (seg === 'catalog') return viewCatalog();
  if (seg === 'settings') return viewSettings();
  return viewRegistry();
}

/* ---------- Реестр ---------- */
const launchTag = (launched) => launched
  ? '<span class="tag t-ok">Проект запущен</span>'
  : '<span class="tag t-draft">Проект не запущен</span>';
// Колонки реестра (без ID). get — значение для фильтра/сортировки, cell — разметка ячейки.
const REG_COLS = [
  { key: 'title', label: 'Название', get: e => e.title || '', cell: e => `<td class="co">${esc(e.title)}</td>` },
  { key: 'company', label: 'Компания', get: e => e.company || '', cell: e => `<td>${e.company ? esc(e.company) : '<span class="sub">—</span>'}</td>` },
  { key: 'responsible', label: 'Ответственный', get: e => e.responsible || '', cell: e => `<td>${esc(e.responsible || '—')}</td>` },
  { key: 'updatedAt', label: 'Изменена', get: e => (e.updatedAt || '').slice(0, 10), cell: e => `<td class="sub">${esc((e.updatedAt || '').slice(0, 10))}</td>` },
  { key: 'version', label: 'Версия', get: e => e.currentVersion ? 'v' + e.currentVersion : '', cell: e => `<td class="tnum">${e.currentVersion ? 'v' + e.currentVersion : '—'}</td>` },
  { key: 'status', label: 'Статус', status: true, get: e => e.launched ? 'Проект запущен' : 'Проект не запущен', cell: e => `<td>${launchTag(e.launched)}</td>` },
  { key: 'amount', label: 'Сумма', right: true, get: e => String(Math.round(e.totalAmount)), cell: e => `<td class="r num co">${fmt(e.totalAmount)} <span class="sub">${esc(e.currency)}</span></td>` },
];
const regState = { hidden: new Set(), panel: false, f: { responsible: '', dateFrom: '', dateTo: '', status: '' } };

async function viewRegistry() {
  const app = $('#app');
  app.innerHTML = `<div class="phead"><div><span class="eyebrow">Реестр</span><h1>Все сметы компании</h1>
    <p class="dek">Поиск по названию и компании; фильтры и выбор колонок — по шестерёнке. Нажмите на смету, чтобы открыть карточку.</p></div>
    <button class="btn prim" id="newBtn">+ Новая смета</button></div>
    <div class="stats" id="stats"></div>
    <div class="toolbar">
      <span class="search"><span>⌕</span><input id="q" placeholder="Поиск по названию и компании…"></span>
      <div style="position:relative">
        <button class="btn ghost gear" id="gearBtn" title="Фильтры и колонки">⚙</button>
        <div id="filtPanel" class="filtpanel hide"></div>
      </div>
      <span class="sub" id="filtBadge"></span>
    </div>
    <div class="panel tblwrap"><table><thead id="thead"></thead><tbody id="rows"></tbody></table></div>`;
  $('#newBtn').onclick = openWizard;
  $('#q').oninput = () => render();
  $('#gearBtn').onclick = (ev) => { ev.stopPropagation(); regState.panel = !regState.panel; renderPanel(); };
  document.addEventListener('click', closePanelOutside);

  function closePanelOutside(ev) {
    if (!regState.panel) return;
    const p = $('#filtPanel'); if (p && !p.contains(ev.target) && ev.target.id !== 'gearBtn') { regState.panel = false; p.classList.add('hide'); }
  }

  let all = [];
  function responsibles() { return [...new Set(all.map(e => e.responsible).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')); }
  function activeFilterCount() {
    const f = regState.f; let n = 0;
    if (f.responsible) n++; if (f.status) n++; if (f.dateFrom || f.dateTo) n++;
    return n;
  }
  function renderPanel() {
    const p = $('#filtPanel');
    p.classList.toggle('hide', !regState.panel);
    if (!regState.panel) return;
    const f = regState.f;
    const respOpts = ['<option value="">Все</option>'].concat(responsibles().map(r => `<option value="${esc(r)}" ${f.responsible === r ? 'selected' : ''}>${esc(r)}</option>`)).join('');
    p.innerHTML = `
      <div class="fp-h">Фильтры</div>
      <label class="fp-row"><span>Ответственный</span><select id="fp_resp">${respOpts}</select></label>
      <label class="fp-row"><span>Статус</span><select id="fp_status">
        <option value="">Все</option>
        <option value="launched" ${f.status === 'launched' ? 'selected' : ''}>Проект запущен</option>
        <option value="not" ${f.status === 'not' ? 'selected' : ''}>Проект не запущен</option></select></label>
      <label class="fp-row"><span>Изменена с</span><input type="date" id="fp_from" value="${esc(f.dateFrom)}"></label>
      <label class="fp-row"><span>по</span><input type="date" id="fp_to" value="${esc(f.dateTo)}"></label>
      <div class="fp-h" style="margin-top:12px">Показать колонки</div>
      <div class="fp-cols">${REG_COLS.map(c => `<label class="colopt"><input type="checkbox" data-col="${c.key}" ${regState.hidden.has(c.key) ? '' : 'checked'}> ${esc(c.label)}</label>`).join('')}</div>
      <div class="fp-acts"><button class="btn sm ghost" id="fp_reset">Сбросить всё</button><button class="btn sm" id="fp_done">Готово</button></div>`;
    $('#fp_resp').onchange = () => { f.responsible = $('#fp_resp').value; render(); };
    $('#fp_status').onchange = () => { f.status = $('#fp_status').value; render(); };
    $('#fp_from').onchange = () => { f.dateFrom = $('#fp_from').value; render(); };
    $('#fp_to').onchange = () => { f.dateTo = $('#fp_to').value; render(); };
    p.querySelectorAll('[data-col]').forEach(cb => cb.onchange = () => {
      if (cb.checked) regState.hidden.delete(cb.dataset.col); else regState.hidden.add(cb.dataset.col);
      render();
    });
    $('#fp_reset').onclick = () => { regState.hidden = new Set(); regState.f = { responsible: '', dateFrom: '', dateTo: '', status: '' }; $('#q').value = ''; render(); renderPanel(); };
    $('#fp_done').onclick = () => { regState.panel = false; p.classList.add('hide'); };
  }

  async function load() { all = await api('/estimates'); render(); }
  function visibleCols() { return REG_COLS.filter(c => !regState.hidden.has(c.key)); }
  function applyFilters(items) {
    const gq = $('#q').value.trim().toLowerCase(), f = regState.f;
    return items.filter(e => {
      if (gq && !((e.title || '') + ' ' + (e.company || '')).toLowerCase().includes(gq)) return false;
      if (f.responsible && (e.responsible || '') !== f.responsible) return false;
      if (f.status && (e.launched ? 'launched' : 'not') !== f.status) return false;
      const d = (e.updatedAt || '').slice(0, 10);
      if (f.dateFrom && (!d || d < f.dateFrom)) return false;
      if (f.dateTo && (!d || d > f.dateTo)) return false;
      return true;
    });
  }
  function bindRows() {
    $('#rows').querySelectorAll('.rowlink').forEach(tr => tr.onclick = () => location.hash = '#/e/' + tr.dataset.id);
    $('#rows').querySelectorAll('[data-del-est]').forEach(x => x.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('Удалить смету? Действие необратимо.')) return;
      await api('/estimates/' + x.dataset.delEst, { method: 'DELETE' });
      toast('Смета удалена'); load();
    });
  }
  function render() {
    const cols = visibleCols();
    const items = applyFilters(all);
    const sum = items.reduce((a, e) => a + e.totalAmount, 0);
    const launched = items.filter(e => e.launched).length;
    const avg = items.length ? Math.round(sum / items.length) : 0;
    $('#stats').innerHTML = `
      <div class="stat"><div class="k">Всего смет</div><div class="v tnum">${items.length}</div></div>
      <div class="stat"><div class="k">Запущенных проектов</div><div class="v tnum">${launched}</div></div>
      <div class="stat"><div class="k">Средняя сумма</div><div class="v tnum">${fmt(avg)}</div></div>
      <div class="stat"><div class="k">Сумма портфеля</div><div class="v tnum">${fmt(sum)}</div></div>`;
    const fc = activeFilterCount();
    $('#gearBtn').classList.toggle('on', fc > 0 || regState.hidden.size > 0);
    $('#filtBadge').textContent = fc ? ('Активных фильтров: ' + fc) : '';
    $('#thead').innerHTML = `<tr>${cols.map(c => `<th class="${c.right ? 'r' : ''}">${esc(c.label)}</th>`).join('')}<th></th></tr>`;
    $('#rows').innerHTML = items.map(e => `<tr class="rowlink" data-id="${e.id}">
      ${cols.map(c => c.cell(e)).join('')}
      <td class="r"><span class="del" data-del-est="${e.id}" title="Удалить смету">✕</span></td></tr>`).join('')
      || `<tr><td colspan="${cols.length + 1}" class="sub" style="padding:20px">Смет не найдено.</td></tr>`;
    bindRows();
  }
  load();
}

/* ---------- Мастер создания ---------- */
async function openWizard() {
  let sel = App.boot.countries[0].id;
  let companies = { source: 'demo', items: [] };
  try { companies = await api('/crm/companies'); } catch (e) {}
  const all = companies.items || [];
  const state = { companyId: null, companyTitle: '', dealId: null, dealTitle: '' };

  const m = document.createElement('div'); m.className = 'modal';
  const cnts = () => App.boot.countries.map(c => `<div class="cnt ${c.id === sel ? 'on' : ''}" data-id="${c.id}">
    <div class="fl">${esc(c.name)}</div><div class="cur">${esc(c.currency)}</div>
    <div class="rate tnum">${fmt(c.rate)}<small> /ч</small></div></div>`).join('');
  const srcNote = companies.source === 'portal'
    ? '<span class="tag t-ok" style="margin-left:8px">портал Битрикс24</span>'
    : '<span class="tag t-warn" style="margin-left:8px">демо-данные</span>';
  m.innerHTML = `<div class="box"><h3>Новая смета</h3>
    <div class="field"><label>Название сметы</label><input id="w_title" placeholder="Например: Внедрение Б24 / Настройка HR-блока / Создание дашборда"><div class="sub" style="margin-top:5px">Итоговое название: «Компания — название сметы».</div></div>
    <div class="field" style="position:relative"><label>Компания <span class="sub" style="font-weight:400;text-transform:none;letter-spacing:0">(обязательно)</span> ${srcNote}</label>
      <input id="w_company" autocomplete="off" placeholder="Начните вводить название компании…">
      <div id="w_company_list" class="combo hide"></div>
      <div class="sub" id="w_company_hint" style="margin-top:5px">Найдено компаний: ${all.length}. Выберите компанию из списка портала.</div>
      <label style="display:flex;gap:8px;align-items:center;margin:8px 0 0;cursor:pointer;font-size:12px;color:var(--ink-2)"><input type="checkbox" id="w_company_absent"> <span>Компании нет в списке — ввести название вручную</span></label>
    </div>
    <div class="field hide" id="w_company_custom_wrap"><label>Название компании (вручную)</label>
      <input id="w_company_custom" autocomplete="off" placeholder="Введите название компании">
    </div>
    <div class="field"><label>Сделка <span class="sub" style="font-weight:400;text-transform:none;letter-spacing:0">(необязательно)</span></label><select id="w_deal" disabled><option value="">— без привязки к сделке —</option></select></div>
    <div class="field"><label>Страна расчёта · ставка часа</label><div class="countries" id="w_cnts">${cnts()}</div></div>
    <div class="acts"><button class="btn ghost" id="w_cancel">Отмена</button><button class="btn prim" id="w_ok">Создать →</button></div></div>`;
  document.body.appendChild(m);
  const rebind = () => m.querySelectorAll('.cnt').forEach(el => el.onclick = () => { sel = el.dataset.id; $('#w_cnts').innerHTML = cnts(); rebind(); });
  rebind();

  const cInput = $('#w_company'), cList = $('#w_company_list'), dealSel = $('#w_deal');
  const absentBox = $('#w_company_absent'), customWrap = $('#w_company_custom_wrap'), customInput = $('#w_company_custom');
  absentBox.onchange = () => {
    const manual = absentBox.checked;
    customWrap.classList.toggle('hide', !manual);
    cInput.disabled = manual;
    if (manual) {
      state.companyId = null; state.companyTitle = ''; cInput.value = ''; cList.classList.add('hide');
      loadDeals(); customInput.focus();
    } else { state.companyTitle = ''; customInput.value = ''; }
  };
  customInput.oninput = () => { state.companyTitle = customInput.value; };

  async function loadDeals() {
    if (!state.companyId) {
      dealSel.innerHTML = '<option value="">— без привязки к сделке —</option>';
      dealSel.disabled = true; state.dealId = null; state.dealTitle = ''; return;
    }
    dealSel.disabled = true; dealSel.innerHTML = '<option>Загрузка…</option>';
    let deals = { items: [] };
    try { deals = await api('/crm/deals?companyId=' + encodeURIComponent(state.companyId)); } catch (e) {}
    const opts = ['<option value="">— выберите сделку —</option>']
      .concat((deals.items || []).map(d => `<option value="${esc(d.id)}" data-title="${esc(d.title)}">${esc(d.title)}</option>`));
    if ((deals.items || []).length === 0) opts.push('<option value="" disabled>у компании нет сделок</option>');
    dealSel.innerHTML = opts.join(''); dealSel.disabled = false;
  }
  dealSel.onchange = () => { const o = dealSel.selectedOptions[0]; state.dealId = dealSel.value ? Number(dealSel.value) : null; state.dealTitle = o ? (o.dataset.title || '') : ''; };

  function renderList(q) {
    const ql = q.trim().toLowerCase();
    const matches = (ql ? all.filter(c => (c.title || '').toLowerCase().includes(ql)) : all).slice(0, 40);
    if (!matches.length) { cList.classList.add('hide'); return; }
    cList.innerHTML = matches.map(c => `<div class="combo-item" data-id="${esc(c.id)}" data-title="${esc(c.title)}">${esc(c.title)}</div>`).join('');
    cList.classList.remove('hide');
    cList.querySelectorAll('.combo-item').forEach(it => it.onmousedown = (ev) => {
      ev.preventDefault();
      state.companyId = Number(it.dataset.id); state.companyTitle = it.dataset.title;
      cInput.value = it.dataset.title; cList.classList.add('hide'); loadDeals();
    });
  }
  cInput.oninput = () => { state.companyId = null; state.companyTitle = cInput.value; renderList(cInput.value); loadDeals(); };
  cInput.onfocus = () => renderList(cInput.value);
  cInput.onblur = () => setTimeout(() => cList.classList.add('hide'), 150);

  $('#w_cancel').onclick = () => m.remove();
  m.onclick = (e) => { if (e.target === m) m.remove(); };
  $('#w_ok').onclick = async () => {
    const companyTitle = absentBox.checked
      ? customInput.value.trim()
      : (state.companyTitle || cInput.value.trim());
    if (!companyTitle) {
      toast('Укажите компанию: выберите из списка или введите название вручную');
      (absentBox.checked ? customInput : cInput).focus();
      return;
    }
    const name = $('#w_title').value.trim() || state.dealTitle || 'Новая смета';
    const title = companyTitle ? (companyTitle + ' — ' + name) : name;
    const body = { title, companyId: state.companyId, company: companyTitle, dealId: state.dealId, dealTitle: state.dealTitle, countryId: sel, author: author() };
    const e = await api('/estimates', { method: 'POST', body: JSON.stringify(body) });
    m.remove(); toast('Смета создана'); location.hash = '#/edit/' + e.id;
  };
}

/* ---------- Карточка сметы ---------- */
async function viewCard(id) {
  const e = await api('/estimates/' + id);
  if (e.error) { $('#app').innerHTML = '<p>Смета не найдена.</p>'; return; }
  App.estimate = e;
  const r = e.computed;
  const launched = !!(e.launch && e.launch.specId) || e.status === 'launched';
  const activeNum = e.summary ? e.summary.activeVersion : null;
  const activeV = activeNum ? (e.versions || []).find(v => v.number === activeNum) : null;
  const activeSnap = (activeV && activeV.snapshot) ? activeV.snapshot : e.draft;
  const PB = portalBase();
  const companyCell = (e.company && e.companyId)
    ? `<a class="clink" href="${PB}/crm/company/details/${esc(e.companyId)}/" target="_blank" rel="noopener">${esc(e.company)} ↗</a>`
    : esc(e.company || '—');
  const dealText = (e.dealTitle ? esc(e.dealTitle) : '') + (e.dealId ? ' · #' + e.dealId : (e.dealTitle ? '' : '—'));
  const dealCell = e.dealId
    ? `<a class="clink" href="${PB}/crm/deal/details/${esc(e.dealId)}/" target="_blank" rel="noopener">${dealText} ↗</a>`
    : dealText;
  const verRows = e.versions.slice().reverse().map((v) => {
    const isActive = activeNum ? v.number === activeNum : false;
    return `<div class="vrow">
    <div class="vn serif ${isActive ? 'active' : ''}" data-setv="${v.number}" title="${isActive ? 'Действующая версия' : 'Правый клик — сделать действующей'}">v${v.number}</div>
    <div><div class="co">${esc(v.comment || '—')}</div><div class="sub">${esc((v.createdAt || '').slice(0, 10))} · ${esc(v.author)} · ${money(v.totalAmount, v.currency)}${v.basedOn ? ' · на базе v' + v.basedOn : ''}</div></div>
    <div class="vacts">
      <button class="btn sm ghost" data-editv="${v.number}" title="Редактировать эту версию в конструкторе">✎ Правка</button>
      <button class="btn sm ghost" data-act="excel" data-v="${v.number}">Excel</button>
      <button class="btn sm ghost" data-act="kp" data-v="${v.number}">КП</button>
      <button class="btn sm ghost" data-act="contract" data-v="${v.number}">Договор</button>
    </div></div>`;
  }).join('') || '<p class="sub" style="padding:8px 0">Версий пока нет. Сохраните версию в конструкторе.</p>';

  $('#app').innerHTML = `<div class="phead"><div><span class="eyebrow">Карточка сметы</span>
    <h1>${esc(e.title)}</h1></div>${launchTag(launched)}</div>
    <div class="grid2">
      <div class="info"><div class="kv">
        <div class="cell"><div class="k">Сделка</div><div class="val">${dealCell}</div></div>
        <div class="cell"><div class="k">Компания</div><div class="val">${companyCell}</div></div>
        <div class="cell"><div class="k">Контакт</div><div class="val">${esc(e.contact || '—')}</div></div>
        <div class="cell"><div class="k">Ответственный</div><div class="val">${esc(e.responsible)}</div></div>
        <div class="cell"><div class="k">Страна · валюта</div><div class="val">${esc((App.boot.countries.find(c => c.id === e.countryId) || {}).name || '')} · ${esc(e.currency)}</div></div>
        <div class="cell"><div class="k">Ставка часа</div><div class="val tnum">${fmt(e.rate)} ${esc(e.currency)} / ч</div></div>
        <div class="cell"><div class="k">Создана</div><div class="val">${esc((e.createdAt || '').slice(0, 10))} · ${esc(e.createdBy)}</div></div>
        <div class="cell"><div class="k">Изменена</div><div class="val">${esc((e.updatedAt || '').slice(0, 10))} · ${esc(e.updatedBy)}</div></div>
      </div></div>
      <div class="aside">
        <div><div class="eyebrow">Сумма${activeNum ? ' (действующая v' + activeNum + ')' : ' (черновик)'}</div><div class="bignum tnum">${fmt(r.total)} <small>${esc(e.currency)}</small></div></div>
        <hr class="hair">
        <div style="display:flex;justify-content:space-between"><span class="sub">Активных этапов</span><span class="tnum co">${activeSnap.stages.filter(s => s.on).length} из ${activeSnap.stages.length}</span></div>
        <div style="display:flex;justify-content:space-between"><span class="sub">Часы клиенту · исполнителю</span><span class="tnum co">${r.hoursClient} · ${r.hoursExecutor}</span></div>
        <div style="display:flex;justify-content:space-between"><span class="sub">Срок реализации</span><span class="tnum co">${r.durationDays} дн.</span></div>
        <hr class="hair">
        <button class="btn prim" id="editBtn">Открыть конструктор</button>
        ${e.versions.length ? '<button class="btn" id="launchBtn" style="background:var(--ok);border-color:var(--ok);color:#fff">🚀 Запустить проект</button>' : ''}
        ${e.launch && e.launch.specUrl ? `<a class="link" href="${esc(e.launch.specUrl)}" target="_blank" style="text-align:center">Спецификация #${esc(e.launch.specId)} · задач: ${e.launch.tasksCreated}</a>` : ''}
      </div>
    </div>
    ${paymentSectionHtml(e, activeSnap)}
    <div class="phead" style="margin-top:34px"><div><span class="eyebrow">Версии</span>
      <p class="dek" style="margin-top:4px">Действующая версия обведена зелёным кружком. Правый клик по номеру версии — сделать её действующей (может быть только одна). «Правка» — открыть версию в конструкторе; изменения сохранятся как новая версия.</p></div></div>
    <div class="panel" style="padding:8px 24px">${verRows}</div>`;

  wirePaymentSection(e, () => activeSnap);
  $('#editBtn').onclick = () => location.hash = '#/edit/' + e.id;
  const lb = $('#launchBtn'); if (lb) lb.onclick = () => openLaunchModal(e);
  $('#app').querySelectorAll('[data-editv]').forEach(b => b.onclick = async () => {
    await api('/estimates/' + e.id + '/edit-version', { method: 'POST', body: JSON.stringify({ number: Number(b.dataset.editv) }) });
    toast('Версия v' + b.dataset.editv + ' открыта для правки'); location.hash = '#/edit/' + e.id;
  });
  // правый клик по номеру версии — сделать действующей
  $('#app').querySelectorAll('[data-setv]').forEach(el => el.oncontextmenu = async (ev) => {
    ev.preventDefault();
    const num = Number(el.dataset.setv);
    if (num === activeNum) { toast('Версия v' + num + ' уже действующая'); return; }
    await api('/estimates/' + e.id + '/versions/' + num + '/activate', { method: 'POST', body: JSON.stringify({}) });
    toast('Версия v' + num + ' — действующая'); viewCard(e.id);
  });
  $('#app').querySelectorAll('[data-act]').forEach(b => b.onclick = () => docAction(b.dataset.act, e, Number(b.dataset.v)));
}

/* ---------- Запуск проекта (смарт-процесс «Спецификации» + группа + задачи) ---------- */
async function openLaunchModal(e) {
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="box" style="width:min(560px,94vw)"><h3>Запустить проект</h3>
    <div class="sub" style="margin-bottom:14px">Будет создан элемент смарт-процесса «Спецификации», группа-проект и задачи по услугам сметы.</div>
    <div id="lm_load" class="sub">Загрузка справочников портала…</div>
    <div id="lm_form" class="hide">
      <div class="field"><label>Лицензия</label><select id="lm_license"></select></div>
      <div class="field"><label>Стадия спецификации</label><select id="lm_stage"></select></div>
      <div class="field"><label>Комментарий</label><input id="lm_comment" placeholder="Комментарий к проекту"></div>
      <div class="field"><label>Контактные данные</label><input id="lm_contacts" placeholder="Контакты ответственного со стороны клиента"></div>
      <div class="field"><label>Проект (папка)</label><select id="lm_project"></select></div>
      <label style="display:flex;gap:8px;align-items:center;margin:6px 0 4px;cursor:pointer"><input type="checkbox" id="lm_newfolder"> <span>Создать новую папку проекта</span></label>
    </div>
    <div class="acts"><button class="btn ghost" id="lm_cancel">Отмена</button><button class="btn prim" id="lm_ok" disabled>🚀 Запустить проект</button></div></div>`;
  document.body.appendChild(m);
  $('#lm_cancel').onclick = () => m.remove();
  m.onclick = (ev) => { if (ev.target === m) m.remove(); };

  let meta = { licenses: [], stages: [], projects: [] };
  try { meta = await api('/launch-meta'); } catch (x) {}
  $('#lm_load').classList.add('hide'); $('#lm_form').classList.remove('hide'); $('#lm_ok').disabled = false;
  const opt = (arr) => ['<option value="">— не выбрано —</option>'].concat(arr.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`)).join('');
  $('#lm_license').innerHTML = opt(meta.licenses);
  $('#lm_stage').innerHTML = opt(meta.stages);
  $('#lm_project').innerHTML = opt(meta.projects);
  $('#lm_newfolder').onchange = (ev) => { $('#lm_project').disabled = ev.target.checked; };

  $('#lm_ok').onclick = async () => {
    $('#lm_ok').disabled = true; $('#lm_ok').textContent = 'Запуск…';
    const body = {
      license: $('#lm_license').value || null,
      stageId: $('#lm_stage').value || null,
      comment: $('#lm_comment').value,
      contacts: $('#lm_contacts').value,
      projectId: $('#lm_newfolder').checked ? null : ($('#lm_project').value || null),
      createNewFolder: $('#lm_newfolder').checked,
      author: author(),
    };
    const res = await api('/estimates/' + e.id + '/launch', { method: 'POST', body: JSON.stringify(body) });
    if (res && res.error) { toast('Ошибка запуска: ' + (res.message || res.error)); $('#lm_ok').disabled = false; $('#lm_ok').textContent = '🚀 Запустить проект'; return; }
    m.remove(); toast(`Проект запущен: спецификация #${res.specId}, задач ${res.tasksCreated}`); viewCard(e.id);
  };
}

/* ---------- Конструктор (редактор) ---------- */
async function viewEditor(id) {
  const e = await api('/estimates/' + id);
  if (e.error) { $('#app').innerHTML = '<p>Смета не найдена.</p>'; return; }
  App.estimate = e;
  renderEditor();
}
function scheduleSave() {
  clearTimeout(App.saveTimer);
  App.saveTimer = setTimeout(async () => {
    const e = App.estimate;
    await api('/estimates/' + e.id + '/draft', { method: 'PUT', body: JSON.stringify({ stages: e.draft.stages, lines: e.draft.lines, author: author() }) });
    const s = $('#saveState'); if (s) { s.textContent = 'Сохранено ' + new Date().toLocaleTimeString('ru-RU').slice(0, 5); }
  }, 500);
}
function renderEditor() {
  const e = App.estimate, rate = e.rate;
  const r = recalc(e.draft, rate);
  const stages = e.draft.stages.slice().sort((a, b) => a.order - b.order);
  const enabled = stages.filter(s => s.on);

  const stagePills = stages.map(s => `<span class="pill ${s.on ? 'on' : ''}" data-stage="${s.code}">${s.on ? '✓ ' : ''}${esc(stageTitle(s.code))}</span>`).join('');

  let body = '';
  enabled.forEach((s, si) => {
    const lines = e.draft.lines.filter(l => l.stage === s.code);
    const tops = lines.filter(l => l.parentId == null);
    const stageTotal = r.stageTotals[s.code] || 0;
    const sp = r.stagePM[s.code] || { stageExec: 0, stageClient: 0 };
    body += `<tr class="stagehdr"><td></td><td class="tnum">${si + 1}</td><td colspan="3">${esc(stageTitle(s.code))}</td>
      <td class="r num" data-stage-exec="${s.code}" title="Итого часов исполнителя по этапу">${sp.stageExec}</td>
      <td class="r num" data-stage-client="${s.code}" title="Итого часов клиента по этапу">${sp.stageClient}</td>
      <td class="r num" data-stage-total="${s.code}">${fmt(stageTotal)}</td>
      <td class="r"><button class="btn sm ghost" data-add="${s.code}">+ строка</button></td></tr>`;
    tops.forEach((l, li) => {
      body += rowHtml(l, `${si + 1}.${li + 1}`, r, l.isGroup);
      const kids = lines.filter(c => c.parentId === l.id);
      kids.forEach((c, ci) => { body += rowHtml(c, `${si + 1}.${li + 1}.${ci + 1}`, r, false); });
    });
    body += pmRowHtml(s.code, r);
  });

  const editingNote = e.editingFrom ? ` · <span class="tag t-warn" style="font-size:8px;padding:2px 6px">правка версии v${e.editingFrom} → сохранится как новая версия</span>` : '';
  $('#app').innerHTML = `<div class="phead"><div><span class="eyebrow">Конструктор</span>
      <h1>${esc(e.title)}</h1>
      <p class="dek">Ставка ${fmt(rate)} ${esc(e.currency)}/ч · <span id="saveState" class="sub">черновик</span>${editingNote}</p></div>
      <div style="display:flex;gap:8px"><button class="btn ghost" id="backBtn">К карточке</button>
      <button class="btn ghost" id="fromCat">Из каталога</button>
      <button class="btn prim" id="saveVer">Сохранить версию</button></div></div>
    <div class="panel">
      <div class="stagebar"><span class="eyebrow" style="margin-right:6px">Этапы:</span>${stagePills}</div>
      <div class="tblwrap"><table class="etbl"><thead><tr>
        <th style="width:24px"></th><th style="width:56px">№</th><th>Наименование</th><th>Описание</th>
        <th class="r" style="width:70px">Кол-во</th><th class="r" style="width:70px">Ч. исп.</th><th class="r" style="width:70px">Ч. клиент</th>
        <th class="r" style="width:110px">Стоимость</th><th style="width:90px"></th>
      </tr></thead><tbody>${body || '<tr><td colspan="9" class="sub" style="padding:18px">Нет строк. Добавьте из каталога или кнопкой «+ строка».</td></tr>'}</tbody></table></div>
      <div class="totbar">
        <span><span class="eyebrow">Итого</span> <b class="tnum">${fmt(r.total)} ${esc(e.currency)}</b></span>
        <span><span class="eyebrow">Часы клиенту</span> <b class="tnum" style="font-size:20px">${r.hoursClient}</b></span>
        <span><span class="eyebrow">Срок</span> <b class="tnum" style="font-size:20px">${r.durationDays} дн.</b></span>
        <span class="sub" style="flex:1;text-align:right">Стоимость = Ставка × Часы клиента × Кол-во</span>
      </div>
    </div>
    ${paymentSectionHtml(e, e.draft)}`;

  $('#backBtn').onclick = () => location.hash = '#/e/' + e.id;
  $('#saveVer').onclick = saveVersion;
  $('#fromCat').onclick = openCatalogPicker;
  wirePaymentSection(e, () => e.draft);
  $('#app').querySelectorAll('[data-stage]').forEach(p => p.onclick = () => { const s = e.draft.stages.find(x => x.code === p.dataset.stage); s.on = !s.on; scheduleSave(); renderEditor(); });
  $('#app').querySelectorAll('[data-add]').forEach(b => b.onclick = () => addLine(b.dataset.add));
  $('#app').querySelectorAll('[data-del]').forEach(b => b.onclick = () => delLine(b.dataset.del));
  $('#app').querySelectorAll('.etbl input').forEach(inp => inp.oninput = () => {
    const l = e.draft.lines.find(x => x.id === inp.dataset.id); if (!l) return;
    const f = inp.dataset.field;
    l[f] = (f === 'name' || f === 'description') ? inp.value : (inp.value === '' ? (f === 'qty' ? null : 0) : Number(inp.value));
    scheduleSave(); liveTotals();
  });
}
function pmRowHtml(code, r) {
  const pm = (r.stagePM && r.stagePM[code]) || { pmExec: 0, pmClient: 0, pmAmount: 0 };
  return `<tr class="lvl-2 pmrow"><td></td><td class="tnum sub">авто</td>
    <td class="nm co">Управление проектом на этапе</td>
    <td class="sub">20% от суммы часов пунктов этапа</td>
    <td class="r sub">—</td>
    <td class="r num" data-pm-exec="${code}">${pm.pmExec}</td>
    <td class="r num" data-pm-client="${code}">${pm.pmClient}</td>
    <td class="r num co" data-pm-amount="${code}">${fmt(pm.pmAmount)}</td>
    <td></td></tr>`;
}
function rowHtml(l, no, r, isGroup) {
  const amt = r.amountById[l.id] || 0;
  const eff = (r.lineHours && r.lineHours[l.id]) || { exec: Number(l.hoursExecutor) || 0, client: Number(l.hoursClient) || 0 };
  const lvlClass = l.parentId == null ? 'lvl-2' : 'lvl-3';
  if (isGroup) {
    return `<tr class="${lvlClass} grp"><td></td><td class="tnum sub">${no}</td>
      <td class="nm"><input data-id="${l.id}" data-field="name" value="${esc(l.name)}" style="font-weight:700"></td>
      <td colspan="4" class="sub">Группа услуг</td><td class="r num co" data-amt="${l.id}">${fmt(amt)}</td>
      <td class="r"><span class="del" data-del="${l.id}">✕</span></td></tr>`;
  }
  const isF = !!l.formula;
  const pctTxt = isF ? `${Math.round(l.formula.pct * 100)}% от блока «Настройка штатного функционала» (без управления проектом)` : '';
  const hExec = isF
    ? `<td class="r"><span class="hrs-lock" data-eff-exec="${l.id}" title="Считается автоматически: ${pctTxt}">${eff.exec} 🔒</span></td>`
    : `<td class="r"><input class="r hrs" data-id="${l.id}" data-field="hoursExecutor" value="${l.hoursExecutor == null ? '' : l.hoursExecutor}"></td>`;
  const hClient = isF
    ? `<td class="r"><span class="hrs-lock" data-eff-client="${l.id}" title="Считается автоматически: ${pctTxt}">${eff.client} 🔒</span></td>`
    : `<td class="r"><input class="r hrs" data-id="${l.id}" data-field="hoursClient" value="${l.hoursClient == null ? '' : l.hoursClient}"></td>`;
  return `<tr class="${lvlClass}${isF ? ' formularow' : ''}"><td></td><td class="tnum sub">${no}</td>
    <td class="nm"><input data-id="${l.id}" data-field="name" value="${esc(l.name)}"></td>
    <td><input data-id="${l.id}" data-field="description" value="${esc(l.description || '')}"></td>
    <td class="r"><input class="r qty" data-id="${l.id}" data-field="qty" value="${l.qty == null ? '' : l.qty}"></td>
    ${hExec}${hClient}
    <td class="r num co" data-amt="${l.id}">${fmt(amt)}</td>
    <td class="r"><span class="del" data-del="${l.id}">✕</span></td></tr>`;
}
function liveTotals() {
  const e = App.estimate, r = recalc(e.draft, e.rate);
  $('#app').querySelectorAll('[data-amt]').forEach(td => { td.textContent = fmt(r.amountById[td.dataset.amt] || 0); });
  const tb = $('.totbar');
  if (tb) tb.querySelectorAll('b')[0].textContent = fmt(r.total) + ' ' + e.currency,
    tb.querySelectorAll('b')[1].textContent = r.hoursClient,
    tb.querySelectorAll('b')[2].textContent = r.durationDays + ' дн.';
  // итоги этапов (стоимость + подытоги часов)
  $('#app').querySelectorAll('[data-stage-total]').forEach(td => { td.textContent = fmt(r.stageTotals[td.dataset.stageTotal] || 0); });
  $('#app').querySelectorAll('[data-stage-exec]').forEach(td => { const pm = r.stagePM[td.dataset.stageExec]; if (pm) td.textContent = pm.stageExec; });
  $('#app').querySelectorAll('[data-stage-client]').forEach(td => { const pm = r.stagePM[td.dataset.stageClient]; if (pm) td.textContent = pm.stageClient; });
  // авто-строки «Управление проектом»
  $('#app').querySelectorAll('[data-pm-exec]').forEach(td => { const pm = r.stagePM[td.dataset.pmExec]; if (pm) td.textContent = pm.pmExec; });
  $('#app').querySelectorAll('[data-pm-client]').forEach(td => { const pm = r.stagePM[td.dataset.pmClient]; if (pm) td.textContent = pm.pmClient; });
  $('#app').querySelectorAll('[data-pm-amount]').forEach(td => { const pm = r.stagePM[td.dataset.pmAmount]; if (pm) td.textContent = fmt(pm.pmAmount); });
  // формула-услуги (авто-часы)
  $('#app').querySelectorAll('[data-eff-exec]').forEach(sp => { const h = r.lineHours[sp.dataset.effExec]; if (h) sp.textContent = h.exec + ' 🔒'; });
  $('#app').querySelectorAll('[data-eff-client]').forEach(sp => { const h = r.lineHours[sp.dataset.effClient]; if (h) sp.textContent = h.client + ' 🔒'; });
  // график платежей (пересчёт по текущему черновику)
  const pr = $('#pay_rows'); if (pr) pr.innerHTML = payRowsHtml(paymentSchedule(e.draft, e.rate, e.payment), e.currency);
}
function nid(p) { return p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }
function addLine(stage) {
  App.estimate.draft.lines.push({ id: nid('ln'), stage, level: 2, parentId: null, name: 'Новая позиция', description: '', qty: 1, hoursExecutor: 0, hoursClient: 0, isGroup: false });
  scheduleSave(); renderEditor();
}
function delLine(id) {
  const L = App.estimate.draft.lines;
  App.estimate.draft.lines = L.filter(l => l.id !== id && l.parentId !== id);
  scheduleSave(); renderEditor();
}
async function saveVersion() {
  const e = App.estimate;
  await api('/estimates/' + e.id + '/draft', { method: 'PUT', body: JSON.stringify({ stages: e.draft.stages, lines: e.draft.lines, author: author() }) });
  const v = await api('/estimates/' + e.id + '/versions', { method: 'POST', body: JSON.stringify({ author: author() }) });
  toast('Сохранено как версия v' + (v && v.number)); location.hash = '#/e/' + e.id;
}
// Порядок и заголовки вкладок каталога — по этапам проекта
function catalogStages() {
  const present = new Set(App.boot.catalog.map(c => c.stage));
  return App.boot.stages.slice().sort((a, b) => a.order - b.order).filter(s => present.has(s.code));
}
function catalogHours(c) {
  return (c.hoursExecutor || c.hoursClient) ? `Исп. <b>${c.hoursExecutor} ч</b> · Клиент <b>${c.hoursClient} ч</b>` : '<b>оценка индивидуально</b>';
}
function groupByGroup(items) {
  const map = new Map();
  items.forEach(c => { const g = c.group || ''; if (!map.has(g)) map.set(g, []); map.get(g).push(c); });
  return [...map.entries()];
}

function openCatalogPicker() {
  const m = document.createElement('div'); m.className = 'modal';
  const stages = catalogStages();
  let active = stages[0] ? stages[0].code : '';
  const rowHtml = (c) => `<tr><td class="co">${esc(c.name)}</td><td class="sub" style="max-width:280px">${esc((c.description || '').slice(0, 90))}${(c.description || '').length > 90 ? '…' : ''}</td>
      <td class="r sub tnum">${c.hoursClient || 0} ч</td><td class="r"><button class="btn sm" data-cid="${c.id}">＋</button></td></tr>`;
  m.innerHTML = `<div class="box" style="width:min(820px,95vw)"><h3>Каталог типовых работ</h3>
    <div style="margin-bottom:10px"><span class="search"><span>⌕</span><input id="cp_q" placeholder="Поиск услуги по всем этапам…" autocomplete="off"></span></div>
    <div class="tabs" id="cp_tabs"></div>
    <div class="tblwrap" style="max-height:52vh;overflow:auto"><table><thead><tr><th>Услуга</th><th>Описание</th><th class="r">Клиент</th><th></th></tr></thead>
    <tbody id="cp_body"></tbody></table></div>
    <div class="acts"><button class="btn ghost" id="cp_close">Закрыть</button></div></div>`;
  document.body.appendChild(m);
  const bindAdd = () => m.querySelectorAll('[data-cid]').forEach(b => b.onclick = async () => {
    await api('/estimates/' + App.estimate.id + '/catalog-insert', { method: 'POST', body: JSON.stringify({ catalogItemId: b.dataset.cid }) });
    const fresh = await api('/estimates/' + App.estimate.id); App.estimate = fresh;
    toast('Добавлено в смету'); renderEditor();
  });
  const update = () => {
    const found = catMatches($('#cp_q').value);
    $('#cp_tabs').innerHTML = found ? '' : stages.map(s => `<div class="tab ${s.code === active ? 'on' : ''}" data-tab="${s.code}">${esc(stageTitle(s.code))}</div>`).join('');
    if (found) {
      $('#cp_body').innerHTML = found.length ? found.map(rowHtml).join('') : `<tr><td colspan="4" class="sub" style="padding:16px">Ничего не найдено.</td></tr>`;
    } else {
      $('#cp_body').innerHTML = groupByGroup(App.boot.catalog.filter(c => c.stage === active)).map(([g, items]) =>
        `${g ? `<tr><td colspan="4" class="grpname">${esc(g)}</td></tr>` : ''}` + items.map(rowHtml).join('')).join('');
      $('#cp_tabs').querySelectorAll('[data-tab]').forEach(t => t.onclick = () => { active = t.dataset.tab; update(); });
    }
    bindAdd();
  };
  $('#cp_q').oninput = update;
  update();
  $('#cp_close').onclick = () => m.remove();
  m.onclick = (ev) => { if (ev.target === m) m.remove(); };
}

function catCardHtml(c) {
  return `<div class="card"><div class="nm">${esc(c.name)}</div><div class="ds">${esc(c.description)}</div>
    <div class="mt"><span class="chz">${catalogHours(c)}</span></div></div>`;
}
function catMatches(q) {
  const ql = q.trim().toLowerCase();
  return ql ? App.boot.catalog.filter(c => (c.name + ' ' + (c.description || '')).toLowerCase().includes(ql)) : null;
}

/* ---------- Каталог (страница: поиск по всем вкладкам + вкладки по этапам) ---------- */
function viewCatalog() {
  const stages = catalogStages();
  let active = stages[0] ? stages[0].code : '';
  $('#app').innerHTML = `<div class="phead"><div><span class="eyebrow">Каталог</span><h1>Типовые работы</h1>
      <p class="dek">База знаний по услугам, сгруппированная по этапам проекта. Добавление в смету — из конструктора.</p></div></div>
    <div class="toolbar"><span class="search"><span>⌕</span><input id="cat_q" placeholder="Поиск услуги по всем этапам…" autocomplete="off"></span></div>
    <div class="tabs" id="cat_tabs"></div>
    <div id="cat_results" style="margin-top:8px"></div>`;

  const update = () => {
    const q = $('#cat_q').value;
    const found = catMatches(q);
    // вкладки
    $('#cat_tabs').innerHTML = found ? '' : stages.map(s =>
      `<div class="tab ${s.code === active ? 'on' : ''}" data-tab="${s.code}">${esc(stageTitle(s.code))} · ${App.boot.catalog.filter(c => c.stage === s.code).length}</div>`).join('');
    // результаты
    if (found) {
      if (!found.length) { $('#cat_results').innerHTML = `<p class="sub" style="padding:16px">По запросу «${esc(q)}» ничего не найдено.</p>`; }
      else {
        $('#cat_results').innerHTML = `<div class="phead" style="margin:6px 0 10px"><span class="eyebrow">Найдено: ${found.length}</span></div>` +
          stages.filter(s => found.some(c => c.stage === s.code)).map(s =>
            `<div class="phead" style="margin:16px 0 8px"><span class="eyebrow" style="color:var(--ink)">${esc(stageTitle(s.code))}</span></div>
             <div class="catgrid">${found.filter(c => c.stage === s.code).map(catCardHtml).join('')}</div>`).join('');
      }
    } else {
      $('#cat_results').innerHTML = groupByGroup(App.boot.catalog.filter(c => c.stage === active)).map(([g, items]) =>
        `${g ? `<div class="phead" style="margin:20px 0 10px"><span class="eyebrow">${esc(g)}</span></div>` : ''}
         <div class="catgrid">${items.map(catCardHtml).join('')}</div>`).join('');
      $('#cat_tabs').querySelectorAll('[data-tab]').forEach(t => t.onclick = () => { active = t.dataset.tab; update(); });
    }
  };
  $('#cat_q').oninput = update;
  update();
}

/* ---------- Настройки (страны и ставки) ---------- */
async function viewSettings() {
  const cs = await api('/countries');
  $('#app').innerHTML = `<div class="phead"><div><span class="eyebrow">Настройки</span><h1>Страны и ставки</h1>
    <p class="dek">Ставка часа по стране подставляется в смету при создании и фиксируется в версии.</p></div>
    <button class="btn prim" id="addC">+ Страна</button></div>
    <div class="panel tblwrap"><table><thead><tr><th>Страна</th><th>Валюта</th><th class="r">Ставка / ч</th><th></th></tr></thead>
    <tbody id="crows">${cs.map(c => `<tr>
      <td><input data-id="${c.id}" data-f="name" value="${esc(c.name)}" style="border:1px solid var(--line);background:var(--field);padding:6px 8px;font-family:var(--sans)"></td>
      <td><input data-id="${c.id}" data-f="currency" value="${esc(c.currency)}" style="width:70px;border:1px solid var(--line);background:var(--field);padding:6px 8px;font-family:var(--sans)"></td>
      <td class="r"><input class="r" data-id="${c.id}" data-f="rate" value="${c.rate}" style="width:110px;text-align:right;border:1px solid var(--line);background:var(--field);padding:6px 8px;font-family:var(--sans)"></td>
      <td class="r"><button class="btn sm ghost" data-save="${c.id}">Сохранить</button></td></tr>`).join('')}</tbody></table></div>`;
  $('#addC').onclick = async () => { await api('/countries', { method: 'POST', body: JSON.stringify({ name: 'Новая страна', currency: 'RUB', rate: 0 }) }); viewSettings(); };
  $('#app').querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
    const id = b.dataset.save, get = (f) => $(`input[data-id="${id}"][data-f="${f}"]`).value;
    await api('/countries/' + id, { method: 'PUT', body: JSON.stringify({ name: get('name'), currency: get('currency'), rate: Number(get('rate')) }) });
    toast('Ставка сохранена');
  });
}

/* ---------- Генерация документов (Excel/КП/Договор) ---------- */
function clientRows(e) {
  // клиентское представление: по этапам, без часов, только стоимость (по действующей версии)
  const snap = estimateSnapshot(e);
  const r = recalc(snap, e.rate);
  const out = [];
  snap.stages.filter(s => s.on).sort((a, b) => a.order - b.order).forEach((s, si) => {
    const lines = snap.lines.filter(l => l.stage === s.code);
    out.push({ no: `${si + 1}`, name: stageTitle(s.code), amount: r.stageTotals[s.code] || 0, lvl: 1 });
    const tops = lines.filter(l => l.parentId == null);
    tops.forEach((l, li) => {
      out.push({ no: `${si + 1}.${li + 1}`, name: l.name, desc: l.description, qty: l.qty, amount: r.amountById[l.id] || 0, lvl: 2, grp: l.isGroup });
      lines.filter(c => c.parentId === l.id).forEach((c, ci) => out.push({ no: `${si + 1}.${li + 1}.${ci + 1}`, name: c.name, desc: c.description, qty: c.qty, amount: r.amountById[c.id] || 0, lvl: 3 }));
    });
    // авто-строка «Управление проектом на этапе» (20%)
    const pm = r.stagePM[s.code];
    if (pm) out.push({ no: `${si + 1}.${tops.length + 1}`, name: 'Управление проектом на этапе', desc: 'Административное и операционное сопровождение проекта на этапе.', qty: null, amount: pm.pmAmount, lvl: 2 });
  });
  return { rows: out, total: r.total, days: r.durationDays };
}
function docAction(act, e, vnum) {
  if (act === 'excel') return exportXLSX(e);
  if (act === 'kp') return openKP(e);
  if (act === 'contract') return openContract(e);
}

/* ---- Генерация настоящего XLSX без зависимостей (номера — текст, тонкие границы) ---- */
const _CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function _crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = _CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function _zip(files) {
  const enc = new TextEncoder(), u16 = (n) => [n & 255, (n >>> 8) & 255], u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const parts = [], central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.data), crc = _crc32(data);
    const local = [0x50, 0x4b, 3, 4, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
    parts.push(Uint8Array.from(local), name, data);
    central.push(Uint8Array.from([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
    offset += local.length + name.length + data.length;
  }
  let cdSize = 0; for (const c of central) cdSize += c.length;
  const end = Uint8Array.from([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(central.length / 2), ...u16(central.length / 2), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
function _xe(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function _col(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = (i - (m + 1)) / 26; } return s; }
// JS-дата → серийный номер Excel (день 0 = 1899-12-30)
function _serial(d) { return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(1899, 11, 30)) / 86400000); }
// Стили ячеек. nf=числовой формат (0 General, 3 «#,##0», 164 дата mm-dd-yy),
// f=шрифт (0 Calibri11, 1 Calibri11ж, 2 Times11, 3 Times11ж, 4 Times9ж),
// b=рамка (1 тонкая, 2 средняя), h/v=выравнивание. Смета — Calibri/тонкие,
// график платежей — Times/средние (как в образце).
const XL_STYLES = [
  { nf: 0, f: 0, b: 1, h: 'left', v: 'top' },      // 0 — наименование/описание
  { nf: 0, f: 0, b: 1, h: 'center', v: 'top' },    // 1 — №
  { nf: 0, f: 0, b: 1, h: 'center', v: 'center' }, // 2 — кол-во/стоимость
  { nf: 0, f: 1, b: 1, h: 'center', v: 'center' }, // 3 — шапка/сумма этапа/итог
  { nf: 0, f: 1, b: 1, h: 'center', v: 'top' },    // 4 — № шапки/этапа
  { nf: 0, f: 1, b: 1, h: 'left', v: 'top' },      // 5 — название этапа
  { nf: 0, f: 1, b: 1, h: 'right', v: 'center' },  // 6 — «ИТОГО»
  { nf: 0, f: 3, b: 2, h: 'justify', v: 'center' }, // 7 — платежи: шапка (Times11ж)
  { nf: 0, f: 4, b: 2, h: 'justify', v: 'center' }, // 8 — платежи: шапка «дата» (Times9ж)
  { nf: 0, f: 2, b: 2, h: 'justify', v: 'center' }, // 9 — платежи: текст
  { nf: 3, f: 2, b: 2, h: 'justify', v: 'center' }, // 10 — платежи: сумма #,##0
  { nf: 164, f: 2, b: 2, h: 'center', v: 'center' }, // 11 — платежи: дата mm-dd-yy
];
function _stylesXml() {
  const numFmts = '<numFmts count="1"><numFmt numFmtId="164" formatCode="mm-dd-yy"/></numFmts>';
  const fonts = '<fonts count="5">'
    + '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
    + '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
    + '<font><sz val="11"/><name val="Times New Roman"/><family val="1"/></font>'
    + '<font><b/><sz val="11"/><name val="Times New Roman"/><family val="1"/></font>'
    + '<font><b/><sz val="9"/><name val="Times New Roman"/><family val="1"/></font>'
    + '</fonts>';
  const borders = '<borders count="3">'
    + '<border><left/><right/><top/><bottom/><diagonal/></border>'
    + '<border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border>'
    + '<border><left style="medium"/><right style="medium"/><top style="medium"/><bottom style="medium"/><diagonal/></border>'
    + '</borders>';
  const xf = XL_STYLES.map((s) => `<xf numFmtId="${s.nf}" fontId="${s.f}" fillId="0" borderId="${s.b}" xfId="0" applyNumberFormat="1" applyBorder="1" applyFont="1" applyAlignment="1"><alignment horizontal="${s.h}" vertical="${s.v}" wrapText="1"/></xf>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts}${fonts}<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>${borders}<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${XL_STYLES.length}">${xf}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}
function _sheet(rows, opts) {
  opts = opts || {};
  let body = '';
  rows.forEach((cells, ri) => {
    const r = ri + 1; let rc = '';
    cells.forEach((cell, ci) => {
      if (!cell) return; // ячейки нет вовсе → без рамки
      const ref = _col(ci) + r, s = cell.s || 0;
      if (cell.v === '' || cell.v == null) { rc += `<c r="${ref}" s="${s}"/>`; return; } // пустая, но с рамкой
      rc += cell.t === 'n' ? `<c r="${ref}" s="${s}"><v>${cell.v}</v></c>`
        : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${_xe(cell.v)}</t></is></c>`;
    });
    body += `<row r="${r}">${rc}</row>`;
  });
  const cols = opts.widths ? `<cols>${opts.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const merges = (opts.merges && opts.merges.length) ? `<mergeCells count="${opts.merges.length}">${opts.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData>${merges}</worksheet>`;
}
function _xlsx(rows, opts) {
  return _zip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Смета" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: _stylesXml() },
    { name: 'xl/worksheets/sheet1.xml', data: _sheet(rows, opts) },
  ]);
}
function exportXLSX(e) {
  const { rows, total } = clientRows(e);
  const S = (v, s) => ({ v, t: 's', s });          // текст
  const N = (v, s) => ({ v: Math.round(v), t: 'n', s }); // число (General)
  const B = (s) => ({ v: '', s });                  // пустая ячейка с рамкой
  const out = [];
  const merges = [];
  // шапка
  out.push([S('№', 4), S('Этап/задача', 3), S('Описание', 3), S('Кол-во', 3), S('Стоимость', 3)]);
  rows.forEach((r) => {
    const rn = out.length + 1; // текущий номер строки Excel
    if (r.lvl === 1) {
      // строка этапа: № жирн., название (B:C объединено), стоимость жирн.; кол-во/описание пусты, но с рамками
      out.push([S(r.no, 4), S(r.name, 5), B(5), B(2), N(r.amount, 3)]);
      merges.push('B' + rn + ':C' + rn);
    } else {
      // строка услуги/группы: № центр, наименование и описание слева, кол-во и стоимость по центру
      const noQty = (r.qty == null || r.grp);
      out.push([S(r.no, 1), S(r.name, 0), S(r.desc || '', 0), noQty ? B(2) : N(r.qty, 2), N(r.amount, 2)]);
    }
  });
  // ИТОГО (A:D объединено, по правому краю)
  const tn = out.length + 1;
  out.push([S('ИТОГО', 6), B(6), B(6), B(6), N(total, 3)]);
  merges.push('A' + tn + ':D' + tn);

  // --- График платежей (Times New Roman, средние рамки), колонки G..L, ниже сметы ---
  const sched = paymentSchedule(estimateSnapshot(e), e.rate, e.payment);
  const PS = (v, s) => ({ v, t: 's', s });
  const PN = (v, s) => ({ v: Math.round(v), t: 'n', s });
  const PBl = (s) => ({ v: '', s });
  const PD = (d, s) => (d ? { v: _serial(d), t: 'n', s } : { v: '', s });
  const G = 6; // индекс колонки G (A=0)
  out.push([]); // строка-разделитель между сметой и графиком
  const hdr = [];
  hdr[G] = PS('№ п/п', 7); hdr[G + 1] = PS('Наименование', 7); hdr[G + 2] = PS('Сумма, рублей.', 7);
  hdr[G + 3] = PS('Срок', 7); hdr[G + 4] = PS('Ориентировочная дата', 8); hdr[G + 5] = PS('Документы', 7);
  out.push(hdr);
  sched.rows.forEach((p) => {
    const row = [];
    row[G] = PN(p.no, 9);
    row[G + 1] = PS(p.name, 9);
    row[G + 2] = (p.sum != null) ? PN(p.sum, 10) : PBl(10);
    row[G + 3] = PS(p.term, 9);
    row[G + 4] = p.date ? PD(p.date, 11) : PBl(11);
    row[G + 5] = PS(p.docs, 9);
    out.push(row);
  });

  const fname = (e.title ? e.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() : ('Смета_' + e.id)) || ('Смета_' + e.id);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(_xlsx(out, { widths: [3.7, 21, 27.3, 7, 10.3, 8.9, 6.2, 20.7, 8.9, 23.9, 15.4, 12.2], merges }));
  a.download = fname + '.xlsx'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Excel (.xlsx) выгружен');
}
function docWindow(title, inner) {
  const w = window.open('', '_blank');
  if (!w) { toast('Разрешите всплывающие окна'); return; }
  w.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title>
  <style>@font-face{font-family:"Playfair";src:url("${location.origin}/playfair.woff2") format("woff2");font-weight:400 900}
  body{font-family:"Helvetica Neue",Arial,sans-serif;color:#14110F;max-width:820px;margin:0 auto;padding:48px 40px;line-height:1.5}
  h1{font-family:"Playfair",Georgia,serif;font-size:34px;font-weight:800;margin:0 0 4px}
  .eyebrow{font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:#6B655E;font-weight:700}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:18px}
  th{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6B655E;text-align:left;border-bottom:1px solid #14110F;padding:8px 6px}
  td{padding:8px 6px;border-bottom:1px solid #E6E1D8;vertical-align:top}
  .r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .l1 td{background:#F7F4EE;font-family:"Playfair",serif;font-weight:700}
  .l3 td:first-child{padding-left:22px}
  .tot td{border-top:2px solid #14110F;font-family:"Playfair",serif;font-size:16px;font-weight:700}
  .muted{color:#6B655E;font-size:12px}@media print{body{padding:0}}</style></head><body>${inner}
  <p style="margin-top:34px" class="muted">Документ сформирован в Estimate Builder · ООО «Ава Тетис»</p>
  <script>setTimeout(function(){window.print&&0},100)<\/script></body></html>`);
  w.document.close();
}
function openKP(e) {
  const { rows, total, days } = clientRows(e);
  const body = rows.map(r => `<tr class="${r.lvl === 1 ? 'l1' : r.lvl === 3 ? 'l3' : ''}">
    <td>${r.no}</td><td>${esc(r.name)}${r.desc ? `<div class="muted">${esc(r.desc)}</div>` : ''}</td>
    <td class="r">${r.lvl === 1 || r.grp ? '' : (r.qty == null ? '' : r.qty)}</td>
    <td class="r">${fmt(r.amount)}</td></tr>`).join('');
  docWindow('Коммерческое предложение', `<div class="eyebrow">Коммерческое предложение · Внедрение Битрикс24</div>
    <h1>${esc(e.company || 'Клиент')}</h1>
    <p class="muted">Дата: ${new Date().toLocaleDateString('ru-RU')} · Действительно до: ${new Date(Date.now() + 12096e5).toLocaleDateString('ru-RU')}</p>
    <table><thead><tr><th>№</th><th>Наименование</th><th class="r">Кол-во</th><th class="r">Стоимость, ${esc(e.currency)}</th></tr></thead>
    <tbody>${body}<tr class="tot"><td></td><td>ИТОГО</td><td></td><td class="r">${fmt(total)}</td></tr></tbody></table>
    <p style="margin-top:20px"><b>Срок реализации:</b> ${days} рабочих дней. <b>Условия оплаты:</b> предоплата 50%, далее поэтапно.</p>`);
}
function openContract(e) {
  const { rows, total } = clientRows(e);
  const stageTot = rows.filter(r => r.lvl === 1);
  const body = rows.map(r => `<tr class="${r.lvl === 1 ? 'l1' : r.lvl === 3 ? 'l3' : ''}">
    <td>${r.no}</td><td>${esc(r.name)}${r.desc ? `<div class="muted">${esc(r.desc)}</div>` : ''}</td>
    <td class="r">${r.lvl === 1 || r.grp ? '' : (r.qty == null ? '' : r.qty)}</td><td class="r">${fmt(r.amount)}</td></tr>`).join('');
  docWindow('Спецификация к договору', `<div class="eyebrow">Приложение · Спецификация (протокол согласования цен)</div>
    <h1>Спецификация № 1</h1>
    <p class="muted">Заказчик: ${esc(e.company || '—')} · Исполнитель: ООО «Ава Тетис»</p>
    <p><b>Стоимость услуг:</b> ${money(total, e.currency)} без НДС, в том числе по этапам:</p>
    <ul class="muted">${stageTot.map(s => `<li>${esc(s.name)}: ${money(s.amount, e.currency)}</li>`).join('')}</ul>
    <table><thead><tr><th>№</th><th>Этап / услуга</th><th class="r">Кол-во</th><th class="r">Стоимость, ${esc(e.currency)}</th></tr></thead>
    <tbody>${body}<tr class="tot"><td></td><td>ИТОГО</td><td></td><td class="r">${fmt(total)}</td></tr></tbody></table>`);
}

/* ---------- Bootstrap ---------- */
(async function init() {
  App.boot = await api('/bootstrap');
  const u = await resolveB24User();
  App.me = u || { id: null, name: App.boot.me.name };
  $('#who').innerHTML = `<b>${esc(App.me.name)}</b><br>${esc(App.boot.me.portal)}`;
  window.addEventListener('hashchange', router);
  router();
})();
