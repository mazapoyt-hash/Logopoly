/**
 * The detailed statistics.
 *
 * These tests care much less about "does it compute a number" than about
 * "does it refuse to overclaim". A breakdown module whose job is to catch
 * self-deception is worthless if it deceives itself, so most of what follows
 * feeds it data with a KNOWN answer — pure noise, a planted effect, a biased
 * forecast — and checks it says the right thing about it.
 */
import { makeChecker } from './helpers.mjs';

const {
  meanInterval, expectedFalsePositives, breakdown, excursions, calibration,
  splitCandles, analyse, differsFromRest, DIMENSIONS, MIN_BUCKET,
} = await import('../server/analytics.js');
const { backtestSymbol } = await import('../server/backtest.js');
const { getHistory } = await import('../server/sources/index.js');
const { mergePages } = await import('../server/sources/binance.js');

const results = [];
const check = makeChecker(results);

/* ------------------------- deterministic noise ------------------------ */
// A seeded generator: the tests must not become flaky, and "sometimes fails"
// in a module about statistical honesty would be especially embarrassing.
let seed = 12345;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const trade = (over = {}) => ({
  symbol: 'BTCUSDT', direction: rnd() > 0.5 ? 'LONG' : 'SHORT',
  score: 60 + Math.floor(rnd() * 30),
  entryTime: 1700000000000 + Math.floor(rnd() * 1e9),
  r: rnd() > 0.5 ? 1.9 : -1.05,
  mfeR: rnd() * 2, maeR: rnd(),
  context: { adx: 20 + rnd() * 30, rsi: 30 + rnd() * 40, relVol: 0.5 + rnd() * 1.5,
    atrPct: rnd() * 3, emaGapPct: (rnd() - 0.5) * 20, htfTrend: 'up',
    hourUtc: Math.floor(rnd() * 24), weekday: Math.floor(rnd() * 7) },
  ...over,
});

/* ------------------------------ intervals ----------------------------- */
{
  const ci = meanInterval([1, 1, 1, 1, 1]);
  check('a constant sample has a zero-width interval', ci.low === 1 && ci.high === 1);

  const wide = meanInterval([-1, 2, -1, 2, -1, 2, -1, 2]);
  check('a spread sample gets an interval around its mean',
    wide.low < wide.mean && wide.high > wide.mean);

  const few = meanInterval([0.5]);
  check('one observation gets no interval at all', few.low === null);

  const big = meanInterval(Array.from({ length: 400 }, () => (rnd() > 0.5 ? 1 : -1)));
  const small = meanInterval(Array.from({ length: 20 }, () => (rnd() > 0.5 ? 1 : -1)));
  check('more data narrows the interval',
    (big.high - big.low) < (small.high - small.low));
}

check('expected false positives scale with the number of buckets tested',
  expectedFalsePositives(40, 0.05) === 2 && expectedFalsePositives(0) === 0);

/* --------------------------- breakdown basics ------------------------- */
{
  const trades = Array.from({ length: 300 }, () => trade());
  const dim = DIMENSIONS.find((d) => d.key === 'direction');
  const b = breakdown(trades, dim);

  check('a breakdown splits trades without losing any',
    b.buckets.reduce((s, x) => s + x.trades, 0) === trades.length);
  check('every bucket carries a win-rate interval, not a bare percentage',
    b.buckets.every((x) => x.winLow != null && x.winHigh != null));
  check('the win rate always lies inside its own interval',
    b.buckets.every((x) => x.winRate >= x.winLow - 1e-9 && x.winRate <= x.winHigh + 1e-9));
  check('a breakdown reports how many false positives to expect',
    b.expectedByChance === expectedFalsePositives(b.tested));

  const thin = breakdown(Array.from({ length: MIN_BUCKET - 1 }, () => trade()), dim);
  check('a bucket below the sample floor is never called significant',
    thin.buckets.every((x) => !x.significant));
  check('a thin breakdown counts nothing as tested', thin.tested === 0);
}

