/**
 * Selectivity: what does raising the bar actually buy?
 *
 * The deep run already reports a `score` breakdown, but it answers a weaker
 * question than the one worth asking. Fixed buckets (60–64, 65–69, …) show
 * whether the score orders trades. They do not show what a *trader* would get,
 * because a trader does not take the 75–79 band — they set a minimum and take
 * everything above it.
 *
 * So this sweeps the threshold instead: for every cut-off, keep the trades at
 * or above it and measure what is left. That is the literal "be more precise,
 * take fewer trades" lever, priced.
 *
 * Three things make it an honest measurement rather than a search for the
 * prettiest number.
 *
 *  1. THE SWEEP IS ITSELF A MULTIPLE COMPARISON. Eight thresholds, and the
 *     best of eight is high by construction. The null here rotates the score
 *     series against the outcome series — same scores, same subset SIZES at
 *     every threshold, only the pairing destroyed — and records the best lift
 *     that procedure finds. A real threshold has to beat the best that the
 *     same sweep finds when the score means nothing.
 *
 *  2. THE THRESHOLD IS CHOSEN ON ONE SLICE AND PAID ON ANOTHER. Picking the
 *     cut-off on all the data and reporting its result is how a backtest lies.
 *     The split is by time, and the reserved slice is measured once.
 *
 *  3. THE ANSWER IS PRICED IN SAMPLE, NOT IN PERCENT. Selectivity trades
 *     evidence for purity: a bar high enough to look clean leaves too few
 *     trades to prove anything. `tradesNeeded` and `yearsNeeded` say how long
 *     the surviving rate would have to run before the number could be trusted,
 *     which is the real cost of precision and the one that cannot be paid with
 *     effort.
 */
import { summarize } from './backtest.js';
import { makeRng, quantile, percentileOf } from './nulls.js';

/** Default cut-offs. Below 60 nothing is emitted; above 90 nothing survives. */
export const THRESHOLDS = [60, 65, 70, 75, 80, 85, 90];

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

/**
 * How many trades it takes to tell an edge of `edge` R from zero.
 *
 * Two standard errors either side, with R's spread taken as ~1 (a stop is 1R
 * by construction, so per-trade sd sits near unity for any sane geometry):
 * n = (2 / edge)². The analytics module publishes the same scale as a table;
 * it is a function here because the sweep needs it at arbitrary edges.
 */
export function tradesNeeded(edge) {
  if (!Number.isFinite(edge) || edge <= 0) return null;
  return Math.ceil(4 / (edge * edge));
}

/** One row of the sweep: what is left at or above `threshold`. */
function rowAt(trades, threshold, spanYears) {
  const kept = trades.filter((t) => t.score >= threshold);
  const stats = summarize(kept);
  const perYear = spanYears > 0 ? kept.length / spanYears : null;
  const need = stats.avgR > 0 ? tradesNeeded(stats.avgR) : null;
  return {
    threshold,
    trades: kept.length,
    share: trades.length ? kept.length / trades.length : 0,
    winRate: stats.winRate,
    avgR: stats.avgR,
    totalR: stats.totalR,
    profitFactor: stats.profitFactor,
    perYear,
    tradesNeeded: need,
    yearsNeeded: need && perYear > 0 ? need / perYear : null,
  };
}

/** Span of the trade list in years, by entry time. */
export function spanYearsOf(trades) {
  if (trades.length < 2) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of trades) {
    if (t.entryTime < lo) lo = t.entryTime;
    if (t.entryTime > hi) hi = t.entryTime;
  }
  return (hi - lo) / YEAR_MS;
}

/** The sweep itself. Rows are ordered by threshold, lowest bar first. */
export function sweep(trades, thresholds = THRESHOLDS) {
  const span = spanYearsOf(trades);
  return thresholds.map((th) => rowAt(trades, th, span));
}

/**
 * Rotate the score series against the outcome series.
 *
 * A shuffle would work too, but rotation keeps both series in their original
 * order — scores stay clustered the way market regimes cluster them, results
 * stay streaky — and destroys only the alignment between them, which is the
 * one thing under test. The subset sizes at every threshold are unchanged, so
 * the null sweep is compared against the real sweep row for row.
 */
export function rotateScores(trades, offset) {
  const n = trades.length;
  return trades.map((t, i) => ({ ...t, score: trades[(i + offset) % n].score }));
}

