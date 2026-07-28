'use strict';
// Генерация КП в формате .docx из шаблонов (app/templates/kp_{ru,by,kz}.docx).
// Заменяет жёлтые плейсхолдеры (токены {{...}}) на данные сметы и вставляет
// таблицу сметы и таблицу графика платежей в том же виде, что и Excel-экспорт.
// Без внешних зависимостей: чтение/запись ZIP через встроенный zlib.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { recalc } = require('./calc');

// ---------- ZIP ----------
const _CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = _CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function readZip(buf) {
  let i = buf.length - 22;
  for (; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) break;
  if (i < 0) throw new Error('ZIP: EOCD not found');
  const count = buf.readUInt16LE(i + 10), cdOff = buf.readUInt32LE(i + 16);
  const entries = new Map();
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP: bad central dir');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(start, start + compSize);
    entries.set(name, method === 8 ? zlib.inflateRawSync(comp) : Buffer.from(comp));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
function writeZip(entries) {
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const parts = [], central = []; let offset = 0, cnt = 0;
  for (const [name, dataRaw] of entries) {
    const data = Buffer.isBuffer(dataRaw) ? dataRaw : Buffer.from(dataRaw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const comp = zlib.deflateRawSync(data);
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc), u32(comp.length), u32(data.length), u16(nameBuf.length), u16(0)]);
    parts.push(local, nameBuf, comp);
    central.push(Buffer.concat([Buffer.from([0x50, 0x4b, 1, 2]), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc), u32(comp.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf]));
    offset += local.length + nameBuf.length + comp.length; cnt++;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([Buffer.from([0x50, 0x4b, 5, 6]), u16(0), u16(0), u16(cnt), u16(cnt), u32(cd.length), u32(offset), u16(0)]);
  return Buffer.concat([...parts, cd, eocd]);
}

// ---------- Утилиты ----------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmtNum(n) {
  n = Math.round(Number(n) || 0);
  const s = Math.abs(n).toString(); let out = '';
  for (let i = 0; i < s.length; i++) { if (i > 0 && (s.length - i) % 3 === 0) out += ' '; out += s[i]; }
  return (n < 0 ? '-' : '') + out;
}
function fmtInt(n) { return String(Math.round(Number(n) || 0)); }
const pad2 = (x) => String(x).padStart(2, '0');
function fmtDate(d) { return d ? pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() : ''; }
function dayWord(n) { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return 'дней'; if (b === 1) return 'день'; if (b > 1 && b < 5) return 'дня'; return 'дней'; }
function parseDate(s) { if (!s) return null; const p = String(s).slice(0, 10).split('-'); return p.length === 3 ? new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])) : null; }
function addWorkingDays(date, days) { if (!date) return null; const d = new Date(date.getTime()); let a = 0; while (a < days) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) a++; } return d; }