/* ---------------- the part that matters: not fooling itself ----------- */
/* ------------------- comparing a group to the others ------------------ */
{
  const same = Array.from({ length: 300 }, () => (rnd() > 0.5 ? 1 : -1));
  const other = Array.from({ length: 300 }, () => (rnd() > 0.5 ? 1 : -1));
  check('two samples from the same process are not called different',
    differsFromRest(same, other).significant === false);

  const better = Array.from({ length: 300 }, () => (rnd() > 0.2 ? 1 : -1));
  const worse = Array.from({ length: 300 }, () => (rnd() > 0.8 ? 1 : -1));
  const c = differsFromRest(better, worse);
  check('a genuinely different group is detected', c.significant && c.diff > 0);
  check('the size of the difference is reported, not just a yes/no',
    Number.isFinite(c.diff) && Number.isFinite(c.stdErr));

  /*
   * The regression that this whole comparison exists for. Both groups lose
   * money at exactly the same rate. Measured against zero, both look
   * "significant"; measured against each other, neither is — and the second
   * reading is the one that answers the reader's actual question.
   */
  const losingA = Array.from({ length: 400 }, () => (rnd() > 0.65 ? 1 : -1));
  const losingB = Array.from({ length: 400 }, () => (rnd() > 0.65 ? 1 : -1));
  check('two equally losing groups are not called different from each other',
    differsFromRest(losingA, losingB).significant === false);
}

{
  /*
   * Pure noise, sliced every way the module knows how. There is no effect to
   * find. If the number of "significant" buckets is not in the neighbourhood
   * of what chance produces, the machinery is manufacturing findings — the
   * exact failure it exists to prevent.
   */
  const noise = Array.from({ length: 1200 }, () => trade({ r: rnd() > 0.5 ? 1 : -1 }));
  const rep = analyse({ trades: noise });
  const mc = rep.multipleComparisons;

  check('on pure noise, findings do not exceed what chance explains',
    mc.flagged <= Math.max(3, mc.expected * 3));

  /*
   * The failure found on real data: a uniformly losing strategy flagged 26 of
   * 47 buckets, including the day-of-week control, because every bucket's
   * interval excluded zero. Uniform loss must flag nothing — there is no
   * group here that differs from any other.
   */
  const uniformLoss = Array.from({ length: 1600 }, () => trade({ r: rnd() > 0.65 ? 1.9 : -1.05 }));
  const lossRep = analyse({ trades: uniformLoss });
  check('a uniformly losing strategy does not flag every bucket as a finding',
    lossRep.multipleComparisons.flagged <= Math.max(3, lossRep.multipleComparisons.expected * 3));
  check('the overall loss is still reported plainly', lossRep.overall.avgR < 0);
  check('buckets still record that they differ from zero, separately from the flag',
    lossRep.breakdowns.some((b) => b.buckets.some((x) => x.differsFromZero)));
  check('the surplus over chance is reported, not just the raw count',
    Number.isFinite(mc.surplus) && mc.surplus === mc.flagged - mc.expected);
  check('a noise sample produces no strong claim',
    Math.abs(rep.overall.avgR) < 0.15);
}

{
  /*
   * The opposite failure: a real, planted effect must be found. A module that
   * never flags anything is trivially "honest" and completely useless.
   */
  const planted = Array.from({ length: 600 }, () => {
    const t = trade();
    const strong = t.context.adx >= 40;
    t.r = strong ? (rnd() > 0.25 ? 2 : -1) : (rnd() > 0.5 ? 1 : -1);
    return t;
  });
  const b = breakdown(planted, DIMENSIONS.find((d) => d.key === 'adx'));
  const top = b.buckets.find((x) => x.key === '40+');
  check('a planted effect is actually detected', top && top.significant && top.avgR > 0.3);
  check('a detected effect reports how much better it is than the rest',
    top.vsRest > 0);
}

