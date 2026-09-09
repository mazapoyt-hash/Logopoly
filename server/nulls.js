/**
 * Null models: what does "no skill at all" actually look like on THIS data?
 *
 * Every number the analytics module produces is compared against an assumed
 * null — a 95% interval, an expected 5% false-positive rate. Those assumptions
 * are wrong here in two specific ways, and both make the analysis look sharper
 * than it is:
 *
 *  1. Trades are not independent. Consecutive trades on one symbol sit in the
 *     same market regime, so the effective sample is far smaller than the trade
 *     count, and every analytically-computed standard error is too narrow.
 *  2. A backtest is not one hypothesis. It is a strategy, a parameter grid, ten
 *     breakdowns and a reader looking for something interesting — and the
 *     analytic 5% says nothing about that whole pipeline.
 *
 * The fix for both is the same and needs no distributional assumptions:
 * generate data that has, by construction, no relationship to find, push it
 * through the identical pipeline, and see what the pipeline reports. Whatever
 * it reports on that data is the noise floor. A real result has to clear it.
 *
 * Two nulls live here.
 *
 *  - RANDOM ENTRIES. Same symbols, same direction mix, same stop and target
 *    geometry, same exit rules — only the moment of entry is random. This
 *    isolates the one thing the signal engine claims to provide. If the real
 *    strategy cannot beat coin-flip timing, its indicators contribute nothing
 *    and no amount of threshold work will change that.
 *
 *  - ROTATED OUTCOMES. The breakdown tables, recomputed with each trade's
 *    result shifted onto a different trade's features. Circular rotation
 *    rather than a shuffle, because it preserves the streaky, autocorrelated
 *    shape of the result series and destroys only its alignment with the
 *    features — which is exactly the relationship being tested.
 */
import { config } from './config.js';
import { computeIndicators, PARAMS } from './strategy.js';
import { resolveOnBar, netR, summarize, COSTS } from './backtest.js';

/** Deterministic RNG: a null model that changes between runs proves nothing. */
export function makeRng(seed = 20260909) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/** Where a value falls inside a distribution, as a share below it. */
export function percentileOf(sorted, value) {
  if (!sorted.length) return null;
  let below = 0;
  for (const v of sorted) if (v < value) below++;
  return below / sorted.length;
}

/* --------------------------- 1. Random entries ------------------------ */

/**
 * One coin-flip trade: enter at a random bar's close, with the direction and
 * geometry handed in, then resolve by the same rules the real backtest uses.
 */
function randomTrade(candles, ind, rng, direction, params, warmup) {
  const last = candles.length - 2;          // needs at least one bar after it
  if (last <= warmup) return null;
  const i = warmup + Math.floor(rng() * (last - warmup));
  const atrNow = ind.atr[i];
  const entry = candles[i].close;
  if (!Number.isFinite(atrNow) || atrNow <= 0 || !Number.isFinite(entry)) return null;

  const long = direction === 'LONG';
  const stopDist = atrNow * params.atrStopMult;
  const trade = {
    direction, entry,
    stop: long ? entry - stopDist : entry + stopDist,
    target: long ? entry + stopDist * params.rewardRisk : entry - stopDist * params.rewardRisk,
    expiryBars: params.expiryBars,
  };

  for (let k = 1; k <= params.expiryBars && i + k < candles.length; k++) {
    const res = resolveOnBar(trade, candles[i + k], k);
    if (res) return { ...trade, ...res, entryTime: candles[i].time };
  }
  return null; // still open at the end of the data: not a completed trade
}

/**
 * How would random timing have done?
 *
 * Every real trade is matched by a random-entry trade on the SAME symbol in the
 * SAME direction, so symbol selection and the long/short mix — which in a
 * trending market decide most of the result on their own — are held fixed. What
 * is left is the entry timing, which is the only thing the indicators do.
 */