// ---------- Данные сметы / графика (сервер) ----------
function estimateRows(snap, rate, stages) {
  const stageTitle = (code) => (stages.find((s) => s.code === code) || {}).title || code;
  const r = recalc(snap, rate);
  const out = [];
  (snap.stages || []).filter((s) => s.on).sort((a, b) => a.order - b.order).forEach((s, si) => {
    const lines = (snap.lines || []).filter((l) => l.stage === s.code);
    out.push({ no: `${si + 1}`, name: stageTitle(s.code), amount: r.stageTotals[s.code] || 0, lvl: 1 });
    const tops = lines.filter((l) => l.parentId == null);
    tops.forEach((l, li) => {
      out.push({ no: `${si + 1}.${li + 1}`, name: l.name, desc: l.description, qty: l.qty, amount: r.amountById[l.id] || 0, lvl: 2, grp: l.isGroup });
      lines.filter((c) => c.parentId === l.id).forEach((c, ci) => out.push({ no: `${si + 1}.${li + 1}.${ci + 1}`, name: c.name, desc: c.description, qty: c.qty, amount: r.amountById[c.id] || 0, lvl: 3 }));
    });
    const pm = r.stagePM[s.code];
    if (pm) out.push({ no: `${si + 1}.${tops.length + 1}`, name: 'Управление проектом на этапе', desc: 'Административное и операционное сопровождение проекта на этапе.', qty: null, amount: pm.pmAmount, lvl: 2 });
  });
  return { rows: out, total: r.total, days: r.durationDays };
}
function paymentSchedule(snap, rate, payment) {
  const r = recalc(snap, rate);
  const enabled = (snap.stages || []).filter((s) => s.on).sort((a, b) => a.order - b.order);
  const amounts = enabled.map((s) => r.stageTotals[s.code] || 0);
  const n = enabled.length, total = r.total, dur = r.durationDays;
  const opts = n <= 1 ? ['prepay', '5050'] : ['staged', '5050'];
  let mode = (payment && payment.mode) || opts[0];
  if (!opts.includes(mode)) mode = opts[0];
  const sign = parseDate(payment && payment.signDate);
  const ceilD = (x) => Math.ceil(x - 1e-9);
  const termPrev = (d) => `${d} рабочих ${dayWord(d)} с момента предыдущей оплаты`;
  const AV = '3 банковских дня с момента подписания';
  const rows = [];
  if (mode === 'prepay') {
    rows.push({ no: 1, name: 'Предоплата', sum: Math.round(total), term: AV, date: addWorkingDays(sign, 3), docs: 'Акт' });
  } else if (mode === '5050') {
    const p1 = Math.round(total * 0.5), p2 = Math.round(total) - p1;
    const d1 = addWorkingDays(sign, 3), d2 = d1 ? addWorkingDays(d1, dur) : null;
    rows.push({ no: 1, name: 'Аванс', sum: p1, term: AV, date: d1, docs: 'Акт' });
    rows.push({ no: 2, name: 'Окончательный расчёт', sum: p2, term: termPrev(dur), date: d2, docs: 'Акт' });
  } else {
    const p1 = Math.round(total * 0.5);
    const d1 = addWorkingDays(sign, 3);
    rows.push({ no: 1, name: 'Аванс', sum: p1, term: AV, date: d1, docs: 'Акт' });
    let prevSum = p1, prevDate = d1;
    if (n >= 2) {
      const t2 = ceilD(prevSum / rate / 3);
      const d2 = prevDate ? addWorkingDays(prevDate, t2) : null;
      const s2 = (amounts[1] || 0) - p1 + (amounts[0] || 0);
      rows.push({ no: 2, name: 'Доплата за этап 2', sum: s2, term: termPrev(t2), date: d2, docs: 'Акт' });
      prevSum = s2; prevDate = d2;
    }
    for (let k = 3; k <= n; k++) {
      const tk = ceilD(prevSum / rate / 3);
      const dk = prevDate ? addWorkingDays(prevDate, tk) : null;
      const sk = amounts[k - 1] || 0;
      rows.push({ no: k, name: 'Предоплата за этап ' + k, sum: sk, term: termPrev(tk), date: dk, docs: 'Акт' });
      prevSum = sk; prevDate = dk;
    }
  }
  return { rows };
}

