/**
 * The arithmetic that decides whether any strategy on this timeframe can work
 * — before a single indicator is considered.
 *
 * Costs are charged as a fraction of PRICE. Results are measured in R, a
 * fraction of the STOP DISTANCE. So the toll a trade pays, expressed in R, is:
 *
 *     costR  =  round-trip cost %  /  stop distance %
 *
 * That ratio is the whole story, and it is fixed by the timeframe and the stop
 * multiple, not by the signal. On 1h candles an ATR-scaled stop is on the order
 * of 1–2% of price, and a round trip costs about 0.2%, so every trade starts
 * roughly 0.13R in the hole. An edge has to exceed that before it earns
 * anything at all — and 0.13R per trade is a very large edge by any published
 * standard.
 *
 * This is the most useful thing measured in the whole project, because it
 * disqualifies a design before any work is spent on the signal logic. Widening
 * the stop or moving to a slower timeframe changes the denominator by a factor
 * of several; tuning thresholds does not change it at all.
 */
import { summarize, netR, COSTS } from './backtest.js';
import { atr } from './indicators.js';
import { config } from './config.js';

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* --------------------------- Cost sensitivity ------------------------- */

/**
 * How much of the result is fees and slippage?
 *
 * Exits do not move when costs change — a stop is hit at the same price
 * regardless — so every trade can simply be re-priced. The interesting number
 * is the frictionless one: if a strategy loses money at zero cost, execution
 * was never the problem and no cheaper venue will save it.
 */
export function costSensitivity(trades, levels = null) {
  if (!trades.length) return null;
  const priced = (costs) => summarize(trades.map((t) => ({
    ...t,
    r: netR({ direction: t.direction, entry: t.entry, stop: t.stop, exit: t.exit }, costs),
  })));

  const rows = (levels || [
    { label: 'Без издержек', feeRate: 0, slippageRate: 0 },
    { label: 'Половина текущих', feeRate: COSTS.feeRate / 2, slippageRate: COSTS.slippageRate / 2 },
    { label: 'Текущие', feeRate: COSTS.feeRate, slippageRate: COSTS.slippageRate },
    { label: 'Вдвое выше', feeRate: COSTS.feeRate * 2, slippageRate: COSTS.slippageRate * 2 },
  ]).map((l) => {
    const s = priced(l);
    return {
      label: l.label, feeRate: l.feeRate, slippageRate: l.slippageRate,
      avgR: s.avgR, totalR: s.totalR, winRate: s.winRate, profitFactor: s.profitFactor,
    };
  });

  const free = rows.find((r) => r.feeRate === 0 && r.slippageRate === 0);
  const current = rows.find((r) => r.label === 'Текущие');

  let text = null;
  if (free && current) {
    const eaten = free.totalR - current.totalR;
    if (free.totalR <= 0) {
      text = `Даже при нулевых издержках стратегия теряет ${Math.abs(free.totalR).toFixed(1)}R. ` +
        'Комиссия и проскальзывание тут ни при чём — дешёвая биржа не спасёт то, ' +
        'у чего нет преимущества до всяких издержек.';
    } else if (current.totalR > 0) {
      text = `Преимущество переживает издержки: ${free.totalR.toFixed(1)}R без них и ` +
        `${current.totalR.toFixed(1)}R с ними. Комиссия и проскальзывание съедают ` +
        `${eaten.toFixed(1)}R — это ${((eaten / free.totalR) * 100).toFixed(0)}% сырого результата, ` +
        'и настолько же чувствителен итог к качеству исполнения.';
    } else {
      text = `Преимущество есть до издержек (${free.totalR.toFixed(1)}R), но они его съедают ` +
        `целиком: с текущими выходит ${current.totalR.toFixed(1)}R. Это вопрос исполнения — ` +
        'более дешёвая площадка или менее частые входы могут изменить исход, ' +
        'в отличие от случая, когда минус есть и без издержек.';
    }
  }

  return { rows, text, frictionlessTotalR: free?.totalR ?? null };
}

/* ------------------------------- The toll ----------------------------- */

/** Round-trip cost as a fraction of price: two fees and two slippages. */
export function roundTripCost(costs = COSTS) {
  return costs.feeRate * 2 + costs.slippageRate * 2;
}

/**
 * The toll actually paid, measured from the trades themselves rather than
 * assumed: the median stop distance decides it.
 */
