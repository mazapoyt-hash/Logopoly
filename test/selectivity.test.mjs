/**
 * What raising the bar buys.
 *
 * The failure mode this module exists to catch is seductive: sweep seven
 * thresholds, keep the best one, and report it. That procedure finds something
 * on data with no relationship in it at all, every time, because the maximum of
 * seven draws is not a typical draw. So most of the tests below are aimed at
 * the CONTROL rather than at the statistic — a sweep that cannot call a
 * decorative score empty is worse than no sweep, since it launders noise into
 * a number that looks like a decision.
 *
 * The second target is the priced-in-sample part. Selectivity always makes the
 * surviving trades look better and always makes them fewer, and the second
 * effect is the one a reader forgets. `yearsNeeded` is the antidote and it has
 * to stay honest in the direction that hurts.
 */
import { makeChecker, close } from './helpers.mjs';
import {
  THRESHOLDS, tradesNeeded, spanYearsOf, sweep, rotateScores, liftsOf,
  sweepNull, splitTrades, bestThreshold, selectivity, describeSelectivity,
} from '../server/selectivity.js';
import { makeRng } from '../server/nulls.js';

const results = [];
const check = makeChecker(results);

const YEAR = 365.25 * 24 * 3600 * 1000;
const T0 = Date.UTC(2021, 0, 1);

/**
 * Build a trade list where `edgePerScore` controls how much the score is worth.
 * At 0 the score is pure decoration — that is the case every control has to
 * call empty.
 */
function makeTrades(n, { edgePerScore = 0, base = -0.1, seed = 7, years = 4 } = {}) {
  const rng = makeRng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const score = 60 + Math.floor(rng() * 35);
    const noise = (rng() - 0.5) * 2;
    out.push({
      symbol: `C${i % 5}USDT`,
      direction: i % 2 ? 'LONG' : 'SHORT',
      score,
      entryTime: T0 + (i / n) * years * YEAR,
      r: base + noise + edgePerScore * (score - 60),
    });
  }
  return out;
}

/* ----------------------------- the price of proof ---------------------- */

check('a 0.1R edge takes 400 trades to tell from zero', tradesNeeded(0.1) === 400);
check('a 0.2R edge takes 100', tradesNeeded(0.2) === 100);
check('a 0.05R edge takes 1600', tradesNeeded(0.05) === 1600);
check('a 0.02R edge takes 10000', tradesNeeded(0.02) === 10000);
check('halving the edge quadruples the sample',
  tradesNeeded(0.1) / tradesNeeded(0.2) === 4);
check('a non-positive edge has no sample size that proves it',
  tradesNeeded(0) === null && tradesNeeded(-0.1) === null);
check('nonsense in is refused rather than passed through',
  tradesNeeded(NaN) === null && tradesNeeded(Infinity) === null
  && tradesNeeded(undefined) === null);

/* ---------------------------------- span ------------------------------- */

check('span is measured in entry times, not in trade count',
  close(spanYearsOf(makeTrades(200, { years: 4 })), 4, 0.05));
check('span of fewer than two trades is zero',
  spanYearsOf([]) === 0 && spanYearsOf([{ entryTime: T0 }]) === 0);
check('span does not assume the list arrives sorted', (() => {
  const t = makeTrades(100, { years: 3 });
  return spanYearsOf([...t].reverse()) === spanYearsOf(t);
})());

/* ---------------------------------- sweep ------------------------------ */

{
  const trades = makeTrades(300);
  const rows = sweep(trades);
  check('the sweep returns one row per threshold, in order',
    rows.length === THRESHOLDS.length
    && rows.every((r, i) => r.threshold === THRESHOLDS[i]));
  check('share is trades kept over trades offered',
    rows.every((r) => close(r.share, r.trades / trades.length)));
}

check('raising the bar can never keep more trades', (() => {
  const rows = sweep(makeTrades(400));
  return rows.every((r, i) => i === 0 || r.trades <= rows[i - 1].trades);
})());

check('the lowest bar keeps everything when nothing scores beneath it', (() => {
  const rows = sweep(makeTrades(250));
  return rows[0].trades === 250 && rows[0].share === 1;
})());

check('per-year is the kept count divided by the span', (() => {
  const trades = makeTrades(400, { years: 5 });
  const span = spanYearsOf(trades);
  return sweep(trades).every((r) => !r.trades || close(r.perYear, r.trades / span, 1e-9));
})());

check('a real per-score edge shows up as a rising average', (() => {
  const rows = sweep(makeTrades(2000, { edgePerScore: 0.02, seed: 11 }))
    .filter((r) => r.trades >= 20);
  return rows.at(-1).avgR > rows[0].avgR + 0.2;
})());

check('an empty subset reports nulls rather than a confident zero', (() => {
  const [row] = sweep(makeTrades(100), [200]);
  return row.trades === 0 && row.avgR === null && row.winRate === null
    && row.yearsNeeded === null;
})());

check('years needed is quoted only where the average is positive',
  sweep(makeTrades(600, { base: -0.5 })).every((r) => r.avgR > 0 || r.yearsNeeded === null));