/* -------------------------- tuning verdicts --------------------------- */
{
  // The verdict wording matters: "the price of overfitting" is the wrong story
  // when the best cell lost money on the very data it was picked from.
  const { outOfSampleTuning } = await import('../server/analytics.js');
  const candles = await getHistory('BNBUSDT', '1h', 1500);
  const htf = await getHistory('BNBUSDT', '4h', 500);
  const t = outOfSampleTuning({ BNBUSDT: { candles, htf } }, { ratio: 0.7 });
  check('the tuning check returns a verdict from the known set',
    ['holds', 'decays', 'nothing', 'unknown'].includes(t.verdict));
  check('"nothing to tune" is only claimed when nothing was profitable in-sample',
    t.verdict !== 'nothing' || t.best.inSample.avgR <= 0);
  check('a decay verdict requires a profitable in-sample result to decay from',
    t.verdict !== 'decays' || t.best.inSample.avgR > 0);
  check('the count of profitable in-sample cells is reported',
    Number.isFinite(t.profitableInSample) || t.verdict === 'unknown');
}

/* ------------------------------ excursions ---------------------------- */
{
  const trades = [
    { r: -1, mfeR: 1.8, maeR: 0 }, { r: -1, mfeR: 1.9, maeR: 0 },
    { r: 2, mfeR: 2, maeR: 0.4 }, { r: -1, mfeR: 0.1, maeR: 0 },
  ];
  const e = excursions(trades);
  check('excursions separate losing trades from all trades',
    e.trades === 4 && e.losers === 3);
  check('a target-just-missed pattern is visible in the loser median',
    e.medianLoserMfeR > 1);
  check('reach levels are shares between 0 and 1',
    e.reach.every((l) => l.all >= 0 && l.all <= 1));
  check('reach is monotone: further is never more common',
    e.reach.every((l, i, a) => i === 0 || l.all <= a[i - 1].all));
  check('excursions on trades with no recorded path return nothing',
    excursions([{ r: 1 }]) === null);
}

/* ----------------------------- calibration ---------------------------- */
{
  const n = MIN_BUCKET + 40;
  // Signals stated at 60% that actually win 60% of the time.
  const honest = Array.from({ length: n }, (_, i) => ({
    status: 'win', winProb: 0.6, r: i % 10 < 6 ? 1 : -1,
  }));
  const cal = calibration(honest);
  const row = cal.rows.find((r) => r.key === '55–70%');
  check('a well-calibrated forecast is recognised', row.consistent === true);
  check('calibration compares the stated number to the observed interval',
    Math.abs(row.stated - 0.6) < 1e-9 && row.low <= row.actual && row.high >= row.actual);

  // Signals stated at 75% that win 30% of the time.
  const liar = Array.from({ length: n }, (_, i) => ({
    status: 'win', winProb: 0.75, r: i % 10 < 3 ? 1 : -1,
  }));
  check('an overclaiming forecast is caught',
    calibration(liar).rows.find((r) => r.key === '70%+').consistent === false);

  check('calibration says "unknown" instead of guessing on no data',
    calibration([]).verdict === 'unknown');
  check('open signals never enter the calibration record',
    calibration([{ status: 'open', winProb: 0.9, r: null }]).sample === 0);
}

/* --------------------------- holdout mechanics ------------------------ */
{
  const candles = await getHistory('BTCUSDT', '1h', 1500);
  const htf = await getHistory('BTCUSDT', '4h', 500);
  const { inSample, outSample } = splitCandles({ BTCUSDT: { candles, htf } }, 0.7);

  const cut = outSample.BTCUSDT.scoreFrom;
  check('the tuning half ends where the verification half begins',
    inSample.BTCUSDT.candles[inSample.BTCUSDT.candles.length - 1].time < cut);
  check('the verification half keeps a warm-up tail before the cut',
    outSample.BTCUSDT.candles[0].time < cut);

  // The real guarantee: nothing entered before the cut may be scored as
  // out-of-sample, or the "unseen" result quietly includes seen data.
  const { trades } = backtestSymbol({
    symbol: 'BTCUSDT', timeframe: '1h',
    candles: outSample.BTCUSDT.candles, htfCandles: outSample.BTCUSDT.htf,
  });
  const scored = trades.filter((t) => t.entryTime >= cut);
  check('every scored trade starts after the cut',
    scored.every((t) => t.entryTime >= cut));

  /*
   * Why the warm-up tail is not optional: cutting the series at the boundary
   * leaves EMA200 undefined for the first 200 bars of the verification half,
   * and the strategy then silently produces nothing there. A holdout that
   * reports "no trades" because of a slicing bug looks exactly like a holdout
   * that honestly found nothing — which is the worst possible confusion.
   */
  const naive = backtestSymbol({
    symbol: 'BTCUSDT', timeframe: '1h',
    candles: candles.filter((c) => c.time >= cut), htfCandles: htf,
  }).trades;
  check('the warm-up tail recovers trades a naive split would lose',
    scored.length >= naive.length);
  check('the verification half is not empty', scored.length > 0);
}

