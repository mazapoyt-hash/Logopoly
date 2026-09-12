/**
 * Funding-rate harvesting: the first thing measured in this project that is
 * paid for providing a service rather than for guessing right.
 *
 * WHAT THE TRADE IS
 *
 * A perpetual future has no expiry, so nothing forces its price to the spot
 * price. The exchange forces it with a payment: every funding interval, if the
 * perp trades above spot, longs pay shorts in proportion to the gap; if below,
 * shorts pay longs. The rate is published and settled mechanically.
 *
 * So: buy the coin on spot, short the same size of the perpetual. Price moves
 * cancel — up on one leg is down on the other — and what is left is the funding
 * payment. You are not predicting anything. You are holding the unpopular side
 * of a crowded trade and being paid the published price for it.
 *
 * WHY THIS IS A DIFFERENT KIND OF NUMBER FROM EVERYTHING ELSE HERE
 *
 * The signal strategy had to beat a toll of about 0.11R per trade with an edge
 * nobody could demonstrate. Here the income is contractual: the rate is known
 * before you enter, it is the same rate for everyone, and it does not depend on
 * being right. That does NOT make it free money, and this module exists to
 * price the four things that can take it away:
 *
 *   1. The toll, again. Four crossings to get in and out of two legs —
 *      roughly 0.40% of notional — against a typical 0.01% per 8 hours. The
 *      position has to be held about forty settlements just to break even, so a
 *      harvest measured over a short hold is measuring its own fees.
 *   2. Negative funding. When the perp trades below spot the payment reverses
 *      and the harvester pays. The mirror trade (long perp, short spot) is NOT
 *      symmetric: shorting spot requires borrowing the coin at a rate nobody
 *      publishes in advance, so negative periods are a cost, not an opportunity.
 *   3. Capital, not notional. The spot leg has to be paid for in full. With the
 *      short at L×, one dollar of capital buys 1/(1 + 1/L) dollars of notional —
 *      so the headline "funding × periods per year" overstates the yield on
 *      money actually committed, and by a lot.
 *   4. Basis and liquidation. The legs cancel price moves only while both are
 *      open; entering on a wide basis and closing on a narrow one is a real
 *      loss, and a sharp rally liquidates the short leg before the spot gain
 *      can be realised unless the margin is topped up.
 *
 * Everything below is measured from exchange history, with the same discipline
 * the rest of the project uses: a split the selection rule never sees, a random
 * benchmark, and a reserved slice nobody touches.
 */
import { COSTS } from './backtest.js';
import { normalCdf } from './money.js';
import { makeRng, quantile, percentileOf } from './nulls.js';

const YEAR_MS = 365 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
};
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* ------------------------------- the toll ----------------------------- */

/** Leverage on the short leg. Only the margin requirement, never the income. */
export const LEVERAGE = Number(process.env.COINSCOPE_FUNDING_LEVERAGE || 3);

/** Exchange maintenance margin, used only to place the liquidation price. */
const MAINTENANCE_PCT = Number(process.env.COINSCOPE_MAINTENANCE || 0.5);

/**
 * Round trip for a delta-neutral pair, as a fraction of one leg's notional.
 *
 * Four crossings, not two: spot in, perp in, spot out, perp out. Getting this
 * wrong by a factor of two would halve the break-even hold, which is exactly
 * the number the whole case rests on.
 */
export function pairRoundTrip(costs = COSTS) {
  return 4 * (costs.feeRate + costs.slippageRate);
}

/** Capital needed per unit of notional: spot paid in full, perp on margin. */
export function capitalPerNotional(leverage = LEVERAGE) {
  return 1 + 1 / Math.max(leverage, 0.01);
}

/* --------------------------- describing a series ---------------------- */

/**
 * What one symbol's funding history actually says.
 *
 * The annualised figure is computed from the measured interval, so a symbol
 * settling every 4 hours is not reported at half its yield, and a symbol whose
 * schedule changed mid-history is annualised by the grid it mostly sat on.
 */
