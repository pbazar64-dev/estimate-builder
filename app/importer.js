'use strict';
// Импорт сметы из файла (.xlsx / .csv) → черновик конструктора { stages, lines }.
// Без внешних зависимостей: xlsx читаем встроенным ZIP-ридером (kp.js) + разбором XML.
//
// Формат файла гибкий — колонки ищутся по заголовкам:
//   № | Наименование (Этап/задача, Услуга) | Описание | Кол-во |
//   Часы исполнителя (Трудозатраты исполнителя) | Часы клиента (Трудозатраты клиенту) |
//   Цена | Стоимость (Сумма) | Этап (необязательно)
// Этапы — строками-заголовками («1 | Моделирование») или колонкой «Этап».
// Иерархия — по нумерации: «1.2» — услуга/группа, «1.2.3» — подпункт группы «1.2».
// Подходит и выгрузка Excel самого конструктора (часы восстанавливаются из стоимости).
// «Управление проектом на этапе» и «ИТОГО» пропускаются — считаются автоматически.

const { readZip } = require('./kp');
const { nid } = require('./seed');

// ---------- Табличные данные из файла ----------
function xmlDecode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
// Текст из <si>/<is>: склеиваем все <t>, кроме фонетики <rPh>
function richText(xml) {
  const clean = String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  clean.replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g, (m, t) => { out += xmlDecode(t); return m; });
  return out;
}
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return -1;
  let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Все листы книги по порядку: [{ name, rows }]
function xlsxSheets(buf) {
  const zip = readZip(buf);
  const get = (name) => { const b = zip.get(name); return b ? b.toString('utf8') : null; };
  const sst = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) ss.replace(/<si\b[^>]*>([\s\S]*?)<\/si>/g, (m, x) => { sst.push(richText(x)); return m; });
  const wb = get('xl/workbook.xml') || '', rels = get('xl/_rels/workbook.xml.rels') || '';
  const list = [];
  wb.replace(/<sheet\b[^>]*>/g, (tag) => {
    const nm = /\bname="([^"]*)"/.exec(tag), id = /\br:id="([^"]+)"/.exec(tag);
    if (/\bstate="(hidden|veryHidden)"/.test(tag) || !id) return tag;
    const rm = new RegExp('<Relationship\\b[^>]*\\bId="' + id[1] + '"[^>]*>').exec(rels);
    const tm = rm && /\bTarget="([^"]+)"/.exec(rm[0]);
    if (tm) list.push({ name: nm ? xmlDecode(nm[1]) : '', path: tm[1].charAt(0) === '/' ? tm[1].slice(1) : 'xl/' + tm[1].replace(/^\.\//, '') });
    return tag;
  });
  if (!list.length) list.push({ name: '', path: 'xl/worksheets/sheet1.xml' });
  const out = [];
  for (const sh of list) {
    const xml = get(sh.path);
    if (xml) out.push({ name: sh.name, rows: sheetRows(xml, sst) });
  }
  if (!out.length) throw new Error('В файле не найден лист с данными');
  return out;
}
function sheetRows(sheet, sst) {
  const rows = [];
  sheet.replace(/<row\b([^>]*)>([\s\S]*?)<\/row>/g, (m, rattr, inner) => {
    const rn = /\br="(\d+)"/.exec(rattr);
    const ri = rn ? Number(rn[1]) - 1 : rows.length;
    const row = [];
    let seq = 0;
    inner.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (cm, cattr, body) => {
      const ref = /\br="([A-Z]+\d+)"/.exec(cattr);
      const ci = ref ? colIndex(ref[1]) : seq;
      seq = ci + 1;
      if (!body) return cm;
      const t = (/\bt="([^"]+)"/.exec(cattr) || [])[1] || 'n';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      let val = '';
      if (t === 's') val = v ? (sst[Number(v[1])] || '') : '';
      else if (t === 'inlineStr') val = richText(body);
      else if (t === 'b') val = v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
      else if (t === 'str' || t === 'e') val = v ? xmlDecode(v[1]) : '';
      else val = v ? Number(v[1]) : '';
      row[ci] = val;
      return cm;
    });
    rows[ri] = row;
    return m;
  });
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