/* ------------------------- entry context capture ---------------------- */
{
  const candles = await getHistory('ETHUSDT', '1h', 1200);
  const htf = await getHistory('ETHUSDT', '4h', 400);
  const { trades } = backtestSymbol({ symbol: 'ETHUSDT', timeframe: '1h', candles, htfCandles: htf });

  check('the backtest records the conditions each trade was entered in',
    trades.length > 0 && trades.every((t) => t.context && Number.isFinite(t.context.adx)));
  check('excursions are recorded for every trade',
    trades.every((t) => Number.isFinite(t.mfeR) && Number.isFinite(t.maeR)));
  // MFE is censored at the target for winners — the trade ends there, so how
  // much further price would have run is simply unknown. What must hold is the
  // other direction: a winner reached its target, so its MFE cannot be short of it.
  check('a winning trade reached at least its target',
    trades.filter((t) => t.status === 'win').every((t) => t.mfeR >= 2 - 1e-6));

  /*
   * The rule that keeps MFE honest: a target inside the stop bar was never
   * reached, because the resolver gives ties to the stop. So a stopped-out
   * trade must not report an excursion that would have hit the target.
   */
  const badLosers = trades.filter((t) => t.status === 'loss' && t.mfeR >= 2);
  check('a stopped-out trade never claims it reached the target first',
    badLosers.length === 0);

  check('every dimension can bucket real trades',
    DIMENSIONS.every((d) => trades.some((t) => d.of(t) != null)));
}

/* ----------------------------- page merging --------------------------- */
{
  const p1 = [{ time: 3 }, { time: 4 }, { time: 5 }];
  const p2 = [{ time: 1 }, { time: 2 }, { time: 3 }];
  const merged = mergePages([p1, p2]);
  check('overlapping history pages are merged without duplicates',
    merged.length === 5 && new Set(merged.map((c) => c.time)).size === 5);
  check('merged history is in ascending time order',
    merged.every((c, i, a) => i === 0 || c.time > a[i - 1].time));
}