check('years needed is the required sample at the surviving rate',
  sweep(makeTrades(1500, { edgePerScore: 0.02, seed: 3 }))
    .every((r) => r.yearsNeeded == null
      || close(r.yearsNeeded, r.tradesNeeded / r.perYear, 1e-6)));

/*
 * The trap the priced statistic exists for: a higher bar looks cleaner while
 * making the evidence strictly harder to collect. Here the planted edge is
 * uniform per score point, so a higher bar means a bigger edge on fewer trades
 * — and the years column has to fall, not rise, for that to be read correctly.
 */
check('a bigger edge on a thinner subset can still be the faster proof', (() => {
  const rows = sweep(makeTrades(3000, { edgePerScore: 0.01, base: -0.1, seed: 19 }))
    .filter((r) => r.yearsNeeded != null);
  return rows.length >= 2 && rows.at(-1).yearsNeeded < rows[0].yearsNeeded;
})());

/* ------------------------------- the rotation -------------------------- */

{
  const trades = makeTrades(200);
  const rotated = rotateScores(trades, 37);
  const key = (list) => list.map((t) => t.score).sort((a, b) => a - b).join(',');
  check('rotation preserves the score multiset exactly', key(rotated) === key(trades));
  check('rotation leaves outcomes untouched',
    rotated.every((t, i) => t.r === trades[i].r));
  check('rotation keeps every threshold subset the same size',
    THRESHOLDS.every((th) =>
      rotated.filter((t) => t.score >= th).length
      === trades.filter((t) => t.score >= th).length));
}

check('rotation actually re-pairs: a planted edge does not survive it', (() => {
  const trades = makeTrades(1500, { edgePerScore: 0.02, seed: 5 });
  const spread = (list) => {
    const rows = sweep(list).filter((r) => r.trades >= 20);
    return rows.at(-1).avgR - rows[0].avgR;
  };
  return spread(trades) > spread(rotateScores(trades, 613)) + 0.1;
})());

check('a zero offset is the identity, which is why the null never draws one', (() => {
  const trades = makeTrades(80);
  return rotateScores(trades, 0).every((t, i) => t.score === trades[i].score);
})());

/* ---------------------------------- lift ------------------------------- */

check('lift is measured against the unfiltered average, not against zero', (() => {
  const rows = sweep(makeTrades(400));
  return close(liftsOf(rows, rows[0].avgR)[0], 0);
})());

check('lift is null where a row has no trades',
  liftsOf(sweep(makeTrades(100), [60, 200]), -0.1)[1] === null);

/* ------------------------- the cost of looking seven times -------------- */

check('the null declines to speak on a sample too small to rotate',
  sweepNull(makeTrades(40)) === null);

check('the best-lift distribution is ordered', (() => {
  const n = sweepNull(makeTrades(600), THRESHOLDS, { replicates: 60 });
  return n.bestLift.p95 >= n.bestLift.p50;
})());

/*
 * The whole reason this control exists. If the best of seven correlated draws
 * were not higher than a typical single draw, the sweep would need no
 * correction — and every "best threshold" ever reported would be honest.
 */
check('searching seven thresholds costs something', (() => {
  const n = sweepNull(makeTrades(800, { seed: 23 }), THRESHOLDS, { replicates: 80 });
  const singles = n.perThreshold.filter((p) => p.samples > 0).map((p) => p.p50);
  return n.bestLift.p50 > Math.max(...singles);
})());

check('the null is deterministic for a fixed seed', (() => {
  const trades = makeTrades(400);
  return sweepNull(trades, THRESHOLDS, { replicates: 40, seed: 99 }).bestLift.p95
    === sweepNull(trades, THRESHOLDS, { replicates: 40, seed: 99 }).bestLift.p95;
})());

check('the null moves with the seed, or it is not sampling anything', (() => {
  const trades = makeTrades(400);
  return sweepNull(trades, THRESHOLDS, { replicates: 40, seed: 1 }).bestLift.p95
    !== sweepNull(trades, THRESHOLDS, { replicates: 40, seed: 2 }).bestLift.p95;
})());

check('the null drops thresholds that leave too few trades to mean anything',
  sweepNull(makeTrades(300), THRESHOLDS, { replicates: 30, minTrades: 200 })
    .perThreshold.filter((p) => p.samples > 0).length < THRESHOLDS.length);

/* -------------------------------- the split ---------------------------- */

{
  const trades = makeTrades(300);
  const { tune, test: held } = splitTrades(trades, 0.7);
  check('the split cuts by time and loses nothing',
    tune.length + held.length === 300);
  check('nothing in the reserved slice predates the slice that chose',
    Math.max(...tune.map((t) => t.entryTime)) <= Math.min(...held.map((t) => t.entryTime)));
}

check('the split sorts before cutting, so shuffled input splits identically', (() => {
  const trades = makeTrades(200);
  const a = splitTrades(trades, 0.7).tune.map((t) => t.entryTime);
  const b = splitTrades([...trades].reverse(), 0.7).tune.map((t) => t.entryTime);
  return a.every((v, i) => v === b[i]);
})());