export function randomEntryBenchmark(dataBySymbol, realTrades, {
  replicates = 200, seed = 20260909, params = config.strategy, costs = COSTS,
} = {}) {
  if (!realTrades.length) return null;
  /*
   * Both sides are re-priced at the same cost level, so the comparison stays
   * apples-to-apples when it is run frictionlessly. Costs are charged per
   * trade as a fixed fraction of price, so they hit a tight stop far harder
   * than a wide one — which means a with-costs comparison partly measures
   * position geometry, not timing. Running it at zero cost separates the two.
   */
  const reprice = (t) => ({
    ...t, r: netR({ direction: t.direction, entry: t.entry, stop: t.stop, exit: t.exit }, costs),
  });
  const real = summarize(realTrades.map(reprice));

  // The shape to imitate: how many trades of each direction on each symbol.
  const shape = new Map();
  for (const t of realTrades) {
    const key = `${t.symbol}|${t.direction}`;
    shape.set(key, (shape.get(key) || 0) + 1);
  }

  const indBySymbol = {};
  for (const [symbol, { candles }] of Object.entries(dataBySymbol)) {
    indBySymbol[symbol] = computeIndicators(candles);
  }
  const warmup = PARAMS.emaSlow + 5;

  const rng = makeRng(seed);
  const avgRs = [];
  const winRates = [];

  for (let r = 0; r < replicates; r++) {
    const trades = [];
    for (const [key, count] of shape) {
      const [symbol, direction] = key.split('|');
      const data = dataBySymbol[symbol];
      if (!data) continue;
      for (let n = 0; n < count; n++) {
        const t = randomTrade(data.candles, indBySymbol[symbol], rng, direction, params, warmup);
        if (t) trades.push(t);
      }
    }
    if (!trades.length) continue;
    const s = summarize(trades.map(reprice));
    avgRs.push(s.avgR);
    winRates.push(s.winRate);
  }

  if (!avgRs.length) return null;
  avgRs.sort((a, b) => a - b);
  winRates.sort((a, b) => a - b);

  const pct = percentileOf(avgRs, real.avgR);
  const nullMean = avgRs.reduce((s, v) => s + v, 0) / avgRs.length;

  /*
   * The verdict is deliberately blunt. "Beats random" is the minimum bar for
   * an entry rule to exist at all — it is not evidence of profitability, and
   * failing it is close to conclusive in the other direction.
   */
  let verdict;
  let text;
  if (pct >= 0.95) {
    verdict = 'beats';
    text = `Реальные входы лучше ${(pct * 100).toFixed(0)}% случайных при том же наборе монет, ` +
      'том же соотношении лонг/шорт и той же геометрии стопа и цели. Это значит, что момент ' +
      'входа что-то добавляет. Прибыльности это не доказывает — только то, что логика входа не пустая.';
  } else if (pct <= 0.05) {
    verdict = 'worse';
    text = `Реальные входы хуже ${(100 - pct * 100).toFixed(0)}% случайных. Индикаторы не просто ` +
      'бесполезны — они систематически выбирают худшие моменты, чем монетка.';
  } else {
    verdict = 'same';
    text = `Реальные входы неотличимы от случайных: результат стратегии попадает в ` +
      `${(pct * 100).toFixed(0)}-й процентиль случайных входов с той же геометрией. ` +
      'Вся видимая работа индикаторов не добавляет ничего к тому, что дают стоп, цель и ' +
      'выбор монеты. Настраивать пороги в такой ситуации бессмысленно.';
  }

  return {
    verdict, text, replicates: avgRs.length,
    real: { avgR: real.avgR, winRate: real.winRate, trades: real.trades },
    nullModel: {
      meanAvgR: nullMean,
      p05: quantile(avgRs, 0.05), p50: quantile(avgRs, 0.5), p95: quantile(avgRs, 0.95),
      medianWinRate: quantile(winRates, 0.5),
    },
    percentile: pct,
  };
}

/* -------------------------- 2. Rotated outcomes ----------------------- */

/**
 * The measured false-positive rate of the whole breakdown pipeline.
 *
 * `countFlags` is handed in rather than imported so this module stays free of
 * the analytics module's own assumptions: whatever counting rule the report
 * uses, the null is measured through that same rule.
 */
export function rotationNull(trades, countFlags, { replicates = 200, seed = 4242 } = {}) {
  const n = trades.length;
  if (n < 50) return null;

  const rng = makeRng(seed);
  const counts = [];
  for (let r = 0; r < replicates; r++) {
    // A rotation by a random offset: outcomes keep their order (and so their
    // streakiness) but no longer belong to the trade whose features they meet.
    const offset = 1 + Math.floor(rng() * (n - 1));
    const rotated = trades.map((t, i) => ({ ...t, r: trades[(i + offset) % n].r }));
    counts.push(countFlags(rotated));
  }
  counts.sort((a, b) => a - b);
  return {
    replicates,
    median: quantile(counts, 0.5),
    p95: quantile(counts, 0.95),
    max: counts[counts.length - 1],
    counts,
  };
}

/* ------------------------- 3. Cost sensitivity ------------------------ */

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