export function describeFunding(points, { intervalMs = null, leverage = LEVERAGE, costs = COSTS } = {}) {
  const rates = points.map((p) => p.rate).filter(Number.isFinite);
  if (rates.length < 10) return null;

  const interval = intervalMs || medianGap(points);
  if (!(interval > 0)) return null;

  const periodsPerYear = YEAR_MS / interval;
  const m = mean(rates);
  const s = sd(rates);
  const negatives = rates.filter((r) => r < 0).length;

  const trip = pairRoundTrip(costs);
  const capital = capitalPerNotional(leverage);

  return {
    periods: rates.length,
    from: points[0].time,
    to: points[points.length - 1].time,
    intervalHours: interval / 3600_000,
    periodsPerYear,
    meanRate: m,
    medianRate: median(rates),
    sdRate: s,
    /** Share of settlements where the harvester pays instead of collecting. */
    negativeShare: negatives / rates.length,
    /** Yield on NOTIONAL with costs ignored — the number usually advertised. */
    annualGross: m * periodsPerYear,
    /** Yield on CAPITAL, still before costs. Lower by the funding of the spot leg. */
    annualOnCapital: (m * periodsPerYear) / capital,
    /*
     * The same arithmetic as the strategy's toll, with a different denominator:
     * cost divided by income per unit. There it was cost/risk in R; here it is
     * cost/income in settlements. Below this many periods the position is
     * paying for its own execution and nothing else.
     */
    breakEvenPeriods: m > 0 ? trip / m : Infinity,
    breakEvenDays: m > 0 ? (trip / m) * (interval / DAY_MS) : Infinity,
    /*
     * Infinity does not survive JSON — it serialises to null, and a null reads
     * downstream as "not computed" rather than "never pays for itself". The site
     * and the summary both need that distinction, so it is stated as a boolean
     * instead of inferred from a missing number.
     */
    breakEvenReachable: m > 0,
    roundTripPct: trip * 100,
  };
}

const medianGap = (points) => {
  const gaps = [];
  for (let i = 1; i < points.length; i++) {
    const g = points[i].time - points[i - 1].time;
    if (g > 0) gaps.push(g);
  }
  return median(gaps);
};

/**
 * Is the portfolio average a fact about the market, or about one coin?
 *
 * THE READING ERROR THIS EXISTS TO PREVENT
 *
 * The first live OKX run produced a mean of −0.0096% per settlement and the
 * report called the harvest unprofitable. Both true. But the MEDIAN settlement
 * was +0.0042%, nineteen of twenty-four coins paid positively, and one coin —
 * LABUSDT at −0.172% per 8 hours — contributed −0.0150% to that mean, more than
 * the entire negative total. Drop it and the same data reads +0.0060% per
 * settlement, about +4.9% a year on capital.
 *
 * So "funding harvesting does not pay" was not what the data said. What it said
 * was "an equal-weight basket containing a coin that charges 0.17% every eight
 * hours does not pay", which nobody would trade and which is a statement about
 * portfolio construction, not about funding.
 *
 * This is the same mistake RLUSD caused on the strategy side, where one pegged
 * coin produced −1233R of a −1514R total. The lesson there was that the guard
 * has to be a MECHANISM rather than a list of names — and the mechanism here is
 * not a filter (filtering on the outcome would be choosing the answer) but a
 * concentration check: say out loud when the aggregate rests on one symbol, and
 * report what the rest of the universe did without it.
 */
