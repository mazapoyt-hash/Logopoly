/**
 * Расхождения: принуждение вместо предсказания.
 *
 * Every strategy measured in this project so far has been a PREDICTION — RSI,
 * ADX, momentum, a cross-sectional ranking. All of them failed, and they failed
 * for the same structural reason: a price already contains everyone's opinion
 * about the future, so a rule that reads the past and forecasts the future is
 * competing against that aggregate and loses to its own costs.
 *
 * This module asks a different class of question. A perpetual and its spot are
 * the same asset, tied together by the funding mechanism; their gap is not a
 * forecast but a spread that the exchange's own construction pulls toward zero.
 * Nothing has to be guessed — the question is only whether the gap ever gets
 * wide enough to pay for crossing it twice, and how long it takes to close.
 *
 * Four things decide whether that question is answered honestly, and every one
 * of them is a way this measurement could flatter itself:
 *
 *  1. SURVIVORSHIP. Counting only the gaps that closed is the classic way to
 *     turn a losing trade into a winning statistic. Every excursion opened here
 *     is followed to a fixed horizon and resolved by what actually happened —
 *     `timeout` is an outcome with a real (usually negative) result attached,
 *     not a discarded sample.
 *
 *  2. OVERLAP. A single slow move crossing the threshold on twenty consecutive
 *     bars is one opportunity, not twenty. Excursions are non-overlapping: once
 *     one opens, the scan resumes after it resolves.
 *
 *  3. THE TOLL. A gap of 0.05% is not an opportunity if crossing costs 0.16%.
 *     Every result here is net of the round trip on both legs, and the entry
 *     thresholds are quoted in multiples of that toll rather than in percent,
 *     because the percent alone means nothing.
 *
 *  4. MEAN REVERSION HAS TO BE PROVEN, NOT ASSUMED. This is the one that
 *     matters most. A random walk also "converges" sometimes — it wanders back
 *     across its starting point by chance, and a rule that waits for a big
 *     deviation and bets on return will show profits on pure noise if you do
 *     not check. So the null here rebuilds the series from RESAMPLED
 *     INCREMENTS: identical step-size distribution, identical volatility, no
 *     mean reversion by construction. A real pull toward zero has to beat what
 *     the same rule earns on a random walk of the same roughness.
 */
import { makeRng, quantile, percentileOf } from './nulls.js';

/** Bars to follow an excursion before calling it unresolved. */
export const HORIZON = 48;

/** Entry thresholds, in multiples of the round-trip toll. */
export const ENTRIES = [1, 1.5, 2, 3, 4];

const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

/**
 * The gap between a perpetual and its spot, bar by bar, as a fraction of spot.
 *
 * Aligned by timestamp rather than by index: a missing bar on one venue shifts
 * every later pairing otherwise, which would manufacture a gap out of a clock
 * difference.
 */
export function basisSeries(spotCandles, perpCandles) {
  const spot = new Map((spotCandles || []).map((c) => [c.time, c.close]));
  const out = [];
  for (const c of perpCandles || []) {
    const s = spot.get(c.time);
    if (s > 0 && Number.isFinite(c.close)) out.push({ time: c.time, basis: (c.close - s) / s });
  }
  return out;
}

/**
 * Find non-overlapping excursions past `enter` and follow each to resolution.
 *
 * The trade is always the convergent one: a rich perpetual is sold against
 * spot, a cheap one bought, so the gross result is the amount the gap closed.
 * A gap that widens returns a negative gross — which is the whole point of
 * following it rather than waiting for it to come back.
 */
export function excursions(series, { enter, exit = 0, horizon = HORIZON } = {}) {
  if (!(enter > 0) || !series?.length) return [];
  const out = [];
  let i = 0;
  while (i < series.length) {
    const { basis } = series[i];
    if (!(Math.abs(basis) >= enter)) { i++; continue; }

    const sign = Math.sign(basis);                 // +1: perp rich, we bet it falls
    const entryBasis = basis;
    let resolved = null;

    for (let k = 1; k <= horizon && i + k < series.length; k++) {
      const b = series[i + k].basis;
      // Converged once the gap has shrunk to the exit band, from either side.
      if (sign * b <= exit) {
        resolved = { bars: k, exitBasis: b, outcome: 'converged' };
        break;
      }
    }
    if (!resolved) {
      const k = Math.min(horizon, series.length - 1 - i);
      // Unresolved is still an outcome: the position is closed at the horizon
      // for whatever it is worth, gain or loss.
      resolved = k > 0
        ? { bars: k, exitBasis: series[i + k].basis, outcome: 'timeout' }
        : null;
    }
    if (!resolved) break;                          // ran off the end of the data

    out.push({
      at: series[i].time,
      entryBasis,
      direction: sign > 0 ? 'perp-rich' : 'perp-cheap',
      ...resolved,
      gross: sign * (entryBasis - resolved.exitBasis),
    });
    i += resolved.bars + 1;                        // non-overlapping
  }
  return out;
}