function decodeText(buf) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) buf = buf.subarray(3);
  const utf = buf.toString('utf8');
  if (utf.indexOf('�') === -1) return utf;
  try { return new TextDecoder('windows-1251').decode(buf); } catch (e) { return utf; } // CSV из Excel (cp1251)
}
function csvRows(buf) {
  const text = decodeText(buf);
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const cnt = (ch) => first.split(ch).length - 1;
  const delim = [';', '\t', ','].sort((a, b) => cnt(b) - cnt(a))[0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Листы файла: [{ name, rows }] (у CSV — один лист)
function fileSheets(buf, fileName) {
  const name = String(fileName || '').toLowerCase();
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (isZip) return xlsxSheets(buf);
  if (/\.xls$/.test(name) || (buf[0] === 0xD0 && buf[1] === 0xCF)) {
    throw new Error('Формат .xls (Excel 97–2003) не поддерживается — сохраните файл как .xlsx');
  }
  return [{ name: '', rows: csvRows(buf) }];
}

// ---------- Разбор сметы ----------
const norm = (s) => String(s == null ? '' : s).replace(/[ \s]+/g, ' ').trim();
const low = (s) => norm(s).toLowerCase().replace(/ё/g, 'е');
function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = norm(v).replace(/\s/g, '').replace(/[^\d,.\-]/g, '').replace(',', '.');
  if (!s || s === '-' || s === '.') return null;
  const n = Number(s); return isFinite(n) ? n : null;
}
const round2 = (x) => Math.round(x * 100) / 100;
// «1», «1.2», «2.3.10» (текстом или числом-целым)
function outlineNo(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? [String(v)] : null;
  const t = norm(v).replace(/\.$/, '');
  return /^\d+(\.\d+)*$/.test(t) ? t.split('.') : null;
}

// Этап по названию (заголовок строки или значение колонки «Этап»)
const STAGE_ALIASES = [
  { code: 'preresearch', re: /предпроект|обследован|исследован|аудит/ },
  { code: 'modeling', re: /моделир|проектир/ },
  { code: 'development', re: /разработк/ },
  { code: 'trial', re: /опэ|опытн|эксплуатац|обучен|тестир/ },
  { code: 'setup', re: /настройк|штатн|внедрен/ },
];
// strict — только точное название этапа или название, содержащее его целиком
function stageByTitle(title, stages, strict) {
  const t = low(title).replace(/^\d+[.)]?\s*/, '');
  if (!t) return null;
  const exact = stages.find((s) => low(s.title) === t);
  if (exact) return exact.code;
  const full = stages.find((s) => t.indexOf(low(s.title)) !== -1);
  if (full) return full.code;
  if (strict) return null;
  const part = stages.find((s) => low(s.title).indexOf(t) !== -1);
  if (part) return part.code;
  const a = STAGE_ALIASES.find((x) => x.re.test(t) && stages.some((s) => s.code === x.code));
  return a ? a.code : null;
}

const HEADER_TESTS = {
  no: (h) => /^(№|n|#|no\.?|номер|№ ?п\/?п)$/.test(h) || /^№/.test(h),
  stage: (h) => /^этап$|^этап проекта$|^блок$/.test(h),
  name: (h) => /наименован|этап\s*\/\s*задач|услуг|^работ|вид работ|^задача/.test(h),
  desc: (h) => /описан|комментар|состав работ/.test(h),
  qty: (h) => /кол-?\s*во|количеств/.test(h),
  hExec: (h) => /исполнит/.test(h),
  hClient: (h) => /клиент|заказчик/.test(h) || /^(часы|трудозатраты|ч\.?|часов)$/.test(h),
  price: (h) => /цена|ставк/.test(h),
  amount: (h) => /стоимост|сумма|итого/.test(h),
};
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const row = rows[r] || [];
    const map = {};
    row.forEach((cell, ci) => {
      const h = low(cell);
      if (!h || typeof cell === 'number') return;
      // порядок важен: часы исполнителя/клиента раньше «наименования» и «стоимости»
      for (const key of ['no', 'hExec', 'hClient', 'qty', 'desc', 'price', 'amount', 'stage', 'name']) {
        if (map[key] == null && HEADER_TESTS[key](h)) { map[key] = ci; break; }
      }
    });
    if (map.name != null && (map.qty != null || map.hClient != null || map.hExec != null || map.amount != null || map.desc != null)) {
      return { index: r, map };
    }
  }
  return null;
}