export function meanConcentration(perSymbol) {
  const rows = (perSymbol || []).filter((r) => Number.isFinite(r.meanRate) && r.periods > 0);
  if (rows.length < 3) return null;

  const totalPeriods = rows.reduce((s, r) => s + r.periods, 0);
  if (!(totalPeriods > 0)) return null;

  const pooled = rows.reduce((s, r) => s + r.meanRate * r.periods, 0) / totalPeriods;

  const contributions = rows.map((r) => ({
    symbol: r.symbol,
    periods: r.periods,
    meanRate: r.meanRate,
    /** How much of the pooled mean this one symbol accounts for. */
    contribution: (r.meanRate * r.periods) / totalPeriods,
  })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const top = contributions[0];
  const withoutTop = rows.filter((r) => r.symbol !== top.symbol);
  const restPeriods = withoutTop.reduce((s, r) => s + r.periods, 0);
  const pooledWithoutTop = restPeriods > 0
    ? withoutTop.reduce((s, r) => s + r.meanRate * r.periods, 0) / restPeriods
    : null;

  /*
   * Dominated when one symbol's contribution is larger in magnitude than the
   * whole pooled mean: removing it then moves the aggregate by more than the
   * aggregate itself, and in practice flips its sign.
   */
  const dominated = Math.abs(top.contribution) > Math.abs(pooled);
  const flipsSign = pooledWithoutTop != null && Math.sign(pooledWithoutTop) !== Math.sign(pooled);

  return {
    pooled,
    medianOfSymbols: median(rows.map((r) => r.meanRate)),
    positiveSymbols: rows.filter((r) => r.meanRate > 0).length,
    symbols: rows.length,
    top,
    pooledWithoutTop,
    dominated,
    flipsSign,
    contributions: contributions.slice(0, 5),
  };
}

/**
 * The worst stretch, which is what decides whether the position is holdable.
 *
 * An average yield says what the end looks like; a drawdown says what you have
 * to sit through to get there. Measured on the cumulative funding curve, in the
 * same units as the round trip, so the two are directly comparable: a drawdown
 * deeper than the round trip means waiting out a bad stretch costs more than
 * closing and re-opening would have.
 */
export function fundingDrawdown(points) {
  const rates = points.map((p) => p.rate).filter(Number.isFinite);
  if (!rates.length) return null;

  let cum = 0;
  let peak = 0;
  let worst = 0;
  let worstFrom = null;
  let worstTo = null;
  let peakAt = points[0]?.time ?? null;

  let run = 0;
  let longestNegativeRun = 0;
  let runSum = 0;
  let worstRunSum = 0;

  for (const p of points) {
    if (!Number.isFinite(p.rate)) continue;
    cum += p.rate;
    if (cum > peak) { peak = cum; peakAt = p.time; }
    const dd = peak - cum;
    if (dd > worst) { worst = dd; worstFrom = peakAt; worstTo = p.time; }

    if (p.rate < 0) {
      run++; runSum += p.rate;
      if (run > longestNegativeRun) longestNegativeRun = run;
      if (runSum < worstRunSum) worstRunSum = runSum;
    } else { run = 0; runSum = 0; }
  }

  return {
    cumulative: cum,
    maxDrawdown: worst,
    maxDrawdownPct: worst * 100,
    drawdownFrom: worstFrom,
    drawdownTo: worstTo,
    longestNegativeRun,
    worstNegativeRunPct: worstRunSum * 100,
  };
}

/* ---------------------------- the simulation -------------------------- */

/**
 * Net yield for a given holding period — the honest version of the headline.
 *
 * Costs are paid once per round trip and income accrues per settlement, so the
 * net annualised figure rises with the hold and the curve is the answer to
 * "how long must this be held". It does not say "hold forever is best": the
 * risks measured elsewhere in this module grow with the hold, while this table
 * only grows the income. Both have to be read together.
 */
export function harvestCurve(desc, {
  holds = [1, 3, 7, 14, 30, 60, 90, 180, 365], leverage = LEVERAGE, costs = COSTS,
} = {}) {
  if (!desc || !(desc.periodsPerYear > 0)) return null;
  const trip = pairRoundTrip(costs);
  const capital = capitalPerNotional(leverage);
  const perDay = desc.periodsPerYear / 365;

  const rows = holds.map((days) => {
    const periods = days * perDay;
    const grossOnNotional = desc.meanRate * periods;
    const netOnNotional = grossOnNotional - trip;
    const netOnCapital = netOnNotional / capital;
    return {
      days,
      periods,
      grossPct: grossOnNotional * 100,
      costPct: trip * 100,
      netPct: netOnCapital * 100,
      annualPct: (netOnCapital * (365 / days)) * 100,
      profitable: netOnNotional > 0,
    };
  });

  const best = rows.reduce((a, b) => (a.annualPct >= b.annualPct ? a : b));
  const firstProfitable = rows.find((r) => r.profitable) || null;

  return {
    rows, best, firstProfitable,
    ceilingAnnualPct: (desc.annualOnCapital) * 100,
    leverage, capitalPerNotional: capital,
  };
}

/**
 * What compounding actually delivers at a measured rate.
 *
 * The request was explicitly about compound growth, and compounding is the one
 * part of the plan that needs no defending: it works on any positive rate. What
 * it does not do is change the rate. So the useful output is the doubling time —
 * it converts a yield into the only unit that settles expectations.
 */
export function compounding(annualPct, { stake = 100, years = [1, 2, 3, 5, 10] } = {}) {
  if (annualPct == null || !Number.isFinite(annualPct)) return null;
  const y = annualPct / 100;
  const rows = years.map((n) => ({
    years: n,
    factor: (1 + y) ** n,
    value: stake * (1 + y) ** n,
  }));
  return {
    annualPct, stake, rows,
    doublingYears: y > 0 ? Math.log(2) / Math.log(1 + y) : null,
    positive: y > 0,
  };
}

/* -------------------------------- risks ------------------------------- */

/**
 * Basis risk: the part of "delta-neutral" that is not neutral.
 *
 * The legs cancel price moves only in the difference (perp − spot). Enter while
 * that difference is wide and close while it is narrow and the loss is real,
 * whatever funding paid. Its standard deviation is reported in the same units
 * as the round trip, because that comparison is the whole point: a basis that
 * swings further than the fees means entry timing matters more than the venue.
 */
export function basisRisk(spotCandles, perpCandles) {
  const spot = new Map(spotCandles.map((c) => [c.time, c.close]));
  const diffs = [];
  for (const c of perpCandles) {
    const s = spot.get(c.time);
    if (s > 0 && Number.isFinite(c.close)) diffs.push((c.close - s) / s);
  }
  if (diffs.length < 30) return null;

  const sorted = [...diffs].sort((a, b) => a - b);
  const trip = pairRoundTrip();
  const s = sd(diffs);

  /*
   * A basis of exactly zero is not a perfectly neutral market, it is one series
   * handed in twice — which is what the offline generator does, since it has no
   * separate perpetual. Reporting 0.00% there would invent the most flattering
   * possible finding: that the one unhedged risk in the trade does not exist.
   * Below a tenth of a basis point the two series are indistinguishable and the
   * honest output is to say so.
   */
  const degenerate = !(s > 1e-6);

  return {
    samples: diffs.length,
    degenerate,
    meanPct: mean(diffs) * 100,
    sdPct: s * 100,
    p5Pct: quantile(sorted, 0.05) * 100,
    p95Pct: quantile(sorted, 0.95) * 100,
    /** How the worst realistic swing compares to the cost of the round trip. */
    swingVsTripCost: degenerate ? null : (quantile(sorted, 0.95) - quantile(sorted, 0.05)) / trip,
  };
}

/**
 * The short leg's liquidation risk, measured against history rather than feared.
 *
 * A short at L× is force-closed roughly (100/L − maintenance)% above entry. The
 * spot leg gains the same amount, but that gain is in a different account and
 * does not stop the liquidation — which is why a cross-margin arrangement or a
 * top-up plan is not a detail. This counts how often a real up-move over the
 * intended hold would have reached it.
 */
export function shortLegRisk(perpCandles, { holdBars, leverage = LEVERAGE, maintenancePct = MAINTENANCE_PCT } = {}) {
  if (!perpCandles?.length || !(holdBars > 0)) return null;
  const liqPct = (100 / leverage) - maintenancePct;

  let windows = 0;
  let breached = 0;
  const rises = [];
  for (let i = 0; i + holdBars < perpCandles.length; i++) {
    const entry = perpCandles[i].close;
    if (!(entry > 0)) continue;
    let high = entry;
    for (let j = i + 1; j <= i + holdBars; j++) high = Math.max(high, perpCandles[j].high);
    const rise = ((high - entry) / entry) * 100;
    rises.push(rise);
    windows++;
    if (rise >= liqPct) breached++;
  }
  if (!windows) return null;

  const sorted = [...rises].sort((a, b) => a - b);
  return {
    leverage, liquidationPct: liqPct, holdBars, windows,
    breachShare: breached / windows,
    medianRisePct: median(rises),
    p95RisePct: quantile(sorted, 0.95),
    maxRisePct: sorted[sorted.length - 1],
    /** Leverage at which no window in this history would have liquidated. */
    safeLeverage: sorted[sorted.length - 1] > 0
      ? 100 / (sorted[sorted.length - 1] + maintenancePct) : null,
  };
}

/* ----------------------------- does it persist ------------------------ */

/** Spearman rank correlation, with a p-value from the usual t approximation. */
export function spearman(pairs) {
  const n = pairs.length;
  if (n < 5) return { rho: null, p: null, n };

  const rank = (vals) => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(vals.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;                   // average rank for ties
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };

  const ra = rank(pairs.map((p) => p[0]));
  const rb = rank(pairs.map((p) => p[1]));
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  if (!(da > 0) || !(db > 0)) return { rho: null, p: null, n };

  const rho = num / Math.sqrt(da * db);
  const t = rho * Math.sqrt((n - 2) / Math.max(1e-12, 1 - rho ** 2));
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return { rho, p, n, significant: p < 0.05 };
}

/**
 * Split each symbol's series into ordered slices by share of its own length.
 * Time, not index across symbols: a symbol listed later has a shorter history
 * and must still be split into comparable thirds of its own life.
 */
export function splitFunding(bySymbol, ratios = [0.5, 0.3, 0.2]) {
  const total = ratios.reduce((s, v) => s + v, 0);
  const slices = ratios.map(() => ({}));
  for (const [symbol, points] of Object.entries(bySymbol)) {
    if (!points?.length) continue;
    let at = 0;
    ratios.forEach((ratio, i) => {
      const take = Math.floor((points.length * ratio) / total);
      slices[i][symbol] = points.slice(at, at + take);
      at += take;
    });
  }
  return slices;
}

/**
 * The question that decides whether a selection rule exists at all.
 *
 * Average funding across a universe is one number; deploying capital means
 * CHOOSING symbols, and that only works if today's ranking says something about
 * tomorrow's. So: rank on the first slice, then measure what those picks
 * actually paid on a slice the ranking never saw — against the universe average,
 * and against picking at random.
 *
 * The random benchmark is the part that cannot be skipped. With most symbols
 * paying positive funding most of the time, ANY selection looks profitable out
 * of sample, and reporting that as skill would repeat precisely the mistake the
 * random-entry benchmark caught in the signal strategy.
 */
export function persistenceTest(bySymbol, { topK = 5, replicates = 500, seed = 7771, leverage = LEVERAGE } = {}) {
  const [fit, check] = splitFunding(bySymbol, [0.5, 0.5]);

  const symbols = Object.keys(bySymbol).filter((s) => (fit[s]?.length || 0) >= 20 && (check[s]?.length || 0) >= 20);
  if (symbols.length < 5) return null;

  const meanOf = (slice, s) => mean(slice[s].map((p) => p.rate));
  const fitMeans = Object.fromEntries(symbols.map((s) => [s, meanOf(fit, s)]));
  const checkMeans = Object.fromEntries(symbols.map((s) => [s, meanOf(check, s)]));

  const rank = spearman(symbols.map((s) => [fitMeans[s], checkMeans[s]]));

  const k = Math.min(topK, symbols.length - 1);
  const picked = [...symbols].sort((a, b) => fitMeans[b] - fitMeans[a]).slice(0, k);
  const pickedMean = mean(picked.map((s) => checkMeans[s]));
  const universeMean = mean(symbols.map((s) => checkMeans[s]));

  // Random picks of the same size on the same slice.
  const rnd = makeRng(seed);
  const nullMeans = [];
  for (let r = 0; r < replicates; r++) {
    const pool = [...symbols];
    const pick = [];
    for (let i = 0; i < k; i++) pick.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    nullMeans.push(mean(pick.map((s) => checkMeans[s])));
  }
  nullMeans.sort((a, b) => a - b);
  // percentileOf returns a share; everything below and in the report speaks
  // percent, and mixing the two units is exactly how a 0.64 becomes a "64th".
  const pct = percentileOf(nullMeans, pickedMean) * 100;

  const interval = medianGap(Object.values(bySymbol).find((p) => p?.length > 2) || []);
  const periodsPerYear = interval > 0 ? YEAR_MS / interval : null;
  const capital = capitalPerNotional(leverage);
  const annual = (v) => (periodsPerYear ? (v * periodsPerYear / capital) * 100 : null);

  /*
   * Three outcomes, and only the first is a selection rule. "Beats the universe
   * but not the random null" means the ranking added nothing — the universe
   * average was simply below the average of any five symbols drawn from it.
   */
  let verdict = 'none';
  if (rank.significant && rank.rho > 0 && pct >= 90) verdict = 'persists';
  else if (rank.rho > 0 && pct >= 75) verdict = 'weak';
  else if (pct < 60) verdict = 'none';
  else verdict = 'unclear';

  return {
    symbols: symbols.length, topK: k, rank,
    pickedMeanRate: pickedMean, universeMeanRate: universeMean,
    pickedAnnualPct: annual(pickedMean), universeAnnualPct: annual(universeMean),
    nullPercentile: pct,
    nullMedianRate: quantile(nullMeans, 0.5),
    nullP95AnnualPct: annual(quantile(nullMeans, 0.95)),
    picked, verdict,
    fitPeriods: mean(symbols.map((s) => fit[s].length)),
    checkPeriods: mean(symbols.map((s) => check[s].length)),
  };
}

/* -------------------------------- vault ------------------------------- */

export const VAULT_RATIO = Number(process.env.COINSCOPE_VAULT_RATIO || 0.2);

/**
 * Hold back the most recent slice and do not look at it.
 *
 * Same rule as the strategy vault: everything in the report is computed on the
 * working set, the reserved slice is described only by its size and dates, and
 * opening it is a deliberate, logged act. A measurement you can re-run until it
 * agrees with you is not a measurement.
 */
export function reserveFundingVault(bySymbol, ratio = VAULT_RATIO) {
  const working = {};
  const vault = {};
  for (const [symbol, points] of Object.entries(bySymbol)) {
    if (!points?.length) continue;
    const cut = Math.floor(points.length * (1 - ratio));
    working[symbol] = points.slice(0, cut);
    vault[symbol] = points.slice(cut);
  }
  const vaultPoints = Object.values(vault).reduce((s, p) => s + p.length, 0);
  const times = Object.values(vault).flat().map((p) => p.time).filter(Number.isFinite);
  return {
    working, vault, ratio,
    info: {
      periods: vaultPoints,
      symbols: Object.keys(vault).length,
      from: times.length ? Math.min(...times) : null,
      to: times.length ? Math.max(...times) : null,
    },
  };
}

/* ------------------------------ the report ---------------------------- */

/**
 * The whole picture for one universe of perpetuals.
 *
 * Order matters here: the toll first, because it can disqualify the design
 * before anything else is worth reading; then what the income actually is on
 * capital; then whether a selection rule survives out of sample; then the ways
 * the position can lose money anyway.
 */
export function analyseFunding({
  fundingBySymbol, spotBySymbol = {}, perpBySymbol = {},
  leverage = LEVERAGE, costs = COSTS, topK = 5, vaultRatio = VAULT_RATIO,
  holdDays = null, source = null, measured = null,
}) {
  /*
   * Whether these numbers came off an exchange at all. The offline generator
   * builds each symbol around a fixed mean, so a ranking on it persists by
   * construction and the selection test passes for a reason that has nothing to
   * do with markets. Anything read off the generator has to be labelled, not
   * quietly presented next to real results.
   */
  const fromMarket = measured ?? !/synthetic|generator|генератор/i.test(String(source || ''));
  const reserved = reserveFundingVault(fundingBySymbol, vaultRatio);
  const working = reserved.working;

  const perSymbol = [];
  for (const [symbol, points] of Object.entries(working)) {
    const desc = describeFunding(points, { leverage, costs });
    if (!desc) continue;
    perSymbol.push({
      symbol, ...desc,
      drawdown: fundingDrawdown(points),
      basis: basisRisk(spotBySymbol[symbol] || [], perpBySymbol[symbol] || []),
    });
  }
  perSymbol.sort((a, b) => b.meanRate - a.meanRate);

  // The portfolio view: every settlement of every symbol, equally weighted.
  const allPoints = Object.values(working).flat().filter((p) => Number.isFinite(p.rate));
  const portfolio = describeFunding(
    [...allPoints].sort((a, b) => a.time - b.time), { leverage, costs },
  );
  /*
   * The pooled series has many symbols settling at the same timestamp, so its
   * measured "interval" is meaningless. Take the grid from a single symbol,
   * where it is well defined, and re-annualise.
   */
  const reference = perSymbol.find((r) => r.periodsPerYear > 0);
  if (portfolio && reference) {
    portfolio.intervalHours = reference.intervalHours;
    portfolio.periodsPerYear = reference.periodsPerYear;
    portfolio.annualGross = portfolio.meanRate * reference.periodsPerYear;
    portfolio.annualOnCapital = portfolio.annualGross / capitalPerNotional(leverage);
    portfolio.breakEvenPeriods = portfolio.meanRate > 0
      ? pairRoundTrip(costs) / portfolio.meanRate : Infinity;
    portfolio.breakEvenDays = portfolio.breakEvenPeriods * (reference.intervalHours / 24);
  }

  const curve = harvestCurve(portfolio, { leverage, costs });
  const persistence = persistenceTest(working, { topK, leverage });
  const concentration = meanConcentration(perSymbol);

  /*
   * Compounding is quoted on the selected basket ONLY when the selection rule
   * actually survived — `persists`, nothing weaker.
   *
   * The first live run showed why the earlier threshold was wrong. Persistence
   * came back `weak` (rho 0.34, p = 0.087 — not significant at 5%), and because
   * `weak` was accepted here the report quoted the picked basket's 7.3% a year
   * and printed "doubling in 9.8 years". That is the best slice of noise
   * presented as a plan, which is precisely what the comment above claims to
   * prevent. A rule that cannot clear p < 0.05 does not get to name the rate.
   */
  const ruleSurvived = persistence?.verdict === 'persists';
  const annualForCompounding = ruleSurvived
    ? persistence.pickedAnnualPct
    : (persistence?.universeAnnualPct ?? (portfolio ? portfolio.annualOnCapital * 100 : null));

  const holdBarsFor = (days) => {
    const hours = reference?.intervalHours || 8;
    return Math.max(1, Math.round((days * 24) / hours));
  };
  const intendedHold = holdDays ?? (portfolio && Number.isFinite(portfolio.breakEvenDays)
    ? Math.max(7, Math.ceil(portfolio.breakEvenDays * 2)) : 30);

  // Liquidation risk is measured on the largest symbol with perp candles; it is
  // a property of the leverage and the hold, not of the coin's funding.
  const riskSymbol = Object.keys(perpBySymbol).find((s) => (perpBySymbol[s]?.length || 0) > 200) || null;
  const shortRisk = riskSymbol
    ? shortLegRisk(perpBySymbol[riskSymbol], { holdBars: holdBarsFor(intendedHold), leverage })
    : null;

  const compound = compounding(annualForCompounding);
  if (compound) {
    /*
     * Say which basket the rate came from. "Doubling in N years" reads as a plan
     * either way, and the difference between "the whole universe paid this" and
     * "five coins a ranking picked paid this" is the difference between a
     * measurement and a hope.
     */
    compound.basis = ruleSurvived ? 'picked' : 'universe';
    compound.basisText = ruleSurvived
      ? `Ставка взята по отобранной корзине (топ-${persistence.topK}): отбор подтвердился ` +
        `вне выборки (ρ=${persistence.rank.rho?.toFixed(2)}, p=${persistence.rank.p?.toFixed(3)}).`
      : 'Ставка взята по **всей вселенной**, а не по отобранной корзине: отбор вне выборки ' +
        'не подтвердился, и цитировать доходность пяти выбранных монет значило бы показать ' +
        'лучший срез шума как план.';
  }

  return {
    generatedAt: Date.now(),
    source,
    /** False means every number below describes a generator, not a market. */
    measured: fromMarket,
    leverage,
    capitalPerNotional: capitalPerNotional(leverage),
    roundTripPct: pairRoundTrip(costs) * 100,
    costs: { feeRate: costs.feeRate, slippageRate: costs.slippageRate, crossings: 4 },
    portfolio,
    perSymbol,
    curve,
    persistence,
    compound,
    intendedHoldDays: intendedHold,
    shortLegRisk: shortRisk ? { ...shortRisk, symbol: riskSymbol } : null,
    concentration,
    vault: reserved.info,
    verdict: verdictOf({ portfolio, curve, persistence, shortRisk, concentration, measured: fromMarket }),
  };
}

/**
 * One sentence that says whether this is worth doing, and it is allowed to say
 * no. The strategy work in this project ended at "no" on the evidence; this has
 * to be able to end the same way rather than being graded on having been my own
 * suggestion.
 */
export function verdictOf({ portfolio, curve, persistence, shortRisk, concentration, measured = true }) {
  if (!portfolio) return { code: 'unknown', text: 'Данных не хватает для вывода.' };

  if (!measured) {
    return {
      code: 'synthetic',
      text: 'Эти числа получены на генераторе, а не на бирже. Он строит каждую монету вокруг ' +
        'фиксированной средней ставки, поэтому отбор по прошлому фандингу тут работает **по ' +
        'построению**, а базис выходит ровно нулевым. Ни один вывод отсюда нельзя переносить на ' +
        'рынок: запускать надо с `COINSCOPE_SOURCE=binance`.',
    };
  }

  const annual = portfolio.annualOnCapital * 100;
  const breakEven = portfolio.breakEvenDays;

  if (!(portfolio.meanRate > 0)) {
    /*
     * A negative mean made by ONE symbol is not a verdict about funding, and
     * saying otherwise is the error LABUSDT produced on the first live run:
     * mean −0.0096%, median +0.0042%, nineteen of twenty-four coins positive,
     * and one coin contributing more than the whole negative total. The honest
     * answer names both numbers and says what the aggregate actually describes.
     */
    if (concentration?.dominated && concentration.flipsSign) {
      const c = concentration;
      return {
        code: 'dominated',
        text: `Среднее по выборке отрицательное (${(portfolio.meanRate * 100).toFixed(4)}% за ` +
          `${portfolio.intervalHours.toFixed(0)} ч), **но его делает одна монета**: ` +
          `${c.top.symbol} со ставкой ${(c.top.meanRate * 100).toFixed(4)}% даёт вклад ` +
          `${(c.top.contribution * 100).toFixed(4)}% — больше, чем весь отрицательный итог. ` +
          `Без неё те же данные дают ${(c.pooledWithoutTop * 100).toFixed(4)}% за период. ` +
          `Медианная монета платит ${(c.medianOfSymbols * 100).toFixed(4)}%, положительных — ` +
          `${c.positiveSymbols} из ${c.symbols}. ` +
          'Значит, это утверждение не про сбор фандинга, а про равновзвешенную корзину, в которую ' +
          'попала монета, берущая свою ставку каждые несколько часов. Такую корзину никто не держит, ' +
          'и вывод «фандинг не платит» этими данными **не подтверждается**. Что подтверждается — ' +
          'что состав портфеля здесь важнее самой ставки.',
        annualPct: portfolio.annualOnCapital * 100,
        dominatedBy: c.top.symbol,
      };
    }

    return {
      code: 'negative',
      text: `Средний фандинг на этой выборке отрицательный (${(portfolio.meanRate * 100).toFixed(4)}% за ` +
        `${portfolio.intervalHours.toFixed(0)} ч). Сбор фандинга здесь не приносит дохода, а стоит денег. ` +
        'Обратная сделка не спасает: шорт спота требует занимать монету по ставке, которую никто не ' +
        'публикует заранее.',
    };
  }

  const notes = [];
  if (persistence?.verdict === 'none') {
    notes.push('Выбор монет по прошлому фандингу не работает: отобранные не отличаются от случайных. ' +
      'Значит, это доход всего рынка перпетуалов, а не результат отбора.');
  }
  if (shortRisk && shortRisk.breachShare > 0.01) {
    notes.push(`На плече ${shortRisk.leverage}× за ${shortRisk.holdBars} интервалов рост цены дотягивался ` +
      `до ликвидации шорта в ${(shortRisk.breachShare * 100).toFixed(1)}% окон истории — маржу придётся ` +
      'пополнять, и это не деталь.');
  }

  const code = annual >= 5 ? 'positive' : annual > 0 ? 'thin' : 'negative';
  const head = code === 'positive'
    ? `Положительная доходность: **${annual.toFixed(1)}% в год на вложенный капитал** до налогов, ` +
      `при удержании не меньше ${breakEven.toFixed(1)} дней (столько нужно, чтобы отбить вход и выход).`
    : `Доходность положительная, но тонкая: ${annual.toFixed(1)}% в год на капитал, ` +
      `и позицию надо держать минимум ${breakEven.toFixed(1)} дней только чтобы отбить издержки.`;

  return { code, text: [head, ...notes].join(' '), annualPct: annual, breakEvenDays: breakEven };
}
