'use strict';
/* Конструктор смет — клиентская логика (vanilla JS, без сборки). */

const App = { boot: null, estimate: null, saveTimer: null };
const $ = (s, r = document) => r.querySelector(s);
const api = (url, opts) => fetch('/api' + url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts)).then(r => r.json());
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
const money = (n, cur) => fmt(n) + ' ' + (cur || '');

const STATUS = {
  draft: ['Черновик', 't-draft'], on_approval: ['На согласовании', 't-warn'],
  approved: ['Согласована', 't-ok'], rejected: ['Отклонена', 't-dg'],
  kp_ready: ['КП сформировано', 't-ink'], contract_ready: ['Договор', 't-ink'],
  signed: ['Подписан', 't-ok'], archived: ['Архив', 't-draft'],
};
const statusTag = (s) => { const x = STATUS[s] || [s, 't-draft']; return `<span class="tag ${x[1]}">${esc(x[0])}</span>`; };
const stageTitle = (code) => (App.boot.stages.find(s => s.code === code) || {}).title || code;

function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
}

/* ---------- Клиентский пересчёт (зеркало server/calc.js, без маржи) ---------- */
function recalc(draft, rate) {
  const lines = draft.lines || [], stages = draft.stages || [];
  const enabled = new Set(stages.filter(s => s.on).map(s => s.code));
  const byParent = new Map();
  for (const l of lines) { const k = l.parentId || ('root:' + l.stage); (byParent.get(k) || byParent.set(k, []).get(k)).push(l); }
  const amountById = {};
  function amt(line) {
    const ch = byParent.get(line.id) || [];
    if (ch.length) { const s = ch.reduce((a, c) => a + amt(c), 0); amountById[line.id] = s; return s; }
    if (line.isGroup) { amountById[line.id] = 0; return 0; }
    const qty = line.qty == null ? 1 : (Number(line.qty) || 0);
    const a = rate * (Number(line.hoursClient) || 0) * qty; amountById[line.id] = a; return a;
  }
  const stageTotals = {}; let total = 0, hoursClient = 0, hoursExecutor = 0;
  for (const l of lines) if (enabled.has(l.stage) && !l.isGroup) {
    const qty = l.qty == null ? 1 : (Number(l.qty) || 0);
    hoursClient += (Number(l.hoursClient) || 0) * qty; hoursExecutor += (Number(l.hoursExecutor) || 0) * qty;
  }
  for (const l of lines) {
    if (l.parentId == null && enabled.has(l.stage)) { const a = amt(l); stageTotals[l.stage] = (stageTotals[l.stage] || 0) + a; total += a; }
    else if (l.parentId != null) amt(l);
  }
  const durationDays = Math.max(1, Math.round(hoursClient * 0.5));
  return { amountById, stageTotals, total, hoursClient, hoursExecutor, durationDays };
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
async function viewRegistry() {
  const app = $('#app');
  app.innerHTML = `<div class="phead"><div><span class="eyebrow">Реестр</span><h1>Все сметы компании</h1>
    <p class="dek">Поиск, фильтры, статусы. Нажмите на смету, чтобы открыть карточку и версии.</p></div>
    <button class="btn prim" id="newBtn">+ Новая смета</button></div>
    <div class="stats" id="stats"></div>
    <div class="toolbar"><span class="search"><span>⌕</span><input id="q" placeholder="Поиск по названию или компании…"></span></div>
    <div class="panel tblwrap"><table><thead><tr>
      <th>ID</th><th>Название</th><th>Компания</th><th>Ответственный</th><th>Изменена</th><th>Верс.</th><th>Статус</th><th class="r">Сумма</th>
    </tr></thead><tbody id="rows"></tbody></table></div>`;
  $('#newBtn').onclick = openWizard;
  $('#q').oninput = () => load();
  async function load() {
    const q = $('#q').value.trim();
    const items = await api('/estimates' + (q ? ('?q=' + encodeURIComponent(q)) : ''));
    const sum = items.reduce((a, e) => a + e.totalAmount, 0);
    const onAppr = items.filter(e => e.status === 'on_approval').length;
    const avg = items.length ? Math.round(sum / items.length) : 0;
    $('#stats').innerHTML = `
      <div class="stat"><div class="k">Всего смет</div><div class="v tnum">${items.length}</div></div>
      <div class="stat"><div class="k">На согласовании</div><div class="v tnum">${onAppr}</div></div>
      <div class="stat"><div class="k">Средняя сумма</div><div class="v tnum">${fmt(avg)}</div></div>
      <div class="stat"><div class="k">Сумма портфеля</div><div class="v tnum">${fmt(sum)}</div></div>`;
    $('#rows').innerHTML = items.map(e => `<tr class="rowlink" data-id="${e.id}">
      <td class="sub tnum">${esc(e.id)}</td><td class="co">${esc(e.title)}</td><td>${esc(e.company)}</td>
      <td>${esc(e.responsible)}</td><td class="sub">${esc((e.updatedAt || '').slice(0, 10))}</td>
      <td class="tnum">v${e.currentVersion}</td><td>${statusTag(e.status)}</td>
      <td class="r num co">${fmt(e.totalAmount)} <span class="sub">${esc(e.currency)}</span></td></tr>`).join('')
      || `<tr><td colspan="8" class="sub" style="padding:20px">Смет не найдено.</td></tr>`;
    $('#rows').querySelectorAll('.rowlink').forEach(tr => tr.onclick = () => location.hash = '#/e/' + tr.dataset.id);
  }
  load();
}

/* ---------- Мастер создания ---------- */
async function openWizard() {
  let sel = App.boot.countries[0].id;
  let companies = { source: 'demo', items: [] };
  try { companies = await api('/crm/companies'); } catch (e) {}
  const m = document.createElement('div'); m.className = 'modal';
  const cnts = () => App.boot.countries.map(c => `<div class="cnt ${c.id === sel ? 'on' : ''}" data-id="${c.id}">
    <div class="fl">${esc(c.name)}</div><div class="cur">${esc(c.currency)}</div>
    <div class="rate tnum">${fmt(c.rate)}<small> /ч</small></div></div>`).join('');
  const companyOptions = ['<option value="">— выберите компанию —</option>']
    .concat((companies.items || []).map(c => `<option value="${esc(c.id)}" data-title="${esc(c.title)}">${esc(c.title)}</option>`)).join('');
  const srcNote = companies.source === 'portal'
    ? '<span class="tag t-ok" style="margin-left:8px">портал Битрикс24</span>'
    : '<span class="tag t-warn" style="margin-left:8px">демо-данные</span>';
  m.innerHTML = `<div class="box"><h3>Новая смета</h3>
    <div class="field"><label>Название</label><input id="w_title" placeholder="Внедрение Битрикс24 — …"></div>
    <div class="field"><label>Компания ${srcNote}</label><select id="w_company">${companyOptions}</select></div>
    <div class="field"><label>Сделка</label><select id="w_deal" disabled><option value="">— сначала выберите компанию —</option></select></div>
    <div class="field"><label>Страна расчёта · ставка часа</label><div class="countries" id="w_cnts">${cnts()}</div></div>
    <div class="acts"><button class="btn ghost" id="w_cancel">Отмена</button><button class="btn prim" id="w_ok">Создать →</button></div></div>`;
  document.body.appendChild(m);
  const rebind = () => m.querySelectorAll('.cnt').forEach(el => el.onclick = () => { sel = el.dataset.id; $('#w_cnts').innerHTML = cnts(); rebind(); });
  rebind();
  // Каскад: компания → сделки
  const dealSel = $('#w_deal');
  $('#w_company').onchange = async (ev) => {
    const cid = ev.target.value;
    if (!$('#w_title').value) {
      const opt = ev.target.selectedOptions[0];
      // авто-подставим название по компании, если пусто
    }
    if (!cid) { dealSel.innerHTML = '<option value="">— сначала выберите компанию —</option>'; dealSel.disabled = true; return; }
    dealSel.disabled = true; dealSel.innerHTML = '<option>Загрузка…</option>';
    let deals = { items: [] };
    try { deals = await api('/crm/deals?companyId=' + encodeURIComponent(cid)); } catch (e) {}
    const opts = ['<option value="">— выберите сделку —</option>']
      .concat((deals.items || []).map(d => `<option value="${esc(d.id)}" data-title="${esc(d.title)}">${esc(d.title)}</option>`));
    if ((deals.items || []).length === 0) opts.push('<option value="" disabled>у компании нет сделок</option>');
    dealSel.innerHTML = opts.join(''); dealSel.disabled = false;
  };
  $('#w_cancel').onclick = () => m.remove();
  m.onclick = (e) => { if (e.target === m) m.remove(); };
  $('#w_ok').onclick = async () => {
    const cOpt = $('#w_company').selectedOptions[0];
    const dOpt = $('#w_deal').selectedOptions[0];
    const companyTitle = cOpt ? (cOpt.dataset.title || '') : '';
    const dealTitle = dOpt ? (dOpt.dataset.title || '') : '';
    const title = $('#w_title').value || (dealTitle || ('Смета — ' + companyTitle)) || 'Новая смета';
    const body = {
      title,
      companyId: $('#w_company').value ? Number($('#w_company').value) : null,
      company: companyTitle,
      dealId: $('#w_deal').value ? Number($('#w_deal').value) : null,
      dealTitle,
      countryId: sel,
    };
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
  const cur = e.versions.length ? e.versions[e.versions.length - 1] : null;
  const verRows = e.versions.slice().reverse().map((v, i) => `<div class="vrow">
    <div class="vn ${i === 0 ? 'cur' : ''} serif">v${v.number}</div>
    <div><div class="co">${esc(v.comment || '—')}</div><div class="sub">${esc((v.createdAt || '').slice(0, 10))} · ${esc(v.author)} · ${money(v.totalAmount, v.currency)}</div></div>
    <div class="vacts">
      <button class="btn sm ghost" data-act="excel" data-v="${v.number}">Excel</button>
      <button class="btn sm ghost" data-act="kp" data-v="${v.number}">КП</button>
      <button class="btn sm ghost" data-act="contract" data-v="${v.number}">Договор</button>
    </div></div>`).join('') || '<p class="sub" style="padding:8px 0">Версий пока нет. Сохраните версию в конструкторе.</p>';

  $('#app').innerHTML = `<div class="phead"><div><span class="eyebrow">Карточка · ${esc(e.id)}</span>
    <h1>${esc(e.title)}</h1></div>${statusTag(e.status)}</div>
    <div class="grid2">
      <div class="info"><div class="kv">
        <div class="cell"><div class="k">Сделка</div><div class="val">${e.dealTitle ? esc(e.dealTitle) : ''}${e.dealId ? ' · #' + e.dealId : (e.dealTitle ? '' : '—')}</div></div>
        <div class="cell"><div class="k">Компания</div><div class="val">${esc(e.company || '—')}</div></div>
        <div class="cell"><div class="k">Контакт</div><div class="val">${esc(e.contact || '—')}</div></div>
        <div class="cell"><div class="k">Ответственный</div><div class="val">${esc(e.responsible)}</div></div>
        <div class="cell"><div class="k">Страна · валюта</div><div class="val">${esc((App.boot.countries.find(c => c.id === e.countryId) || {}).name || '')} · ${esc(e.currency)}</div></div>
        <div class="cell"><div class="k">Ставка часа</div><div class="val tnum">${fmt(e.rate)} ${esc(e.currency)} / ч</div></div>
        <div class="cell"><div class="k">Создана</div><div class="val">${esc((e.createdAt || '').slice(0, 10))} · ${esc(e.createdBy)}</div></div>
        <div class="cell"><div class="k">Изменена</div><div class="val">${esc((e.updatedAt || '').slice(0, 10))} · ${esc(e.updatedBy)}</div></div>
      </div></div>
      <div class="aside">
        <div><div class="eyebrow">Сумма (текущий черновик)</div><div class="bignum tnum">${fmt(r.total)} <small>${esc(e.currency)}</small></div></div>
        <hr class="hair">
        <div style="display:flex;justify-content:space-between"><span class="sub">Активных этапов</span><span class="tnum co">${e.draft.stages.filter(s => s.on).length} из ${e.draft.stages.length}</span></div>
        <div style="display:flex;justify-content:space-between"><span class="sub">Часы клиенту · исполнителю</span><span class="tnum co">${r.hoursClient} · ${r.hoursExecutor}</span></div>
        <div style="display:flex;justify-content:space-between"><span class="sub">Срок реализации</span><span class="tnum co">${r.durationDays} дн.</span></div>
        <hr class="hair">
        <button class="btn prim" id="editBtn">Открыть конструктор</button>
        <button class="btn ghost" id="apprBtn">Отправить на согласование</button>
      </div>
    </div>
    <div class="phead" style="margin-top:34px"><div><span class="eyebrow">Версии</span></div></div>
    <div class="panel" style="padding:8px 24px">${verRows}</div>`;

  $('#editBtn').onclick = () => location.hash = '#/edit/' + e.id;
  $('#apprBtn').onclick = async () => { await api('/estimates/' + e.id + '/status', { method: 'POST', body: JSON.stringify({ status: 'on_approval' }) }); toast('Отправлено на согласование'); viewCard(e.id); };
  $('#app').querySelectorAll('[data-act]').forEach(b => b.onclick = () => docAction(b.dataset.act, e, Number(b.dataset.v)));
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
    await api('/estimates/' + e.id + '/draft', { method: 'PUT', body: JSON.stringify({ stages: e.draft.stages, lines: e.draft.lines }) });
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
    body += `<tr class="stagehdr"><td></td><td class="tnum">${si + 1}</td><td colspan="5">${esc(stageTitle(s.code))}</td><td class="r num">${fmt(stageTotal)}</td>
      <td class="r"><button class="btn sm ghost" data-add="${s.code}">+ строка</button></td></tr>`;
    tops.forEach((l, li) => {
      body += rowHtml(l, `${si + 1}.${li + 1}`, r, l.isGroup);
      const kids = lines.filter(c => c.parentId === l.id);
      kids.forEach((c, ci) => { body += rowHtml(c, `${si + 1}.${li + 1}.${ci + 1}`, r, false); });
    });
  });

  $('#app').innerHTML = `<div class="phead"><div><span class="eyebrow">Конструктор · ${esc(e.id)}</span>
      <h1>${esc(e.title)}</h1>
      <p class="dek">Ставка ${fmt(rate)} ${esc(e.currency)}/ч · <span id="saveState" class="sub">черновик</span></p></div>
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
    </div>`;

  $('#backBtn').onclick = () => location.hash = '#/e/' + e.id;
  $('#saveVer').onclick = saveVersion;
  $('#fromCat').onclick = openCatalogPicker;
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
function rowHtml(l, no, r, isGroup) {
  const amt = r.amountById[l.id] || 0;
  const lvlClass = l.parentId == null ? 'lvl-2' : 'lvl-3';
  if (isGroup) {
    return `<tr class="${lvlClass} grp"><td></td><td class="tnum sub">${no}</td>
      <td class="nm"><input data-id="${l.id}" data-field="name" value="${esc(l.name)}" style="font-weight:700"></td>
      <td colspan="4" class="sub">Группа услуг</td><td class="r num co" data-amt="${l.id}">${fmt(amt)}</td>
      <td class="r"><span class="del" data-del="${l.id}">✕</span></td></tr>`;
  }
  return `<tr class="${lvlClass}"><td></td><td class="tnum sub">${no}</td>
    <td class="nm"><input data-id="${l.id}" data-field="name" value="${esc(l.name)}"></td>
    <td><input data-id="${l.id}" data-field="description" value="${esc(l.description || '')}"></td>
    <td class="r"><input class="r qty" data-id="${l.id}" data-field="qty" value="${l.qty == null ? '' : l.qty}"></td>
    <td class="r"><input class="r hrs" data-id="${l.id}" data-field="hoursExecutor" value="${l.hoursExecutor == null ? '' : l.hoursExecutor}"></td>
    <td class="r"><input class="r hrs" data-id="${l.id}" data-field="hoursClient" value="${l.hoursClient == null ? '' : l.hoursClient}"></td>
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
  // обновить итоги этапов
  const stages = e.draft.stages.filter(s => s.on).sort((a, b) => a.order - b.order);
  $('#app').querySelectorAll('.stagehdr').forEach((tr, i) => {
    const code = stages[i] && stages[i].code; if (!code) return;
    tr.querySelector('.num').textContent = fmt(r.stageTotals[code] || 0);
  });
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
  const comment = prompt('Комментарий к версии:', '');
  if (comment === null) return;
  const e = App.estimate;
  await api('/estimates/' + e.id + '/draft', { method: 'PUT', body: JSON.stringify({ stages: e.draft.stages, lines: e.draft.lines }) });
  await api('/estimates/' + e.id + '/versions', { method: 'POST', body: JSON.stringify({ comment }) });
  toast('Версия сохранена'); location.hash = '#/e/' + e.id;
}
function openCatalogPicker() {
  const m = document.createElement('div'); m.className = 'modal';
  const items = App.boot.catalog.map(c => `<tr><td class="co">${esc(c.name)}</td><td class="sub">${esc(c.category)}</td>
    <td class="r sub tnum">${c.hoursClient} ч</td><td class="r"><button class="btn sm" data-cid="${c.id}">＋</button></td></tr>`).join('');
  m.innerHTML = `<div class="box" style="width:min(720px,94vw)"><h3>Каталог типовых работ</h3>
    <div class="tblwrap" style="max-height:60vh;overflow:auto"><table><thead><tr><th>Услуга</th><th>Категория</th><th class="r">Клиент</th><th></th></tr></thead>
    <tbody>${items}</tbody></table></div>
    <div class="acts"><button class="btn ghost" id="cp_close">Закрыть</button></div></div>`;
  document.body.appendChild(m);
  $('#cp_close').onclick = () => m.remove();
  m.onclick = (ev) => { if (ev.target === m) m.remove(); };
  m.querySelectorAll('[data-cid]').forEach(b => b.onclick = async () => {
    await api('/estimates/' + App.estimate.id + '/catalog-insert', { method: 'POST', body: JSON.stringify({ catalogItemId: b.dataset.cid }) });
    const fresh = await api('/estimates/' + App.estimate.id); App.estimate = fresh;
    toast('Добавлено в смету'); renderEditor();
  });
}

/* ---------- Каталог (страница) ---------- */
function viewCatalog() {
  const cats = [...new Set(App.boot.catalog.map(c => c.category))];
  $('#app').innerHTML = `<div class="phead"><div><span class="eyebrow">Каталог</span><h1>Типовые работы</h1>
    <p class="dek">Единая база знаний по услугам с оценкой часов. Добавление в смету — из конструктора.</p></div></div>
    ${cats.map(cat => `<div class="phead" style="margin:22px 0 12px"><span class="eyebrow">${esc(cat)}</span></div>
      <div class="catgrid">${App.boot.catalog.filter(c => c.category === cat).map(c => `<div class="card">
        <div class="nm">${esc(c.name)}</div><div class="ds">${esc(c.description)}</div>
        <div class="mt"><span class="chz">Исп. <b>${c.hoursExecutor} ч</b> · Клиент <b>${c.hoursClient} ч</b></span></div></div>`).join('')}</div>`).join('')}`;
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
  // клиентское представление: по этапам, без часов, только стоимость
  const r = recalc(e.draft, e.rate);
  const out = [];
  e.draft.stages.filter(s => s.on).sort((a, b) => a.order - b.order).forEach((s, si) => {
    const lines = e.draft.lines.filter(l => l.stage === s.code);
    out.push({ no: `${si + 1}`, name: stageTitle(s.code), amount: r.stageTotals[s.code] || 0, lvl: 1 });
    const tops = lines.filter(l => l.parentId == null);
    tops.forEach((l, li) => {
      out.push({ no: `${si + 1}.${li + 1}`, name: l.name, desc: l.description, qty: l.qty, amount: r.amountById[l.id] || 0, lvl: 2, grp: l.isGroup });
      lines.filter(c => c.parentId === l.id).forEach((c, ci) => out.push({ no: `${si + 1}.${li + 1}.${ci + 1}`, name: c.name, desc: c.description, qty: c.qty, amount: r.amountById[c.id] || 0, lvl: 3 }));
    });
  });
  return { rows: out, total: r.total, days: r.durationDays };
}
function docAction(act, e, vnum) {
  if (act === 'excel') return exportCSV(e);
  if (act === 'kp') return openKP(e);
  if (act === 'contract') return openContract(e);
}
function exportCSV(e) {
  const { rows, total } = clientRows(e);
  let csv = '﻿№;Наименование;Описание;Кол-во;Стоимость;Валюта\n';
  rows.forEach(r => { csv += `${r.no};"${(r.name || '').replace(/"/g, '""')}";"${(r.desc || '').replace(/"/g, '""')}";${r.qty == null ? '' : r.qty};${Math.round(r.amount)};${e.currency}\n`; });
  csv += `;ИТОГО;;;${Math.round(total)};${e.currency}\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `Смета_${e.id}.csv`; a.click();
  toast('Excel/CSV выгружен');
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
  $('#who').innerHTML = `<b>${esc(App.boot.me.name)}</b><br>${esc(App.boot.me.portal)}`;
  window.addEventListener('hashchange', router);
  router();
})();
