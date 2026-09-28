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

function xlsxRows(buf) {
  const zip = readZip(buf);
  const get = (name) => { const b = zip.get(name); return b ? b.toString('utf8') : null; };
  // первый лист книги (по порядку в workbook.xml)
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = get('xl/workbook.xml'), rels = get('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const sm = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb);
    if (sm) {
      const re = new RegExp('<Relationship\\b[^>]*\\bId="' + sm[1] + '"[^>]*>');
      const rm = re.exec(rels);
      const tm = rm && /\bTarget="([^"]+)"/.exec(rm[0]);
      if (tm) sheetPath = tm[1].charAt(0) === '/' ? tm[1].slice(1) : 'xl/' + tm[1].replace(/^\.\//, '');
    }
  }
  const sheet = get(sheetPath) || get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('В файле не найден лист с данными');
  const sst = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) ss.replace(/<si\b[^>]*>([\s\S]*?)<\/si>/g, (m, x) => { sst.push(richText(x)); return m; });

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

function fileRows(buf, fileName) {
  const name = String(fileName || '').toLowerCase();
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (isZip) return xlsxRows(buf);
  if (/\.xls$/.test(name) || (buf[0] === 0xD0 && buf[1] === 0xCF)) {
    throw new Error('Формат .xls (Excel 97–2003) не поддерживается — сохраните файл как .xlsx');
  }
  return csvRows(buf);
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

const SKIP_RE = /^(итого|всего|итог)\b|^управление проектом/;

// buf — содержимое файла; opts: { rate, stages (store.stages), catalog }
function parseEstimateFile(buf, fileName, opts) {
  const rate = Number(opts.rate) || 0;
  const stageDefs = opts.stages || [];
  const catalog = opts.catalog || [];
  const rows = fileRows(buf, fileName);
  const hdr = findHeader(rows);
  if (!hdr) throw new Error('Не найдена строка заголовков: нужна колонка «Наименование» и хотя бы одна из «Кол-во», «Часы», «Стоимость», «Описание»');
  const M = hdr.map;
  const cell = (row, key) => (M[key] == null ? '' : row[M[key]]);

  const warnings = new Set();
  const lines = [];
  let curStage = null;
  let lastTop = null; // { line, noParts }
  let skippedPM = 0, unknownStageRows = 0;
  const derivedIds = new Set(), execCopiedIds = new Set();

  for (let r = hdr.index + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const name = norm(cell(row, 'name'));
    const noRaw = norm(cell(row, 'no'));
    if (!name) continue;
    const lname = low(name);
    if (SKIP_RE.test(lname)) { if (/^управление проектом/.test(lname)) skippedPM++; continue; }

    const qtyV = num(cell(row, 'qty'));
    const hExecV = num(cell(row, 'hExec'));
    const hClientV = num(cell(row, 'hClient'));
    const priceV = num(cell(row, 'price'));
    const amountV = num(cell(row, 'amount'));
    const noParts = noRaw.replace(/\.$/, '').split('.').filter(Boolean);
    const noValid = noParts.length && noParts.every((p) => /^\d+$/.test(p));

    // колонка «Этап» (если есть) — задаёт этап строки
    if (M.stage != null && norm(cell(row, 'stage'))) {
      const sc = stageByTitle(cell(row, 'stage'), stageDefs);
      if (sc) { if (sc !== curStage) lastTop = null; curStage = sc; }
    }

    // строка-заголовок этапа: № из одной цифры (или без №) и название этапа, без кол-ва/часов
    const noData = qtyV == null && hExecV == null && hClientV == null && priceV == null;
    // без нумерации — только явное название этапа, чтобы не спутать с услугой «Настройка …»
    const asStage = noData ? stageByTitle(name, stageDefs, !noValid && (amountV != null || !!norm(cell(row, 'desc')))) : null;
    if (asStage && (!noValid || noParts.length === 1)) {
      curStage = asStage; lastTop = null; continue;
    }
    if (noValid && noParts.length === 1 && noData && M.stage == null) {
      // неизвестный этап — кладём в «Настройку штатного функционала» группой
      curStage = 'setup';
      const g = { id: nid('ln'), stage: curStage, level: 2, parentId: null, name, description: norm(cell(row, 'desc')), qty: 1, hoursExecutor: 0, hoursClient: 0, isGroup: true };
      lines.push(g); lastTop = { line: g, noParts, explicitGroup: true };
      warnings.add(`Раздел «${name}» не распознан как этап — добавлен группой в «Настройка штатного функционала»`);
      continue;
    }
    if (!curStage) { curStage = 'setup'; unknownStageRows++; }

    const qty = qtyV == null ? 1 : qtyV;
    const lineId = nid('ln');
    let hClient = hClientV, hExec = hExecV;
    const cat = catalogMatch(name, catalog);
    const hasOwnHours = hClient != null || hExec != null || priceV != null || amountV != null;

    if (hClient == null) {
      if (priceV != null && rate) { hClient = round2(priceV / rate); derivedIds.add(lineId); }
      else if (amountV != null && rate && qty) { hClient = round2(amountV / rate / qty); derivedIds.add(lineId); }
    }
    if (hExec == null && hClient != null) { hExec = hClient; execCopiedIds.add(lineId); }
    if (hClient == null && hExec != null) hClient = hExec;

    const line = {
      id: lineId, stage: curStage, level: 2, parentId: null,
      name, description: norm(cell(row, 'desc')) || (cat && cat.description) || '',
      qty, hoursExecutor: hExec == null ? 0 : hExec, hoursClient: hClient == null ? 0 : hClient, isGroup: false,
    };
    if (cat && cat.formula) {
      line.formula = JSON.parse(JSON.stringify(cat.formula));
      // часы из файла сохраняем как ручные (в конструкторе можно вернуть авто-расчёт 🔄)
      if (hasOwnHours) line.manualHours = true;
      else { line.hoursExecutor = 0; line.hoursClient = 0; }
    } else if (cat && !hasOwnHours) {
      line.hoursExecutor = cat.hoursExecutor || 0; line.hoursClient = cat.hoursClient || 0;
    }

    // иерархия по нумерации: 1.2.3 — подпункт группы 1.2 того же этапа
    if (noValid && noParts.length >= 3 && lastTop && lastTop.line.stage === curStage
      && lastTop.noParts.length === noParts.length - 1
      && lastTop.noParts.every((p, i) => p === noParts[i])) {
      const parent = lastTop.line;
      if (!parent.isGroup) {
        parent.isGroup = true; parent.hoursExecutor = 0; parent.hoursClient = 0; parent.qty = 1;
        delete parent.formula; delete parent.manualHours;
      }
      line.level = 3; line.parentId = parent.id;
      lines.push(line);
      continue;
    }
    lines.push(line);
    lastTop = { line, noParts: noValid ? noParts : [] };
  }

  // группа без подпунктов (заголовок-группа) — оставляем группой
  if (!lines.some((l) => !l.isGroup)) throw new Error('В файле не найдено ни одной услуги');

  if (skippedPM) warnings.add('Строки «Управление проектом на этапе» пропущены — они считаются автоматически (15%)');
  // считаем только услуги (строки, ставшие группами, не в счёт)
  const services = new Set(lines.filter((l) => !l.isGroup && !(l.formula && !l.manualHours)).map((l) => l.id));
  const derived = [...derivedIds].filter((id) => services.has(id)).length;
  const execCopied = [...execCopiedIds].filter((id) => services.has(id)).length;
  if (derived) warnings.add(`Часы клиента для ${derived} строк рассчитаны из стоимости по ставке ${rate}/ч`);
  if (execCopied) warnings.add(`Часы исполнителя не указаны для ${execCopied} строк — приняты равными часам клиента`);
  if (unknownStageRows) warnings.add('Для строк без этапа выбран этап «Настройка штатного функционала»');

  const used = new Set(lines.map((l) => l.stage));
  const stages = stageDefs.map((s) => ({ code: s.code, on: used.has(s.code), order: s.order }));
  return {
    draft: { stages, lines },
    warnings: [...warnings],
    stats: {
      services: lines.filter((l) => !l.isGroup).length,
      groups: lines.filter((l) => l.isGroup).length,
      stages: used.size,
    },
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

module.exports = { parseEstimateFile, sanitizeDraft };