check('the split does not reorder its input', (() => {
  const trades = makeTrades(100);
  const before = trades.map((t) => t.entryTime);
  splitTrades(trades, 0.5);
  return trades.every((t, i) => t.entryTime === before[i]);
})());

/* ----------------------------- choosing a bar -------------------------- */

check('the chosen bar is the best average among bars with enough trades', (() => {
  const trades = makeTrades(1500, { edgePerScore: 0.02, seed: 13 });
  const rows = sweep(trades).filter((r) => r.trades >= 20);
  return bestThreshold(trades).avgR === Math.max(...rows.map((r) => r.avgR));
})());

check('a bar thinner than the minimum is not eligible, however good it looks',
  bestThreshold(makeTrades(300), THRESHOLDS, { minTrades: 100 }).trades >= 100);

check('no eligible bar means no choice, not a bad choice',
  bestThreshold(makeTrades(100), THRESHOLDS, { minTrades: 5000 }) === null);

/* ------------------------------ the verdict ---------------------------- */

check('too little data produces no verdict at all',
  selectivity(makeTrades(20)) === null && selectivity([]) === null
  && selectivity(null) === null);

check('trades with no score are dropped, not counted as zero', (() => {
  const trades = makeTrades(400);
  for (let i = 0; i < 100; i++) delete trades[i].score;
  return selectivity(trades, { replicates: 30 }).base.trades === 300;
})());

/*
 * The calibration test. edgePerScore is 0, so the score is generated
 * independently of the outcome and any verdict above `noise` is the detector
 * failing rather than a discovery. Run over several seeds because a single
 * seed tests the seed.
 */
check('a decorative score is never called an edge', (() => {
  const verdicts = [2, 8, 21, 44, 57].map((seed) =>
    selectivity(makeTrades(700, { edgePerScore: 0, seed }), { replicates: 60 }).verdict);
  return verdicts.every((v) => v === 'none' || v === 'noise');
})());

check('a planted per-score edge is found', (() => {
  const rep = selectivity(makeTrades(2000, { edgePerScore: 0.02, base: -0.3, seed: 6 }),
    { replicates: 60 });
  return (rep.verdict === 'edge' || rep.verdict === 'thin')
    && rep.best.lift > 0 && rep.best.percentile === 1;
})());

check('the reserved slice is smaller than the sample and really exists', (() => {
  const rep = selectivity(makeTrades(1200, { edgePerScore: 0.01, seed: 4 }), { replicates: 30 });
  return rep.reserved.from > 0 && rep.reserved.trades > 0
    && rep.reserved.trades < rep.base.trades;
})());

check('the same trades give the same verdict twice', (() => {
  const trades = makeTrades(800, { edgePerScore: 0.01, seed: 15 });
  const a = selectivity(trades, { replicates: 40 });
  const b = selectivity(trades, { replicates: 40 });
  return a.verdict === b.verdict && a.best.percentile === b.best.percentile;
})());

check('every row carries the noise floor it has to beat', (() => {
  const rep = selectivity(makeTrades(700), { replicates: 40 });
  return rep.rows.filter((r) => r.trades >= 20)
    .every((r) => typeof r.nullP95 === 'number' && r.beatsNull === (r.lift > r.nullP95));
})());

/*
 * The honest reading of the real data: a higher bar makes the average less bad
 * without ever crossing zero. That must not read as success — `none` is not a
 * softer `noise`, it is the case where the lever does not exist at all.
 */
check('a bar that only shrinks the loss is not a lever', (() => {
  const rep = selectivity(makeTrades(900, { base: -1.5, edgePerScore: 0.01, seed: 17 }),
    { replicates: 40 });
  return rep.verdict === 'none' && rep.text.includes('не прибыльнее');
})());

check('the verdict text names the threshold it is talking about', (() => {
  const rep = selectivity(makeTrades(2000, { edgePerScore: 0.02, base: -0.3, seed: 6 }),
    { replicates: 40 });
  return rep.text.includes(String(rep.reserved?.threshold ?? rep.best?.threshold));
})());

check('`thin` says how many years the evidence would take', (() => {
  const text = describeSelectivity({
    verdict: 'thin',
    best: { threshold: 80, lift: 0.05, tradesNeeded: 1600, perYear: 12, yearsNeeded: 133 },
    reserved: { threshold: 80, avgR: 0.04, trades: 31 },
    base: { avgR: -0.1 },
  });
  return text.includes('133') && text.includes('1600');
})());

check('every verdict has words of its own', (() => {
  const seen = new Set();
  for (const verdict of ['none', 'noise', 'fragile', 'thin', 'edge']) {
    const text = describeSelectivity({
      verdict,
      best: { threshold: 75, lift: 0.1, tradesNeeded: 400, perYear: 10, yearsNeeded: 40 },
      reserved: { threshold: 75, avgR: 0.05, baseAvgR: -0.1, trades: 60 },
      bestPercentile: 0.9,
      base: { avgR: -0.1 },
    });
    if (text.length < 40 || seen.has(text)) return false;
    seen.add(text);
  }
  return true;
})());

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
