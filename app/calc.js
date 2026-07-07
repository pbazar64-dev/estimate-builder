// Движок расчёта сметы. Маржинальность НЕ рассчитывается (по требованию заказчика).
// Формулы:
//   Цена за единицу = Ставка × Трудозатраты Клиенту
//   Стоимость строки = Ставка × Трудозатраты Клиенту × Количество
//   Итог группы/этапа = Σ дочерних стоимостей
'use strict';

function computeLineAmount(line, rate) {
  const hc = Number(line.hoursClient) || 0;
  const qty = line.qty == null ? 1 : Number(line.qty) || 0;
  return rate * hc * qty;
}

// Возвращает { amount по каждой строке (map по id), stageTotals, total, hoursClient, hoursExecutor, durationDays }
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

  const stageTotals = {};
  let total = 0, hoursClient = 0, hoursExecutor = 0;

  for (const l of lines) {
    // накопим часы только по строкам активных этапов и не-группам
    if (enabled.has(l.stage) && !l.isGroup) {
      const qty = l.qty == null ? 1 : Number(l.qty) || 0;
      hoursClient += (Number(l.hoursClient) || 0) * qty;
      hoursExecutor += (Number(l.hoursExecutor) || 0) * qty;
    }
  }

  for (const l of lines) {
    if (l.parentId == null && enabled.has(l.stage)) {
      const a = amountOf(l);
      stageTotals[l.stage] = (stageTotals[l.stage] || 0) + a;
      total += a;
    } else if (l.parentId != null) {
      amountOf(l); // заполнить amountById для дочерних
    }
  }

  // Срок реализации: эмпирически ~0.5 дня на час клиента (95 ч ≈ 48 дн. в исходной смете)
  const durationDays = Math.max(1, Math.round(hoursClient * 0.5));

  return { amountById, stageTotals, total, hoursClient, hoursExecutor, durationDays };
}

module.exports = { recalc, computeLineAmount };
