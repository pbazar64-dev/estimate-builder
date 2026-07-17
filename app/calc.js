// Движок расчёта сметы. Маржинальность НЕ рассчитывается (по требованию заказчика).
// Формулы:
//   Цена за единицу = Ставка × Трудозатраты Клиенту
//   Стоимость строки = Ставка × Трудозатраты Клиенту × Количество
//   Итог группы/этапа = Σ дочерних стоимостей
// «Управление проектом на этапе» — автоматическая строка в каждом этапе:
//   часы = 20% от суммы часов всех пунктов этапа (отдельно исполнитель/клиент),
//   стоимость = Ставка × часы клиента (PM).
'use strict';

const PM_FACTOR = 0.2; // 20%

function computeLineAmount(line, rate) {
  const hc = Number(line.hoursClient) || 0;
  const qty = line.qty == null ? 1 : Number(line.qty) || 0;
  return rate * hc * qty;
}

// Возвращает:
//   amountById  — стоимость по каждой строке (для групп — сумма детей)
//   stageTotals — итог по этапу (пункты + Управление проектом)
//   stagePM     — { [code]: { itemsExec, itemsClient, itemsAmount, pmExec, pmClient, pmAmount, total } }
//   total, hoursClient, hoursExecutor, durationDays, pmFactor
function recalc(draft, rate) {
  const lines = draft.lines || [];
  const stages = draft.stages || [];
  const enabled = new Set(stages.filter((s) => s.on).map((s) => s.code));

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
      amountById[line.id] = sum;
      return sum;
    }
    if (line.isGroup) { amountById[line.id] = 0; return 0; }
    const a = computeLineAmount(line, rate);
    amountById[line.id] = a;
    return a;
  }
  // заполнить amountById для всех
  for (const l of lines) if (l.parentId == null) amountOf(l);
  for (const l of lines) if (!(l.id in amountById)) amountOf(l);

  // суммы часов и стоимости пунктов по этапу (только не-группы)
  const agg = {}; // code -> {exec, client, itemsAmount}
  for (const code of enabled) agg[code] = { exec: 0, client: 0, itemsAmount: 0 };
  for (const l of lines) {
    if (!enabled.has(l.stage) || l.isGroup) continue;
    const qty = l.qty == null ? 1 : Number(l.qty) || 0;
    agg[l.stage].exec += (Number(l.hoursExecutor) || 0) * qty;
    agg[l.stage].client += (Number(l.hoursClient) || 0) * qty;
  }
  // стоимость пунктов этапа = сумма amountById топ-уровневых строк этапа
  for (const l of lines) {
    if (l.parentId == null && enabled.has(l.stage)) {
      agg[l.stage].itemsAmount += amountById[l.id] || 0;
    }
  }

  // Часы «Управление проектом» округляются В БОЛЬШУЮ сторону до целого часа
  // (напр. 20% = 0,45 ч → 1 ч).
  const ceilH = (x) => Math.ceil(x - 1e-9);
  const stagePM = {};
  const stageTotals = {};
  let total = 0, hoursClient = 0, hoursExecutor = 0;

  for (const code of enabled) {
    const a = agg[code];
    const pmExec = ceilH(a.exec * PM_FACTOR);
    const pmClient = ceilH(a.client * PM_FACTOR);
    const pmAmount = rate * pmClient;
    const stageTotal = a.itemsAmount + pmAmount;
    stagePM[code] = {
      itemsExec: a.exec, itemsClient: a.client, itemsAmount: a.itemsAmount,
      pmExec, pmClient, pmAmount, total: stageTotal,
    };
    stageTotals[code] = stageTotal;
    total += stageTotal;
    hoursClient += a.client + pmClient;
    hoursExecutor += a.exec + pmExec;
  }

  const durationDays = Math.max(1, Math.round(hoursClient * 0.5));
  return { amountById, stageTotals, stagePM, total, hoursClient, hoursExecutor, durationDays, pmFactor: PM_FACTOR };
}

module.exports = { recalc, computeLineAmount, PM_FACTOR };