/**
 * Lift of a row over the whole sample: how much the bar improved the average.
 *
 * Measured against the strategy's own unfiltered result, not against zero,
 * because the question is what the THRESHOLD adds — a universe-wide loss that
 * the bar merely made smaller is not a discovery about the score.
 */
export function liftsOf(rows, baseAvgR) {
  return rows.map((r) => (r.trades > 0 && r.avgR != null ? r.avgR - baseAvgR : null));
}

/**
 * The noise floor of the sweep.
 *
 * Returns, per threshold, the distribution of lift under a meaningless score,
 * plus the distribution of the BEST lift the sweep finds across all thresholds
 * in one replicate. The second is the number that matters: it prices the act
 * of looking at seven thresholds and keeping the winner.
 */
export function sweepNull(trades, thresholds = THRESHOLDS, {
  replicates = 200, seed = 815, minTrades = 20,
} = {}) {
  const n = trades.length;
  if (n < 50) return null;
  const base = summarize(trades).avgR;
  const rng = makeRng(seed);
  const span = spanYearsOf(trades);

  const perThreshold = thresholds.map(() => []);
  const bests = [];

  for (let rep = 0; rep < replicates; rep++) {
    const offset = 1 + Math.floor(rng() * (n - 1));
    const rotated = rotateScores(trades, offset);
    let best = -Infinity;
    thresholds.forEach((th, k) => {
      const row = rowAt(rotated, th, span);
      if (row.trades < minTrades || row.avgR == null) return;
      const lift = row.avgR - base;
      perThreshold[k].push(lift);
      if (lift > best) best = lift;
    });
    if (Number.isFinite(best)) bests.push(best);
  }

  bests.sort((a, b) => a - b);
  return {
    replicates: bests.length,
    minTrades,
    perThreshold: thresholds.map((th, k) => {
      const s = [...perThreshold[k]].sort((a, b) => a - b);
      return {
        threshold: th, samples: s.length,
        p50: quantile(s, 0.5), p95: quantile(s, 0.95), sorted: s,
      };
    }),
    bestLift: { p50: quantile(bests, 0.5), p95: quantile(bests, 0.95), sorted: bests },
  };
}

/** Split a trade list by entry time: the earlier `ratio` chooses, the rest pays. */
export function splitTrades(trades, ratio = 0.7) {
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const cut = Math.floor(sorted.length * ratio);
  return { tune: sorted.slice(0, cut), test: sorted.slice(cut) };
}

/**
 * Pick the threshold with the best average, refusing bars that leave too few
 * trades to mean anything. Returns null when no bar clears `minTrades`.
 */
export function bestThreshold(trades, thresholds = THRESHOLDS, { minTrades = 20 } = {}) {
  const rows = sweep(trades, thresholds).filter((r) => r.trades >= minTrades && r.avgR != null);
  if (!rows.length) return null;
  return rows.reduce((a, b) => (b.avgR > a.avgR ? b : a));
}

/**
 * Full report.
 *
 * The verdict is graded rather than boolean because the failure modes are
 * genuinely different and the difference decides what to do next:
 *
 *  - `none`      no bar reaches a positive average. Selectivity has no lever.
 *  - `noise`     the best bar does no better than the same sweep on a
 *                meaningless score. There is nothing here to hold on to.
 *  - `fragile`   the sweep clears its own noise floor, but the bar chosen on
 *                the early slice does not repeat on the reserved one.
 *  - `thin`      it repeats, but on too few trades to be evidence — the
 *                number to read then is `yearsNeeded`, not `avgR`.
 *  - `edge`      clears the sweep null AND repeats on the reserved slice with
 *                enough trades to matter. This is the only value that means
 *                the bar can be raised on purpose.
 */