// Каталог: для услуг-формул (ТЗ/ЛТ/тестирование/видео) — возвращаем авто-расчёт.
function catalogMatch(name, catalog) {
  const n = low(name);
  if (!n) return null;
  const exact = catalog.find((c) => low(c.name) === n);
  if (exact) return exact;
  return catalog.find((c) => c.formula && (() => {
    const key = low(c.name).split('(')[0].trim();
    return key.length >= 8 && n.indexOf(key) === 0;
  })()) || null;
}

// Валюта расчёта из шапки файла («Валюта расчета | Тенге») → код валюты
const CURRENCY_LABELS = [
  { re: /бел|byn/, code: 'BYN' }, { re: /рос|rub|₽/, code: 'RUB' }, { re: /тенге|kzt|₸/, code: 'KZT' },
  { re: /злот|pln/, code: 'PLN' }, { re: /сум|uzs/, code: 'UZS' },
];
function sheetCurrency(rows, upTo) {
  for (let r = 0; r < upTo; r++) {
    const row = rows[r] || [];
    const i = row.findIndex((c) => /валют/.test(low(c)));
    if (i === -1) continue;
    for (let j = i + 1; j < row.length; j++) {
      const t = low(row[j]);
      if (!t) continue;
      const m = CURRENCY_LABELS.find((x) => x.re.test(t));
      return { label: norm(row[j]), code: m ? m.code : null };
    }
  }
  return null;
}

const PM_RE = /^управление проектом/;
const TOTAL_RE = /^(итого|всего|итог)(\s|$|:)/;