/** Net every excursion by the round trip and summarise what is left. */
export function tally(list, { trip }) {
  const n = list.length;
  if (!n) {
    return {
      count: 0, converged: 0, timeouts: 0, winRate: null,
      grossMean: null, netMean: null, netTotal: 0, medianBars: null,
    };
  }
  const nets = list.map((e) => e.gross - trip);
  const wins = nets.filter((v) => v > 0).length;
  const bars = [...list.map((e) => e.bars)].sort((a, b) => a - b);
  return {
    count: n,
    converged: list.filter((e) => e.outcome === 'converged').length,
    timeouts: list.filter((e) => e.outcome === 'timeout').length,
    winRate: wins / n,
    grossMean: mean(list.map((e) => e.gross)),
    netMean: mean(nets),
    netTotal: nets.reduce((s, v) => s + v, 0),
    medianBars: quantile(bars, 0.5),
  };
}

/**
 * Turn a per-excursion result into an annual rate.
 *
 * Size alone says nothing: a 0.3% net gap that appears twice a year is not a
 * business. Frequency is measured, not assumed, and the two are multiplied.
 */
export function annualise(t, spanYears) {
  if (!t.count || !(spanYears > 0) || t.netMean == null) return null;
  const perYear = t.count / spanYears;
  return {
    perYear,
    annualPct: t.netMean * perYear * 100,
    spanYears,
  };
}

/**
 * A random walk with this series' own roughness.
 *
 * Resampling the FIRST DIFFERENCES keeps the step-size distribution — so the
 * fake series is exactly as volatile, and crosses any threshold about as often
 * — while destroying the one property under test: that a wide gap is pulled
 * back rather than merely wandering. Shuffling the levels instead would leave a
 * series with no autocorrelation at all, which is far easier to beat and would
 * make a nothing look like a discovery.
 */
export function randomWalkLike(series, rng) {
  const n = series.length;
  if (n < 3) return series.map((p) => ({ ...p }));
  const steps = [];
  for (let i = 1; i < n; i++) steps.push(series[i].basis - series[i - 1].basis);

  const out = [{ time: series[0].time, basis: series[0].basis }];
  let level = series[0].basis;
  for (let i = 1; i < n; i++) {
    level += steps[Math.floor(rng() * steps.length)];
    out.push({ time: series[i].time, basis: level });
  }
  return out;
}

/** The same rule, run on many random walks of the same roughness. */
export function walkNull(series, opts, { replicates = 200, seed = 5150 } = {}) {
  if (!series?.length) return null;
  const rng = makeRng(seed);
  const annuals = [];
  const netMeans = [];
  for (let r = 0; r < replicates; r++) {
    const fake = randomWalkLike(series, rng);
    const t = tally(excursions(fake, opts), { trip: opts.trip });
    if (!t.count) continue;
    const a = annualise(t, opts.spanYears);
    if (a) annuals.push(a.annualPct);
    netMeans.push(t.netMean);
  }
  if (!annuals.length) return null;
  annuals.sort((a, b) => a - b);
  netMeans.sort((a, b) => a - b);
  return {
    replicates: annuals.length,
    annual: { p50: quantile(annuals, 0.5), p95: quantile(annuals, 0.95), sorted: annuals },
    netMean: { p50: quantile(netMeans, 0.5), p95: quantile(netMeans, 0.95) },
  };
}

/** Years covered by a bar series, from its own timestamps. */
export function spanYearsOf(series) {
  if (!series || series.length < 2) return 0;
  return (series[series.length - 1].time - series[0].time) / (365.25 * 24 * 3600 * 1000);
}

/**
 * One entry threshold, measured end to end against its own null.
 */
export function measureEntry(series, { enter, trip, horizon = HORIZON, replicates = 200, seed = 5150 }) {
  const spanYears = spanYearsOf(series);
  const opts = { enter, horizon, trip, spanYears };
  const list = excursions(series, opts);
  const t = tally(list, { trip });
  const a = annualise(t, spanYears);
  const nul = walkNull(series, opts, { replicates, seed });
  const percentile = nul && a ? percentileOf(nul.annual.sorted, a.annualPct) : null;
  return {
    enter, enterPct: enter * 100,
    ...t,
    annualPct: a?.annualPct ?? null,
    perYear: a?.perYear ?? null,
    nullAnnualP50: nul?.annual.p50 ?? null,
    nullAnnualP95: nul?.annual.p95 ?? null,
    percentile,
    /*
     * Profitability is part of the claim, not a separate column to be read
     * alongside it. On a random walk this rule pays the toll over and over, so
     * the null sits deep in the red — which means "clears the 95th percentile"
     * fires routinely on entries that still LOSE money, just less of it than
     * chance would. A flag named "beats the walk" next to a negative annual
     * return is a trap for whoever reads the table, so both conditions live in
     * the flag. `percentile` remains available raw for anyone who wants the
     * comparison on its own.
     */
    beatsWalk: percentile != null ? (percentile >= 0.95 && a?.annualPct > 0) : null,
  };
}