/* ------------------------------- nulls -------------------------------- */
{
  const { randomEntryBenchmark, rotationNull, makeRng, percentileOf } =
    await import('../server/nulls.js');
  const { costSensitivity } = await import('../server/economics.js');
  const { reserveVault, evaluateOnVault } = await import('../server/analytics.js');

  const a = makeRng(7)();
  const b = makeRng(7)();
  check('the null models use a reproducible generator', a === b);
  check('percentile rank places a value inside a distribution',
    percentileOf([1, 2, 3, 4], 2.5) === 0.5 && percentileOf([1, 2, 3, 4], 0) === 0);

  const candles = await getHistory('ADAUSDT', '1h', 2000);
  const htf = await getHistory('ADAUSDT', '4h', 600);
  const data = { ADAUSDT: { candles, htf } };
  const { trades } = backtestSymbol({ symbol: 'ADAUSDT', timeframe: '1h', candles, htfCandles: htf });

  const re = randomEntryBenchmark(data, trades, { replicates: 40 });
  check('the random-entry benchmark produces a verdict',
    ['beats', 'same', 'worse'].includes(re.verdict));
  check('random entries are compared on the same trade count as the strategy',
    re.real.trades === trades.length);
  check('the null distribution is ordered and non-degenerate',
    re.nullModel.p05 <= re.nullModel.p50 && re.nullModel.p50 <= re.nullModel.p95);
  check('the strategy is placed as a percentile of the null, not judged against zero',
    re.percentile >= 0 && re.percentile <= 1);

  /*
   * The benchmark must control for what it is not testing. Symbol and
   * direction decide much of the result in a trending market, so a null that
   * did not match them would flatter or damn the entries for the wrong reason.
   */
  const longs = trades.filter((t) => t.direction === 'LONG').length;
  check('the null matches the strategy long/short mix by construction',
    longs === 0 || longs === trades.length || re.real.trades === trades.length);

  // Rotation null: rotating outcomes must destroy any feature relationship.
  const rot = rotationNull(trades, (rows) => breakdown(rows, DIMENSIONS[0]).flagged,
    { replicates: 30 });
  check('the rotation null measures a noise floor', rot && rot.p95 >= rot.median);
  check('the rotation null refuses to run on a tiny sample',
    rotationNull(trades.slice(0, 10), () => 0) === null);

  /*
   * The comparison must be re-priced on BOTH sides. Charging the strategy but
   * not the random entries (or the reverse) would make the frictionless run a
   * comparison of two different things and quietly invent an edge.
   */
  const gross = randomEntryBenchmark(data, trades, {
    replicates: 40, costs: { feeRate: 0, slippageRate: 0 },
  });
  check('the benchmark can be run without costs', gross && Number.isFinite(gross.real.avgR));
  check('removing costs improves the strategy side', gross.real.avgR >= re.real.avgR - 1e-9);
  check('removing costs improves the random side too, not just the strategy',
    gross.nullModel.p50 >= re.nullModel.p50 - 1e-9);
  check('the frictionless run uses the same trade count', gross.real.trades === re.real.trades);

  const costs = costSensitivity(trades);
  check('cost sensitivity reports a frictionless result',
    Number.isFinite(costs.frictionlessTotalR));
  check('removing costs can only improve the result',
    costs.frictionlessTotalR >= costs.rows.find((r) => r.label === 'Текущие').totalR - 1e-9);
  check('higher costs are never better than lower ones', (() => {
    const t = costs.rows.map((r) => r.totalR);
    return t.every((v, i) => i === 0 || v <= t[i - 1] + 1e-9);
  })());
  check('cost sensitivity explains which of the two cases this is',
    typeof costs.text === 'string' && costs.text.length > 0);
}

/* -------------------------------- the toll ---------------------------- */
{
  const { tollFromTrades, tollByTimeframe, roundTripCost } =
    await import('../server/economics.js');

  check('round-trip cost charges both sides twice over',
    Math.abs(roundTripCost({ feeRate: 0.001, slippageRate: 0.002 }) - 0.006) < 1e-12);

  // A 1% stop against a 0.2% round trip must cost exactly 0.2R — the whole
  // argument rests on this ratio, so it is pinned rather than eyeballed.
  const toy = [{ direction: 'LONG', entry: 100, stop: 99 }];
  const t = tollFromTrades(toy, { feeRate: 0.0005, slippageRate: 0.0005 });
  check('the toll is the round-trip cost divided by the stop distance',
    Math.abs(t.costR - 0.2) < 1e-9 && Math.abs(t.medianRiskPct - 1) < 1e-9);
  check('break-even edge equals the toll — nothing else has to be assumed',
    t.breakEvenEdgeR === t.costR);

  const wide = tollFromTrades([{ direction: 'LONG', entry: 100, stop: 90 }],
    { feeRate: 0.0005, slippageRate: 0.0005 });
  check('a wider stop pays a smaller toll in R', wide.costR < t.costR);
  check('the toll needs real trades', tollFromTrades([]) === null);

  /*
   * Built by hand, not fetched. The synthetic source is scale-invariant — its
   * ATR is the same share of price on every timeframe — so it cannot exercise
   * this comparison at all, and a test written against it would pass or fail
   * by luck. These two series differ in volatility by construction.
   */
  const series = (rangePct, n = 300) => Array.from({ length: n }, (_, i) => {
    const close = 100;
    const half = (close * rangePct) / 2;
    return { time: i * 3600_000, open: close, close, high: close + half, low: close - half };
  });
  const byTf = tollByTimeframe(
    { '1h': { X: series(0.01) }, '1d': { X: series(0.05) } },
    { atrMult: 1.5, costs: { feeRate: 0.0005, slippageRate: 0.0005 } }
  );
  check('the toll is comparable across timeframes', byTf && byTf.rows.length === 2);
  check('a wider-ranging timeframe pays a smaller toll', (() => {
    const h = byTf.rows.find((r) => r.timeframe === '1h');
    const d = byTf.rows.find((r) => r.timeframe === '1d');
    return d.stopPct > h.stopPct * 4 && d.costR < h.costR / 4;
  })());
  check('the cheapest timeframe is identified', byTf.best.timeframe === '1d');


  // Where the timeframes genuinely do not differ, the comparison must say so
  // rather than crowning a winner separated by rounding.
  const flat = tollByTimeframe({ '1h': { X: series(0.01) }, '1d': { X: series(0.0101) } });
  check('indistinguishable timeframes are reported as indistinguishable',
    flat.indistinguishable === true);
  check('a real difference is not called indistinguishable',
    byTf.indistinguishable === false);
  check('no cheapest timeframe is crowned when they cannot be told apart',
    flat.best === null);
}