export function selectivity(trades, {
  thresholds = THRESHOLDS, replicates = 200, seed = 815,
  minTrades = 20, holdout = 0.3,
} = {}) {
  if (!trades?.length) return null;
  const withScore = trades.filter((t) => Number.isFinite(t.score));
  if (withScore.length < 50) return null;

  const base = summarize(withScore);
  const rows = sweep(withScore, thresholds);
  const lifts = liftsOf(rows, base.avgR);
  const nul = sweepNull(withScore, thresholds, { replicates, seed, minTrades });

  const eligible = rows.filter((r) => r.trades >= minTrades && r.avgR != null);
  const best = eligible.length
    ? eligible.reduce((a, b) => (b.avgR > a.avgR ? b : a))
    : null;
  const bestLift = best ? best.avgR - base.avgR : null;
  const bestPercentile = nul && bestLift != null
    ? percentileOf(nul.bestLift.sorted, bestLift) : null;

  // Choose on the past, pay on the reserved slice. One shot, no re-picking.
  const { tune, test } = splitTrades(withScore, 1 - holdout);
  const chosen = bestThreshold(tune, thresholds, { minTrades });
  let reserved = null;
  if (chosen && test.length) {
    const span = spanYearsOf(test);
    const row = rowAt(test, chosen.threshold, span);
    const testBase = summarize(test).avgR;
    reserved = {
      threshold: chosen.threshold,
      chosenOn: { trades: chosen.trades, avgR: chosen.avgR },
      ...row,
      baseAvgR: testBase,
      lift: row.avgR == null ? null : row.avgR - testBase,
      from: test.length ? Math.min(...test.map((t) => t.entryTime)) : null,
      to: test.length ? Math.max(...test.map((t) => t.entryTime)) : null,
    };
  }

  const anyPositive = rows.some((r) => r.trades >= minTrades && r.avgR > 0);
  const clearsSweep = bestPercentile != null && bestPercentile >= 0.95;
  const repeats = reserved && reserved.avgR > 0 && reserved.lift > 0;

  let verdict;
  if (!anyPositive) verdict = 'none';
  else if (!clearsSweep) verdict = 'noise';
  else if (!repeats) verdict = 'fragile';
  else if (reserved.trades < (best?.tradesNeeded ?? Infinity)) verdict = 'thin';
  else verdict = 'edge';

  return {
    verdict,
    base: { trades: base.trades, avgR: base.avgR, winRate: base.winRate },
    spanYears: spanYearsOf(withScore),
    rows: rows.map((r, i) => ({
      ...r,
      lift: lifts[i],
      nullP95: nul?.perThreshold[i]?.p95 ?? null,
      beatsNull: lifts[i] != null && nul?.perThreshold[i]?.p95 != null
        ? lifts[i] > nul.perThreshold[i].p95 : null,
    })),
    best: best ? { ...best, lift: bestLift, percentile: bestPercentile } : null,
    sweepNull: nul ? {
      replicates: nul.replicates, minTrades: nul.minTrades,
      bestLiftP50: nul.bestLift.p50, bestLiftP95: nul.bestLift.p95,
    } : null,
    reserved,
    text: describeSelectivity({ verdict, best, reserved, bestPercentile, base }),
  };
}

/** The verdict in words, written to be read by someone who did not run it. */
export function describeSelectivity({ verdict, best, reserved, bestPercentile, base }) {
  const r2 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(3));
  const yrs = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(0));

  if (verdict === 'none') {
    return 'Ни один порог не выводит средний результат в плюс. Повышать планку некуда: ' +
      'отбор делает выборку чище и меньше, но не прибыльнее.';
  }
  if (verdict === 'noise') {
    return `Лучший порог (${best?.threshold}) даёт прибавку ${r2(best?.lift)}R, но ровно такую же ` +
      'прибавку та же протяжка находит на перемешанном score, где связи нет по построению ' +
      `(процентиль ${bestPercentile == null ? '—' : (bestPercentile * 100).toFixed(0)}). ` +
      'Это цена перебора семи порогов, а не свойство сигнала.';
  }
  if (verdict === 'fragile') {
    return `Порог ${best?.threshold} проходит контроль на всей выборке, но выбранный по ранней ` +
      `части он на отложенной даёт ${r2(reserved?.avgR)}R — прибавка не повторяется. ` +
      'Планка подогнана под тот кусок, на котором её выбрали.';
  }
  if (verdict === 'thin') {
    return `Порог ${reserved?.threshold} повторяется на отложенной части (${r2(reserved?.avgR)}R ` +
      `на ${reserved?.trades} сделках), но этого мало: чтобы отличить прибавку ${r2(best?.lift)}R ` +
      `от нуля, нужно ${best?.tradesNeeded ?? '—'} сделок, а такой порог даёт ` +
      `${best?.perYear == null ? '—' : best.perYear.toFixed(0)} в год — ` +
      `**${yrs(best?.yearsNeeded)} лет наблюдений**. Точность здесь покупается не усилием, а временем.`;
  }
  return `Порог ${reserved?.threshold} проходит контроль перебора и повторяется на отложенной ` +
    `части: ${r2(reserved?.avgR)}R против ${r2(reserved?.baseAvgR)}R на ${reserved?.trades} сделках. ` +
    `База по всей выборке — ${r2(base?.avgR)}R. Планку можно поднимать осознанно.`;
}
