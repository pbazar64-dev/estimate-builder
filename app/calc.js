// Движок расчёта сметы. Маржинальность НЕ рассчитывается.
// Формулы:
//   Цена за единицу = Ставка × Трудозатраты Клиенту
//   Стоимость строки = Ставка × Трудозатраты Клиенту × Количество
//   Итог группы/этапа = Σ дочерних стоимостей
// «Управление проектом на этапе» — авто-строка: 15% от суммы услуг этапа (часов пунктов, вверх до целого).
// Формула-услуги (line.formula = { base:'setup', pct } или base:['setup','development']) —
//   часы считаются как pct × (сумма часов пунктов блоков base, без управления проектом),
//   вверх до целого. base может быть строкой (один этап) или массивом этапов (сумма).
//   Такие услуги нельзя редактировать по часам вручную.
'use strict';

const PM_FACTOR = 0.15;
const ceilH = (x) => Math.ceil(x - 1e-9); // вверх до целого часа

// Эффективные часы строки (с учётом формулы). baseSum: { [stage]: {exec, client} }
function effHours(line, baseSum) {
  // line.manualHours === true — часы введены вручную, формула отключена (пока не вернут авто)
  if (line.formula && !line.manualHours && line.formula.base != null) {
    const bases = Array.isArray(line.formula.base) ? line.formula.base : [line.formula.base];
    let exec = 0, client = 0, any = false;
    for (const code of bases) {
      const b = baseSum[code];
      if (b) { exec += b.exec; client += b.client; any = true; }
    }
    if (any) return { exec: ceilH(line.formula.pct * exec), client: ceilH(line.formula.pct * client), computed: true };
  }
  return { exec: Number(line.hoursExecutor) || 0, client: Number(line.hoursClient) || 0, computed: false };
}

function recalc(draft, rate) {
  const lines = draft.lines || [];
  const stages = draft.stages || [];
  const enabled = new Set(stages.filter((s) => s.on).map((s) => s.code));

  // 1) Базовые суммы часов по этапам (для формул) — по не-групповым, НЕ формульным строкам.
  const baseSum = {};
  for (const l of lines) {
    if (l.isGroup || l.formula) continue;
    if (!baseSum[l.stage]) baseSum[l.stage] = { exec: 0, client: 0 };
    const qty = l.qty == null ? 1 : Number(l.qty) || 0;
    baseSum[l.stage].exec += (Number(l.hoursExecutor) || 0) * qty;
    baseSum[l.stage].client += (Number(l.hoursClient) || 0) * qty;
  }

  // 2) Эффективные часы по каждой строке
  const lineHours = {};
  for (const l of lines) lineHours[l.id] = effHours(l, baseSum);

  // 3) Стоимости строк (группы = сумма детей)
  const byParent = new Map();
  for (const l of lines) {
    const key = l.parentId || `root:${l.stage}`;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(l);
  }
  const amountById = {};
  function amountOf(line) {
    const children = byParent.get(line.id) || [];
    if (children.length > 0) {
      const sum = children.reduce((a, c) => a + amountOf(c), 0);
      amountById[line.id] = sum; return sum;
    }
    if (line.isGroup) { amountById[line.id] = 0; return 0; }
    const qty = line.qty == null ? 1 : Number(line.qty) || 0;
    const a = rate * lineHours[line.id].client * qty;
    amountById[line.id] = a; return a;
  }
  for (const l of lines) if (l.parentId == null) amountOf(l);
  for (const l of lines) if (!(l.id in amountById)) amountOf(l);

  // 4) Суммы по этапам (эффективные часы, только активные)
  const agg = {};
  for (const c of enabled) agg[c] = { exec: 0, client: 0, itemsAmount: 0 };
  for (const l of lines) {
    if (!enabled.has(l.stage) || l.isGroup) continue;
    const qty = l.qty == null ? 1 : Number(l.qty) || 0;
    agg[l.stage].exec += lineHours[l.id].exec * qty;
    agg[l.stage].client += lineHours[l.id].client * qty;
  }
  for (const l of lines) if (l.parentId == null && enabled.has(l.stage)) agg[l.stage].itemsAmount += amountById[l.id] || 0;

  // 5) Управление проектом (15%, вверх) + итоги
  const stagePM = {}, stageTotals = {};
  let total = 0, hoursClient = 0, hoursExecutor = 0;
  for (const c of enabled) {
    const a = agg[c];
    const pmExec = ceilH(a.exec * PM_FACTOR), pmClient = ceilH(a.client * PM_FACTOR);
    const pmAmount = rate * pmClient, stageTotal = a.itemsAmount + pmAmount;
    stagePM[c] = {
      itemsExec: a.exec, itemsClient: a.client, itemsAmount: a.itemsAmount,
      pmExec, pmClient, pmAmount, total: stageTotal,
      stageExec: a.exec + pmExec, stageClient: a.client + pmClient, // подытог часов этапа (с управлением)
    };
    stageTotals[c] = stageTotal;
    total += stageTotal;
    hoursClient += a.client + pmClient;
    hoursExecutor += a.exec + pmExec;
  }

  const durationDays = Math.max(1, Math.round(hoursClient * 0.5));
  return { amountById, lineHours, baseSum, stageTotals, stagePM, total, hoursClient, hoursExecutor, durationDays, pmFactor: PM_FACTOR };
}

module.exports = { recalc, PM_FACTOR };