export function tollFromTrades(trades, costs = COSTS) {
  const risks = trades
    .map((t) => Math.abs(t.entry - t.stop) / t.entry)
    .filter((v) => Number.isFinite(v) && v > 0);
  if (!risks.length) return null;

  const riskPct = median(risks);
  const trip = roundTripCost(costs);
  const costR = trip / riskPct;
  return {
    medianRiskPct: riskPct * 100,
    roundTripPct: trip * 100,
    costR,
    /*
     * What a strategy has to produce, per trade, before costs, merely to end
     * at zero. Quoting it in R makes it directly comparable to any published
     * edge — and shows how demanding this design is.
     */
    breakEvenEdgeR: costR,
  };
}

/**
 * The same toll at other timeframes, computed from real volatility.
 *
 * The point is the denominator: a stop scaled to a 1d ATR is several times
 * wider than one scaled to a 1h ATR, so the identical fee becomes a far
 * smaller share of the risk. This is the one lever in the design that moves
 * the arithmetic by a factor rather than a few percent.
 */
export function tollByTimeframe(candlesByTimeframe, {
  atrMult = config.strategy.atrStopMult, costs = COSTS, period = 14,
} = {}) {
  const trip = roundTripCost(costs);
  const rows = [];

  for (const [timeframe, bySymbol] of Object.entries(candlesByTimeframe)) {
    const pcts = [];
    for (const candles of Object.values(bySymbol)) {
      if (!candles || candles.length < period + 5) continue;
      const a = atr(candles.map((c) => c.high), candles.map((c) => c.low),
        candles.map((c) => c.close), period);
      for (let i = 0; i < candles.length; i++) {
        const v = a[i];
        if (Number.isFinite(v) && candles[i].close > 0) pcts.push(v / candles[i].close);
      }
    }
    if (!pcts.length) continue;

    const atrPct = median(pcts);
    const stopPct = atrPct * atrMult;
    rows.push({
      timeframe,
      medianAtrPct: atrPct * 100,
      stopPct: stopPct * 100,
      costR: trip / stopPct,
    });
  }

  if (!rows.length) return null;

  const base = rows.find((r) => r.timeframe === config.timeframe) || rows[0];
  const best = rows.reduce((a, b) => (a.costR <= b.costR ? a : b));

  /*
   * Real markets are not scale-invariant: a daily range is several times a
   * hourly one, so the tolls should differ by a factor. When they come out
   * nearly equal, the data is not telling us the timeframes are equivalent —
   * it is telling us the source cannot distinguish them. The synthetic
   * generator is exactly such a source, and crowning a "cheapest timeframe"
   * separated by rounding would be inventing a finding.
   */
  const spread = Math.max(...rows.map((r) => r.costR)) / Math.min(...rows.map((r) => r.costR));
  const indistinguishable = spread < 1.2;

  const text = indistinguishable
    ? `Пошлина на всех проверенных таймфреймах вышла почти одинаковой ` +
      `(${rows.map((r) => `${r.timeframe} — −${r.costR.toFixed(2)}R`).join(', ')}). ` +
      'На реальном рынке так не бывает: дневной диапазон в разы шире часового. ' +
      'Значит, эти числа получены на источнике, который не различает таймфреймы ' +
      '(генератор для тестов), и делать по ним вывод нельзя.'
    : `На ${base.timeframe} стоп в ${atrMult}×ATR — это примерно ${base.stopPct.toFixed(2)}% от цены, ` +
      `а круговые издержки ${(trip * 100).toFixed(2)}%. Значит, каждая сделка стартует с ` +
      `**−${base.costR.toFixed(2)}R**, и преимущество должно превышать это число, чтобы вообще ` +
      'выйти в ноль. Для сравнения: ' +
      rows.map((r) => `${r.timeframe} — −${r.costR.toFixed(2)}R`).join(', ') + '. ' +
      (best.timeframe === base.timeframe
        ? 'Текущий таймфрейм здесь самый дешёвый из проверенных.'
        : `Переход на ${best.timeframe} снижает пошлину в ` +
          `${(base.costR / best.costR).toFixed(1)} раза — это единственный рычаг в конструкции, ` +
          'который двигает арифметику в разы, а не на проценты. Пороги её не двигают вовсе.');

  return { rows, base, best: indistinguishable ? null : best, text, indistinguishable,
    atrMult, roundTripPct: trip * 100 };
}