// Разбор одного листа. Поддерживаются:
//  • простая таблица (№ и Наименование в своих колонках);
//  • «лесенка» из шаблона Ава Тетис: номер и название сдвигаются вправо с уровнем
//    (этап — A/B, услуга — B/C, подпункт — C/D), весь каталог в листе, в смету входят
//    только строки с Количеством > 0 (услуги-формулы без количества — если стоимость > 0).
function parseSheet(rows, ctx) {
  const hdr = findHeader(rows);
  if (!hdr) return null;
  const M = hdr.map;
  const at = (row, key) => (M[key] == null ? '' : row[M[key]]);
  const dataCols = ['desc', 'qty', 'hExec', 'hClient', 'price', 'amount'].map((k) => M[k]).filter((c) => c != null && c > M.name);
  const lo = M.no != null ? Math.min(M.no, M.name) : M.name;
  const hi = dataCols.length ? Math.min(...dataCols) : M.name + 1;

  // 1) строки → узлы
  const nodes = [];
  let curStage = null, fileTotal = null, pmSkipped = 0, unknownStage = false;
  const warnings = new Set();
  for (let r = hdr.index + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    let no = null, name = '';
    for (let c = lo; c < hi; c++) {
      if (c === M.stage) continue;
      const v = row[c];
      if (v === '' || v == null) continue;
      const o = outlineNo(v);
      if (o && !no && !name) { no = o; continue; }
      if (!name && typeof v !== 'number') name = norm(v);
    }
    if (!name) continue;
    const lname = low(name);
    const v = {
      qty: num(at(row, 'qty')), hExec: num(at(row, 'hExec')), hClient: num(at(row, 'hClient')),
      price: num(at(row, 'price')), amount: num(at(row, 'amount')),
    };
    if (TOTAL_RE.test(lname)) { if (v.amount != null && fileTotal == null) fileTotal = v.amount; continue; }
    if (PM_RE.test(lname)) { pmSkipped++; continue; }

    if (M.stage != null && norm(at(row, 'stage'))) {
      const sc = stageByTitle(at(row, 'stage'), ctx.stages);
      if (sc) curStage = sc;
    }
    const noData = v.qty == null && v.hExec == null && v.hClient == null && v.price == null;
    const depth = no ? no.length : 0;
    // заголовок этапа: «1 | Моделирование» (итоговые часы/стоимость в строке этапа допустимы);
    // без номера — только явное название этапа и без количества/часов
    if (depth === 1 || (depth === 0 && noData)) {
      const sc = stageByTitle(name, ctx.stages, depth === 0 && (v.amount != null || !!norm(at(row, 'desc'))));
      if (sc) { curStage = sc; continue; }
      if (depth === 1 && noData && M.stage == null) {
        curStage = 'setup';
        nodes.push({ no, depth, name, desc: norm(at(row, 'desc')), v, stage: curStage, forcedGroup: true, children: [] });
        warnings.add(`Раздел «${name}» не распознан как этап — добавлен группой в «${ctx.stageTitle('setup')}»`);
        continue;
      }
    }
    if (!curStage) { curStage = 'setup'; unknownStage = true; }
    nodes.push({ no, depth, name, desc: norm(at(row, 'desc')), v, stage: curStage, children: [] });
  }

  // 2) иерархия по нумерации: 2.3.4 — подпункт 2.3 того же этапа; подпункты раздела — в его группу
  const byKey = new Map();
  for (const n of nodes) {
    let parent = null;
    if (n.depth >= 3) parent = byKey.get(n.stage + ':' + n.no.slice(0, -1).join('.'));
    else if (n.depth === 2) { const p = byKey.get(n.stage + ':' + n.no[0]); if (p && p.forcedGroup) parent = p; }
    if (parent && !parent.parent) { n.parent = parent; parent.children.push(n); }
    if (n.no) byKey.set(n.stage + ':' + n.no.join('.'), n);
  }

  // 3) какие строки входят в смету
  let zeroSkipped = 0;
  const leafIncluded = (n) => {
    const v = n.v;
    if (v.qty === 0) return false;
    if (v.qty == null) {
      const vals = [v.hExec, v.hClient, v.price, v.amount].filter((x) => x != null);
      if (vals.length && vals.every((x) => x === 0)) return false;
      if (M.amount != null && v.amount === 0) return false;
    }
    return true;
  };
  for (const n of nodes) {
    if (n.children.length || n.forcedGroup) continue;
    n.keep = leafIncluded(n);
    if (!n.keep) zeroSkipped++;
  }
  for (const n of nodes) if (n.children.length || n.forcedGroup) n.keep = n.children.some((c) => c.keep);

  // 4) узлы → строки конструктора
  const rate = ctx.rate;
  const lines = [], idOf = new Map();
  let derived = 0, execCopied = 0;
  const implied = [];
  for (const n of nodes) {
    if (!n.keep) continue;
    const id = nid('ln');
    idOf.set(n, id);
    const parentId = n.parent ? idOf.get(n.parent) || null : null;
    if (n.children.length || n.forcedGroup) {
      lines.push({ id, stage: n.stage, level: 2, parentId: null, name: n.name, description: n.desc, qty: 1, hoursExecutor: 0, hoursClient: 0, isGroup: true });
      continue;
    }
    const v = n.v, qty = v.qty == null ? 1 : v.qty;
    let hClient = v.hClient, hExec = v.hExec;
    const hasOwn = [hClient, hExec, v.price, v.amount].some((x) => x != null);
    if (hClient == null) {
      if (v.price != null && rate) { hClient = round2(v.price / rate); derived++; }
      else if (v.amount != null && rate && qty) { hClient = round2(v.amount / rate / qty); derived++; }
    }
    if (hExec == null && hClient != null) { hExec = hClient; execCopied++; }
    if (hClient == null && hExec != null) hClient = hExec;
    if (v.amount > 0 && v.hClient > 0 && qty > 0) implied.push(v.amount / (qty * v.hClient));
    const cat = catalogMatch(n.name, ctx.catalog);
    const line = {
      id, stage: n.stage, level: parentId ? 3 : 2, parentId, name: n.name,
      description: n.desc || (cat && cat.description) || '',
      qty, hoursExecutor: hExec == null ? 0 : hExec, hoursClient: hClient == null ? 0 : hClient, isGroup: false,
    };
    if (cat && cat.formula) {
      line.formula = JSON.parse(JSON.stringify(cat.formula));
      // часы из файла сохраняем как ручные (в конструкторе можно вернуть авто-расчёт 🔄)
      if (hasOwn) line.manualHours = true;
      else { line.hoursExecutor = 0; line.hoursClient = 0; }
    } else if (cat && !hasOwn) {
      line.hoursExecutor = cat.hoursExecutor || 0; line.hoursClient = cat.hoursClient || 0;
    }
    lines.push(line);
  }
  const services = lines.filter((l) => !l.isGroup).length;
  if (!services) return { services: 0 };

  if (pmSkipped) warnings.add('Строки «Управление проектом на этапе» пропущены — они считаются автоматически (15%)');
  if (zeroSkipped && nodes.length > 20) warnings.add(`Не вошли ${zeroSkipped} строк шаблона с количеством 0 (не выбраны)`);
  if (derived) warnings.add(`Часы клиента для ${derived} строк рассчитаны из стоимости по ставке ${rate}/ч`);
  if (execCopied) warnings.add(`Часы исполнителя не указаны для ${execCopied} строк — приняты равными часам клиента`);
  if (unknownStage) warnings.add(`Для строк без этапа выбран этап «${ctx.stageTitle('setup')}»`);
  implied.sort((a, b) => a - b);
  const impliedRate = implied.length ? Math.round(implied[Math.floor(implied.length / 2)]) : null;
  const used = new Set(lines.map((l) => l.stage));
  return {
    draft: { stages: ctx.stages.map((s) => ({ code: s.code, on: used.has(s.code), order: s.order })), lines },
    warnings: [...warnings],
    stats: { services, groups: lines.length - services, stages: used.size },
    services, fileTotal, impliedRate,
    hasHours: M.hClient != null || M.hExec != null,
    currency: sheetCurrency(rows, hdr.index),
  };
}