/**
 * Full report over the whole entry grid.
 *
 * The verdict is graded because the ways this can fail are genuinely different:
 *
 *  - `no-excursions` the gap never reaches even one round trip. There is
 *                    nothing to trade and no amount of tuning changes that.
 *  - `negative`      gaps appear, but crossing them loses money after costs.
 *  - `noise`         net positive, yet no better than the same rule on a random
 *                    walk of the same roughness — the "convergence" is
 *                    wandering, not the funding mechanism.
 *  - `thin`          beats the walk, but on too few episodes to stand on.
 *  - `edge`          beats the walk on a countable number of episodes. The only
 *                    value that means the mechanism was actually caught.
 */
export function dislocation(spotCandles, perpCandles, {
  trip, entries = ENTRIES, horizon = HORIZON, replicates = 200, seed = 5150,
  minEpisodes = 30,
} = {}) {
  if (!(trip > 0)) return null;
  const series = basisSeries(spotCandles, perpCandles);
  if (series.length < 100) return null;

  const sd = (() => {
    const m = mean(series.map((p) => p.basis));
    return Math.sqrt(mean(series.map((p) => (p.basis - m) ** 2)));
  })();
  /*
   * The offline generator has no separate perpetual, so it hands the same
   * series in twice and the basis is identically zero. Reporting "no
   * excursions" there would be true but useless; saying the input is
   * degenerate is the honest output.
   */
  if (!(sd > 1e-9)) {
    return { degenerate: true, verdict: 'degenerate', series: series.length, rows: [], best: null,
      text: 'Спот и перп пришли одной и той же серией — базис тождественно ноль. ' +
        'Это свойство офлайн-генератора, а не рынка: мерить нечего.' };
  }

  const rows = entries.map((enter) => measureEntry(series, {
    enter: enter * trip, trip, horizon, replicates, seed,
  }));
  const usable = rows.filter((r) => r.count >= minEpisodes);
  const positive = usable.filter((r) => r.annualPct > 0);
  const best = positive.length
    ? positive.reduce((a, b) => (b.annualPct > a.annualPct ? b : a))
    : null;

  let verdict;
  if (!rows.some((r) => r.count > 0)) verdict = 'no-excursions';
  else if (!positive.length) verdict = 'negative';
  else if (!best.beatsWalk) verdict = 'noise';
  else if (best.count < minEpisodes * 2) verdict = 'thin';
  else verdict = 'edge';

  return {
    degenerate: false, verdict,
    series: series.length,
    spanYears: spanYearsOf(series),
    basisSdPct: sd * 100,
    tripPct: trip * 100,
    horizon, minEpisodes,
    rows, best,
    text: describeDislocation({ verdict, best, tripPct: trip * 100, rows }),
  };
}

/** The verdict in words, for someone who did not run it. */
export function describeDislocation({ verdict, best, tripPct, rows }) {
  const p2 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(2));
  const widest = rows?.length ? Math.max(...rows.map((r) => r.count)) : 0;

  if (verdict === 'degenerate') {
    return 'Базис тождественно ноль — мерить нечего.';
  }
  if (verdict === 'no-excursions') {
    return `Базис ни разу не расходился даже на один круговой проход (${p2(tripPct)}%). ` +
      'Расхождений, которые стоило бы пересекать, не существует — это ответ, ' +
      'и настройками он не меняется.';
  }
  if (verdict === 'negative') {
    return `Расхождения есть (${widest} эпизодов на самом низком пороге), но пересекать их ` +
      'убыточно: круговые издержки больше того, насколько зазор успевает закрыться. ' +
      'Механизм реален, доступная его часть — нет.';
  }
  if (verdict === 'noise') {
    return `Лучший порог даёт ${p2(best?.annualPct)}% годовых, но случайное блуждание той же ` +
      `шероховатости даёт ${p2(best?.nullAnnualP50)}% медианно и ${p2(best?.nullAnnualP95)}% ` +
      `в 5% случаев (процентиль ${best?.percentile == null ? '—' : (best.percentile * 100).toFixed(0)}). ` +
      'Зазор возвращается не потому, что его тянет фандинг, а потому, что он блуждает.';
  }
  if (verdict === 'thin') {
    return `Порог ${p2(best?.enterPct)}% обыгрывает случайное блуждание (${p2(best?.annualPct)}% ` +
      `годовых против ${p2(best?.nullAnnualP50)}%), но эпизодов всего ${best?.count}. ` +
      'Направление верное, доказательства пока нет.';
  }
  return `Порог ${p2(best?.enterPct)}% даёт ${p2(best?.annualPct)}% годовых на ${best?.count} ` +
    `эпизодах и обыгрывает случайное блуждание той же шероховатости ` +
    `(${p2(best?.nullAnnualP50)}% медианно, процентиль ` +
    `${best?.percentile == null ? '—' : (best.percentile * 100).toFixed(0)}). ` +
    'Это принуждение, а не прогноз — единственный класс, где такое возможно.';
}