// ---------- Построение таблиц WordprocessingML ----------
// cell: { t, bold, align('left'|'center'|'right'|'both'), span }
function tableXml(cols, rows, o) {
  const font = o.font, sz = o.sz, bsz = o.borderSz;
  const border = (tag) => `<w:${tag} w:val="single" w:sz="${bsz}" w:space="0" w:color="auto"/>`;
  const borders = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>`;
  const grid = `<w:tblGrid>${cols.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  const tblPr = `<w:tblPr><w:tblW w:w="${cols.reduce((a, b) => a + b, 0)}" w:type="dxa"/>${borders}<w:tblLayout w:type="fixed"/><w:tblLook w:val="0000"/></w:tblPr>`;
  const rowsXml = rows.map((cells) => {
    let ci = 0;
    const cellsXml = cells.map((c) => {
      const span = c.span || 1;
      let w = 0; for (let k = 0; k < span && ci + k < cols.length; k++) w += cols[ci + k];
      ci += span;
      const align = c.align || 'left';
      const rpr = `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>${c.bold ? '<w:b/>' : ''}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>`;
      const ppr = `<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="${align}"/><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>${c.bold ? '<w:b/>' : ''}<w:sz w:val="${sz}"/></w:rPr></w:pPr>`;
      const txt = (c.t == null || c.t === '') ? '' : `<w:r>${rpr}<w:t xml:space="preserve">${esc(c.t)}</w:t></w:r>`;
      const tcPr = `<w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}<w:vAlign w:val="center"/></w:tcPr>`;
      return `<w:tc>${tcPr}<w:p>${ppr}${txt}</w:p></w:tc>`;
    }).join('');
    return `<w:tr>${cellsXml}</w:tr>`;
  }).join('');
  return `<w:tbl>${tblPr}${grid}${rowsXml}</w:tbl>`;
}
function estimateTableXml(est) {
  const cols = [600, 2500, 3900, 850, 1500];
  const rows = [];
  rows.push([
    { t: '№', bold: 1, align: 'center' }, { t: 'Этап/задача', bold: 1, align: 'center' },
    { t: 'Описание', bold: 1, align: 'center' }, { t: 'Кол-во', bold: 1, align: 'center' }, { t: 'Стоимость', bold: 1, align: 'center' },
  ]);
  est.rows.forEach((r) => {
    if (r.lvl === 1) {
      rows.push([
        { t: r.no, bold: 1, align: 'center' }, { t: r.name, bold: 1, align: 'left', span: 2 },
        { t: '', align: 'center' }, { t: fmtInt(r.amount), bold: 1, align: 'right' },
      ]);
    } else {
      const noQty = (r.qty == null || r.grp);
      rows.push([
        { t: r.no, align: 'center' }, { t: r.name, bold: !!r.grp, align: 'left' }, { t: r.desc || '', align: 'left' },
        { t: noQty ? '' : String(r.qty), align: 'center' }, { t: fmtInt(r.amount), align: 'right' },
      ]);
    }
  });
  rows.push([{ t: 'ИТОГО', bold: 1, align: 'right', span: 4 }, { t: fmtInt(est.total), bold: 1, align: 'right' }]);
  return tableXml(cols, rows, { font: 'Calibri', sz: 20, borderSz: 4 });
}
function paymentTableXml(pay, currency) {
  const cols = [700, 2400, 1600, 2200, 1400, 1050];
  const rows = [];
  rows.push([
    { t: '№ п/п', bold: 1, align: 'center' }, { t: 'Наименование', bold: 1, align: 'center' },
    { t: 'Сумма, ' + currency, bold: 1, align: 'center' }, { t: 'Срок', bold: 1, align: 'center' },
    { t: 'Ориентировочная дата', bold: 1, align: 'center' }, { t: 'Документы', bold: 1, align: 'center' },
  ]);
  pay.rows.forEach((p) => {
    rows.push([
      { t: String(p.no), align: 'center' }, { t: p.name, align: 'left' },
      { t: p.sum != null ? fmtNum(p.sum) : '', align: 'right' }, { t: p.term, align: 'left' },
      { t: p.date ? fmtDate(p.date) : '', align: 'center' }, { t: p.docs, align: 'center' },
    ]);
  });
  return tableXml(cols, rows, { font: 'Times New Roman', sz: 22, borderSz: 12 });
}

// Заменить абзац, содержащий токен, на XML таблицы
function replaceParaWithTable(doc, token, tableXmlStr) {
  const idx = doc.indexOf(token);
  if (idx < 0) return doc;
  const re = /<w:p(?=[ >\/])/g; let start = -1, m;
  while ((m = re.exec(doc)) && m.index < idx) start = m.index;
  if (start < 0) return doc;
  const endTag = '</w:p>';
  const end = doc.indexOf(endTag, idx);
  if (end < 0) return doc;
  // после таблицы обязателен абзац (ячейка/тело не могут заканчиваться таблицей, две таблицы не могут быть смежными)
  return doc.slice(0, start) + tableXmlStr + '<w:p/>' + doc.slice(end + endTag.length);
}

const TEMPLATE_BY_COUNTRY = { ru: 'kp_ru.docx', by: 'kp_by.docx', kz: 'kp_kz.docx' };
function buildKP(e, snap, stages, templatesDir) {
  const file = TEMPLATE_BY_COUNTRY[e.countryId] || 'kp_ru.docx';
  const entries = readZip(fs.readFileSync(path.join(templatesDir, file)));
  const docEntry = entries.get('word/document.xml');
  if (!docEntry) throw new Error('template has no document.xml');
  let doc = docEntry.toString('utf8');

  const est = estimateRows(snap, e.rate, stages);
  const pay = paymentSchedule(snap, e.rate, e.payment);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const valid = new Date(today.getTime() + 14 * 86400000);

  doc = replaceParaWithTable(doc, '{{KP_ESTIMATE_TABLE}}', estimateTableXml(est));
  doc = replaceParaWithTable(doc, '{{KP_PAYMENT_TABLE}}', paymentTableXml(pay, e.currency));
  doc = doc.split('{{KP_DATE}}').join(esc(fmtDate(today)))
    .split('{{KP_VALID}}').join(esc(fmtDate(valid)))
    .split('{{KP_COMPANY}}').join(esc(e.company || ''))
    .split('{{KP_SUM}}').join(esc(fmtNum(est.total)))
    .split('{{KP_DAYS}}').join(esc(est.days + ' рабочих ' + dayWord(est.days)));

  entries.set('word/document.xml', Buffer.from(doc, 'utf8'));
  return writeZip(entries);
}

// ================= ДОГОВОР =================
const _ONES = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const _ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const _TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const _HUND = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
function plural(n, f) { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return f[2]; if (b === 1) return f[0]; if (b > 1 && b < 5) return f[1]; return f[2]; }
function _triple(num, fem) {
  const w = []; const h = Math.floor(num / 100), t = Math.floor((num % 100) / 10), o = num % 10;
  if (h) w.push(_HUND[h]);
  if (t > 1) { w.push(_TENS[t]); if (o) w.push((fem ? _ONES_F : _ONES)[o]); }
  else { const to = num % 100; if (to) w.push((fem ? _ONES_F : _ONES)[to]); }
  return w.join(' ');
}
function num2wordsRu(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n === 0) return 'ноль';
  const g = []; let x = n; while (x > 0) { g.push(x % 1000); x = Math.floor(x / 1000); }
  const parts = [];
  for (let i = g.length - 1; i >= 0; i--) {
    if (!g[i]) continue;
    if (i === 0) parts.push(_triple(g[i], false));
    else if (i === 1) { parts.push(_triple(g[i], true)); parts.push(plural(g[i], ['тысяча', 'тысячи', 'тысяч'])); }
    else if (i === 2) { parts.push(_triple(g[i], false)); parts.push(plural(g[i], ['миллион', 'миллиона', 'миллионов'])); }
    else { parts.push(_triple(g[i], false)); parts.push(plural(g[i], ['миллиард', 'миллиарда', 'миллиардов'])); }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function curMain(cur, n) {
  if (cur === 'KZT') return 'тенге';
  if (cur === 'BYN') return plural(n, ['белорусский рубль', 'белорусских рубля', 'белорусских рублей']);
  return plural(n, ['рубль', 'рубля', 'рублей']);
}
function curShort(cur, n) { return cur === 'KZT' ? 'тенге' : plural(n, ['рубль', 'рубля', 'рублей']); }
function kopWord(cur) { return cur === 'KZT' ? 'тиын' : 'копеек'; }
function sumInWords(total, currency) {
  const n = Math.round(Number(total) || 0);
  return fmtNum(n) + ',00 (' + cap(num2wordsRu(n)) + ' ' + curMain(currency, n) + ' 00 ' + kopWord(currency) + ')';
}
function shortFio(fio) {
  const p = String(fio || '').trim().split(/\s+/).filter(Boolean);
  if (p.length <= 1) return fio || '';
  return p[0] + ' ' + p.slice(1).map((x) => x.charAt(0).toUpperCase() + '.').join(' ');
}
function dateRuLong(d) { return d ? d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' г.' : ''; }
function stagesText(snap, rate, stages, currency) {
  const stageTitle = (code) => (stages.find((s) => s.code === code) || {}).title || code;
  const r = recalc(snap, rate);
  return (snap.stages || []).filter((s) => s.on).sort((a, b) => a.order - b.order).map((s, i) => {
    const amt = r.stageTotals[s.code] || 0;
    return `Этап ${i + 1} (${stageTitle(s.code)}, п.${i + 1}): ${fmtNum(amt)} ${curShort(currency, amt)}.`;
  });
}
function replaceTokenMultiline(doc, token, lines) {
  if (doc.indexOf(token) < 0) return doc;
  if (!lines.length) return doc.split(token).join('');
  const joined = lines.map(esc).join('</w:t><w:br/><w:t xml:space="preserve">');
  return doc.split(token).join(joined);
}
function removeParasWithToken(doc, token) {
  let idx;
  while ((idx = doc.indexOf(token)) >= 0) {
    const re = /<w:p(?=[ >\/])/g; let start = -1, m;
    while ((m = re.exec(doc)) && m.index < idx) start = m.index;
    const end = doc.indexOf('</w:p>', idx);
    if (start < 0 || end < 0) { doc = doc.split(token).join(''); break; }
    doc = doc.slice(0, start) + doc.slice(end + 6);
  }
  return doc;
}
const CONTRACT_BY_COUNTRY = { ru: 'dg_ru.docx', by: 'dg_by.docx', kz: 'dg_kz.docx' };
function buildContract(e, snap, stages, form, templatesDir) {
  const file = CONTRACT_BY_COUNTRY[e.countryId] || 'dg_ru.docx';
  const entries = readZip(fs.readFileSync(path.join(templatesDir, file)));
  const docEntry = entries.get('word/document.xml');
  if (!docEntry) throw new Error('template has no document.xml');
  let doc = docEntry.toString('utf8');

  const est = estimateRows(snap, e.rate, stages);
  const pay = paymentSchedule(snap, e.rate, e.payment);
  const signDate = parseDate(form.date) || (function () { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; })();
  const fio = (form.fio || '').trim();
  const post = (form.post || '').trim();
  const days = est.days;

  doc = replaceParaWithTable(doc, '{{DG_ESTIMATE_TABLE}}', estimateTableXml(est));
  doc = replaceParaWithTable(doc, '{{DG_PAYMENT_TABLE}}', paymentTableXml(pay, e.currency));
  doc = replaceTokenMultiline(doc, '{{DG_STAGES}}', stagesText(snap, e.rate, stages, e.currency));
  doc = removeParasWithToken(doc, '{{DG_STAGES_DROP}}');

  const rep = {
    '{{DG_NUMBER}}': esc(form.number || ''),
    '{{DG_DATE}}': esc(dateRuLong(signDate)),
    '{{DG_COMPANY_FULL}}': esc(form.companyFull || e.company || ''),
    '{{DG_COMPANY_SHORT}}': esc(e.company || form.companyFull || ''),
    '{{DG_POST_GEN}}': esc(post),
    '{{DG_POST}}': esc(post),
    '{{DG_FIO_GEN}}': esc(fio),
    '{{DG_FIO_SHORT}}': esc(shortFio(fio)),
    '{{DG_CONTACT_FIO}}': esc(form.contactFio || fio),
    '{{DG_CONTACT_PHONE}}': esc(form.phone || ''),
    '{{DG_CONTACT_EMAIL}}': esc(form.email || ''),
    '{{DG_DAYS}}': esc(days + ' (' + num2wordsRu(days) + ') рабочих ' + plural(days, ['день', 'дня', 'дней'])),
    '{{DG_SUM_WORDS}}': esc(sumInWords(est.total, e.currency)),
  };
  for (const k in rep) doc = doc.split(k).join(rep[k]);

  entries.set('word/document.xml', Buffer.from(doc, 'utf8'));
  return writeZip(entries);
}

module.exports = { buildKP, buildContract, TEMPLATE_BY_COUNTRY, CONTRACT_BY_COUNTRY };