// Страна сметы по файлу: валюта из шапки, иначе — по ставке (стоимость / часы)
function detectCountry(res, countries) {
  if (!countries || !countries.length) return null;
  if (res.currency && res.currency.code) {
    const byCur = countries.filter((c) => c.currency === res.currency.code);
    if (byCur.length === 1) return byCur[0].id;
    const exact = byCur.find((c) => res.impliedRate && c.rate === res.impliedRate);
    if (exact) return exact.id;
    if (byCur.length) return byCur[0].id;
  }
  if (res.impliedRate) {
    const byRate = countries.filter((c) => c.rate === res.impliedRate);
    if (byRate.length === 1) return byRate[0].id;
  }
  return null;
}

// buf — содержимое файла; opts: { rate, stages (store.stages), catalog, countries, sheet }
// rate может быть функцией (countryId|null) → ставка, чтобы учесть страну, найденную в файле.
function parseEstimateFile(buf, fileName, opts) {
  const stageDefs = opts.stages || [];
  const ctx = {
    stages: stageDefs, catalog: opts.catalog || [],
    stageTitle: (code) => (stageDefs.find((s) => s.code === code) || {}).title || code,
  };
  const sheets = fileSheets(buf, fileName);
  const parseAt = (rows, rate) => parseSheet(rows, Object.assign({}, ctx, { rate }));
  const baseRate = typeof opts.rate === 'function' ? opts.rate(null) : Number(opts.rate) || 0;

  const found = [];
  for (const sh of sheets) {
    let r = null;
    try { r = parseAt(sh.rows, baseRate); } catch (e) { r = null; }
    if (r && r.services) found.push({ sheet: sh, res: r });
  }
  if (!found.length) {
    throw new Error('В файле не найдено услуг. Нужна строка заголовков с колонкой «Наименование» (или «Этап/Задача») и колонками «Кол-во», «Часы» или «Стоимость»; в смету попадают строки с количеством больше 0');
  }
  // лист: выбранный пользователем, иначе — с часами, наибольшим числом услуг и суммой
  let pick = opts.sheet != null ? found.find((f) => f.sheet.name === opts.sheet) : null;
  if (!pick) {
    pick = found.slice().sort((a, b) =>
      (b.res.hasHours - a.res.hasHours) || (b.res.services - a.res.services) || ((b.res.fileTotal || 0) - (a.res.fileTotal || 0)))[0];
  }
  let res = pick.res;
  const countryId = detectCountry(res, opts.countries);
  let rate = baseRate;
  if (typeof opts.rate === 'function') {
    rate = Number(opts.rate(countryId)) || baseRate;
    if (rate !== baseRate) res = parseAt(pick.sheet.rows, rate);
  }
  const warnings = res.warnings.slice();
  if (res.impliedRate && rate && Math.abs(res.impliedRate - rate) / rate > 0.01) {
    warnings.unshift(`Ставка в файле ≈ ${res.impliedRate}/ч, в конструкторе — ${rate}/ч: стоимость пересчитана по ставке конструктора`);
  }
  if (found.length > 1) warnings.unshift(`Взят лист «${pick.sheet.name}» — другой лист можно выбрать в списке`);
  return {
    draft: res.draft, warnings, stats: res.stats,
    sheet: pick.sheet.name,
    sheets: found.map((f) => ({ name: f.sheet.name, services: f.res.services, fileTotal: f.res.fileTotal })),
    fileTotal: res.fileTotal, currency: res.currency, detectedCountryId: countryId,
  };
}