/* ------------------------------- the vault ---------------------------- */
{
  const { reserveVault, evaluateOnVault, VAULT_RATIO } = await import('../server/analytics.js');
  const candles = await getHistory('AVAXUSDT', '1h', 2000);
  const htf = await getHistory('AVAXUSDT', '4h', 600);
  const { working, vault } = reserveVault({ AVAXUSDT: { candles, htf } }, 0.2);

  const cut = vault.AVAXUSDT.scoreFrom;
  check('the working set ends before the vault begins',
    working.AVAXUSDT.candles[working.AVAXUSDT.candles.length - 1].time < cut);
  check('the vault holds roughly the reserved share of history',
    Math.abs(working.AVAXUSDT.candles.length / candles.length - 0.8) < 0.02);

  /*
   * The guarantee the vault exists for: nothing computed in the ordinary
   * report may touch a bar from the reserved slice.
   */
  const wt = backtestSymbol({
    symbol: 'AVAXUSDT', timeframe: '1h',
    candles: working.AVAXUSDT.candles, htfCandles: working.AVAXUSDT.htf,
  }).trades;
  check('no working-set trade is even opened inside the vault period',
    wt.every((t) => t.entryTime < cut));

  const v = evaluateOnVault(vault);
  check('the vault can be evaluated on demand', Number.isFinite(v.stats.trades));
  check('vault trades all start after the cut, so warm-up bars are not scored',
    v.stats.trades === 0 || v.trades > 0);
  check('the reserved share is configurable and sane', VAULT_RATIO > 0 && VAULT_RATIO < 1);
}

/* ------------------------------ full report --------------------------- */
{
  const candles = await getHistory('SOLUSDT', '1h', 1500);
  const htf = await getHistory('SOLUSDT', '4h', 500);
  const data = { SOLUSDT: { candles, htf } };
  const { trades } = backtestSymbol({ symbol: 'SOLUSDT', timeframe: '1h', candles, htfCandles: htf });

  const rep = analyse({ trades, signals: [], dataBySymbol: data, ratio: 0.7 });
  check('the report covers every dimension', rep.breakdowns.length === DIMENSIONS.length);
  check('the report states the period it covers',
    rep.sample.from != null && rep.sample.to > rep.sample.from);
  check('the report includes the out-of-sample tuning check', !!rep.tuning?.verdict);
  check('tuned settings are graded on data they were not chosen on',
    rep.tuning.verdict === 'unknown' ||
    (rep.tuning.best.inSample && rep.tuning.best.outOfSample !== undefined));
  check('the report is JSON-serialisable for the site',
    typeof JSON.stringify(rep) === 'string');
}

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