// Проверка/очистка черновика, присланного клиентом (после предпросмотра импорта).
function sanitizeDraft(d, stageDefs) {
  if (!d || !Array.isArray(d.lines) || !Array.isArray(d.stages)) return null;
  const codes = new Set(stageDefs.map((s) => s.code));
  const onSet = new Set(d.stages.filter((s) => s && s.on).map((s) => s.code));
  const stages = stageDefs.map((s) => ({ code: s.code, on: onSet.has(s.code), order: s.order }));
  const ids = new Set();
  const lines = [];
  for (const l of d.lines) {
    if (!l || !codes.has(l.stage) || !l.id || ids.has(String(l.id))) continue;
    ids.add(String(l.id));
    const n = (x) => { const v = Number(x); return isFinite(v) ? v : 0; };
    const line = {
      id: String(l.id), stage: l.stage, level: l.parentId ? 3 : 2, parentId: l.parentId ? String(l.parentId) : null,
      name: String(l.name || '').slice(0, 1000), description: String(l.description || '').slice(0, 5000),
      qty: l.qty == null ? 1 : n(l.qty), hoursExecutor: n(l.hoursExecutor), hoursClient: n(l.hoursClient), isGroup: !!l.isGroup,
    };
    if (l.formula && l.formula.base != null && isFinite(Number(l.formula.pct))) {
      line.formula = { base: Array.isArray(l.formula.base) ? l.formula.base.map(String) : String(l.formula.base), pct: Number(l.formula.pct) };
      if (l.manualHours) line.manualHours = true;
    }
    lines.push(line);
  }
  for (const l of lines) if (l.parentId && !ids.has(l.parentId)) { l.parentId = null; l.level = 2; }
  if (!lines.length) return null;
  return { stages, lines };
}

module.exports = { parseEstimateFile, sanitizeDraft, xlsxSheets };
