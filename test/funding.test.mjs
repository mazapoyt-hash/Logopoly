/**
 * Funding harvest: the arithmetic, and the guards against flattering it.
 *
 * The numbers here are hand-built, not generated, wherever a claim depends on
 * the data having a specific shape. A test that passes because the generator
 * happens to be scale-invariant is worse than no test: it certifies the
 * assertion while checking nothing, which is exactly how the timeframe-toll
 * test passed by luck earlier in this project.
 */
import {
  pairRoundTrip, capitalPerNotional, describeFunding, fundingDrawdown,
  harvestCurve, compounding, basisRisk, shortLegRisk, spearman,
  splitFunding, persistenceTest, reserveFundingVault, analyseFunding, verdictOf,
} from '../server/funding.js';
import {
  parseFunding, mergeByTime, medianIntervalMs, selectPerpUniverse, syntheticFunding,
} from '../server/sources/funding.js';

const results = [];
const check = (name, ok) => {
  results.push([name, !!ok]);
  console.log(`  ${ok ? '✓' : '❌'} ${name}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const HOUR = 3600_000;
/** A series with an exact mean, so every derived number is checkable by hand. */
const series = (rates, { intervalMs = 8 * HOUR, start = 1_700_000_000_000 } = {}) =>
  rates.map((rate, i) => ({ time: start + i * intervalMs, rate, markPrice: 100 }));

/* ------------------------------- parsing ------------------------------ */
{
  const rows = [
    { symbol: 'BTCUSDT', fundingTime: 2000, fundingRate: '0.0001', markPrice: '60000' },
    { symbol: 'BTCUSDT', fundingTime: 1000, fundingRate: '-0.00005', markPrice: '59000' },
  ];
  const parsed = parseFunding(rows);
  check('funding rows are parsed into numbers', parsed[0].rate === -0.00005);
  check('funding rows come back in time order', parsed[0].time < parsed[1].time);
  check('a negative rate survives parsing as negative', parsed.some((p) => p.rate < 0));

  let threw = false;
  try { parseFunding([{ fundingTime: 'x', fundingRate: '0.1' }]); } catch { threw = true; }
  check('a bad timestamp is rejected rather than silently NaN', threw);

  const merged = mergeByTime([parsed, parsed, [{ time: 3000, rate: 0, markPrice: null }]]);
  check('overlapping pages are de-duplicated', merged.length === 3);
  check('a duplicate settlement cannot be counted twice',
    merged.filter((p) => p.time === 1000).length === 1);
}

/* ---------------------- the interval is measured ---------------------- */
{
  const eight = series([0, 0, 0, 0, 0]);
  check('an 8h grid is measured as 8h', medianIntervalMs(eight) === 8 * HOUR);

  const four = series([0, 0, 0, 0, 0], { intervalMs: 4 * HOUR });
  check('a 4h grid is measured as 4h, not assumed to be 8h',
    medianIntervalMs(four) === 4 * HOUR);

  /*
   * The reason the median is used. A schedule change leaves one enormous gap; a
   * mean would be dragged off the grid the series actually sits on, and the
   * annualisation factor would then be wrong for every point rather than one.
   */
  const changed = [...series([0, 0, 0, 0])];
  changed.push({ time: changed[3].time + 40 * 24 * HOUR, rate: 0, markPrice: 100 });
  changed.push({ time: changed[4].time + 8 * HOUR, rate: 0, markPrice: 100 });
  check('one huge gap does not move the measured interval',
    medianIntervalMs(changed) === 8 * HOUR);

  const a = describeFunding(series(new Array(60).fill(0.0001)));
  const b = describeFunding(series(new Array(60).fill(0.0001), { intervalMs: 4 * HOUR }));
  check('a 4h symbol is annualised at twice the 8h yield, not the same',
    near(b.annualGross / a.annualGross, 2, 1e-6));
}

/* --------------------------------- toll ------------------------------- */
{
  const trip = pairRoundTrip({ feeRate: 0.0005, slippageRate: 0.0005 });
  check('a delta-neutral round trip charges four crossings, not two',
    near(trip, 0.004));

  check('capital per notional is above 1 — the spot leg is paid in full',
    capitalPerNotional(3) > 1);
  check('higher leverage on the short needs less capital',
    capitalPerNotional(10) < capitalPerNotional(2));
  check('capital never falls below the spot leg however high the leverage',
    capitalPerNotional(1000) > 1);

  /*
   * The number the whole case rests on. 0.40% of notional to get in and out,
   * 0.01% collected every 8 hours: forty settlements, a little over thirteen
   * days, before the position has paid for its own execution.
   */
  const d = describeFunding(series(new Array(200).fill(0.0001)));
  check('break-even is cost divided by income per settlement',
    near(d.breakEvenPeriods, 40, 1e-6));
  check('break-even is also reported in days', near(d.breakEvenDays, 40 / 3, 1e-6));

  const negative = describeFunding(series(new Array(200).fill(-0.0001)));
  check('with negative funding there is no break-even hold at all',
    negative.breakEvenPeriods === Infinity);
}

/* ------------------- notional versus capital, the trap ---------------- */
{
  const d = describeFunding(series(new Array(200).fill(0.0001)), { leverage: 3 });
  check('yield on notional is funding times settlements per year',
    near(d.annualGross, 0.0001 * (365 * 3), 1e-9));
  check('yield on capital is strictly lower than on notional',
    d.annualOnCapital < d.annualGross);
  check('the gap is exactly the capital requirement',
    near(d.annualGross / d.annualOnCapital, capitalPerNotional(3), 1e-9));
}

/* ------------------------------ drawdown ------------------------------ */
{
  const dd = fundingDrawdown(series([0.001, 0.001, -0.0005, -0.0005, -0.0005, 0.001]));
  check('the worst stretch is measured on the cumulative curve',
    near(dd.maxDrawdown, 0.0015, 1e-12));
  check('the longest run of paying instead of collecting is counted',
    dd.longestNegativeRun === 3);
  check('a positive run resets the negative streak',
    fundingDrawdown(series([-0.001, 0.001, -0.001])).longestNegativeRun === 1);
  check('an all-positive series has no drawdown',
    fundingDrawdown(series([0.001, 0.001, 0.001])).maxDrawdown === 0);
}

/* ---------------------------- hold curve ------------------------------ */
{
  const d = describeFunding(series(new Array(500).fill(0.0001)));
  const curve = harvestCurve(d, { holds: [1, 7, 14, 30, 365], leverage: 3 });

  check('a one-day hold loses money — it only pays its own fees',
    !curve.rows[0].profitable);
  check('the break-even hold sits between a week and a month',
    !curve.rows[1].profitable && curve.rows.find((r) => r.days === 30).profitable);
  check('net annualised rises with the hold, because costs are paid once',
    curve.rows[4].annualPct > curve.rows[3].annualPct);
  check('the ceiling is the cost-free yield on capital',
    near(curve.ceilingAnnualPct, d.annualOnCapital * 100, 1e-9));
  check('no hold beats the ceiling',
    curve.rows.every((r) => r.annualPct <= curve.ceilingAnnualPct + 1e-9));

  /*
   * The curve must not be read as "hold forever". It grows the income and
   * nothing else; the risks that grow with the hold are measured separately,
   * and the report has to say so rather than letting the table argue alone.
   */
  check('the curve reports the hold where profitability starts',
    curve.firstProfitable && curve.firstProfitable.days >= 7);

  const losing = harvestCurve(describeFunding(series(new Array(500).fill(-0.0001))), { holds: [30, 365] });
  check('a negative rate is profitable at no hold whatsoever',
    losing.rows.every((r) => !r.profitable));
}

/* ---------------------------- compounding ----------------------------- */
{
  const c = compounding(10, { stake: 100, years: [1, 7, 10] });
  check('compounding multiplies, it does not add',
    c.rows[1].factor > 1 + 0.1 * 7);
  check('doubling time at 10% is a little over seven years',
    c.doublingYears > 7 && c.doublingYears < 7.5);
  check('$100 at 10% for a decade is about $259', Math.round(c.rows[2].value) === 259);

  const zero = compounding(0);
  check('a zero rate has no doubling time', zero.doublingYears === null && !zero.positive);
  const neg = compounding(-5);
  check('a negative rate compounds downward', neg.rows[0].factor < 1 && !neg.positive);
}

/* ------------------------------- basis -------------------------------- */
{
  const n = 200;
  const spot = [];
  const perp = [];
  for (let i = 0; i < n; i++) {
    const price = 100 + Math.sin(i / 7) * 10;              // the shared move
    const premium = 0.001 + Math.sin(i / 3) * 0.001;       // the part that is not
    spot.push({ time: i * HOUR, close: price, high: price, low: price });
    perp.push({ time: i * HOUR, close: price * (1 + premium), high: price * (1 + premium), low: price * (1 + premium) });
  }

  const b = basisRisk(spot, perp);
  check('basis is measured on the difference, not on the price',
    b.meanPct > 0.05 && b.meanPct < 0.15);
  check('a large shared price move does not enter the basis', b.sdPct < 0.2);
  check('the basis swing is compared against the round trip',
    b.swingVsTripCost > 0 && b.swingVsTripCost < 1);

  check('a real basis is not flagged as degenerate', !b.degenerate);

  // Timestamps that do not line up must not be paired by position.
  const shifted = perp.map((c) => ({ ...c, time: c.time + 7 }));
  check('unaligned candles produce no basis rather than a fabricated one',
    basisRisk(spot, shifted) === null);
  check('too little overlap gives null, not a number from five points',
    basisRisk(spot.slice(0, 5), perp.slice(0, 5)) === null);

  /*
   * The flattering failure. Hand in one series as both legs — which is what the
   * offline generator does, having no separate perpetual — and a naive basis
   * reads 0.00%: perfect neutrality, the single most attractive number the trade
   * could possibly show, and entirely an artefact.
   */
  const same = basisRisk(spot, spot);
  check('one series handed in as both legs is flagged, not reported as neutral',
    same.degenerate === true);
  check('a degenerate basis refuses to quote a swing against the costs',
    same.swingVsTripCost === null);
}

/* ------------------------- short-leg liquidation ---------------------- */
{
  // A quiet market: nothing rises more than a couple of percent in a day.
  const quiet = [];
  for (let i = 0; i < 600; i++) {
    const p = 100 + Math.sin(i / 20);
    quiet.push({ time: i * HOUR, close: p, high: p + 0.3, low: p - 0.3, open: p });
  }
  const sQuiet = shortLegRisk(quiet, { holdBars: 24, leverage: 3 });
  check('a 3× short liquidates about 33% above entry',
    sQuiet.liquidationPct > 32 && sQuiet.liquidationPct < 34);
  check('in a quiet market a 3× short is never liquidated', sQuiet.breachShare === 0);

  // A market with one violent rally.
  const violent = quiet.map((c, i) => {
    const mult = i > 300 && i < 340 ? 1 + (i - 300) * 0.02 : 1;
    return { ...c, close: c.close * mult, high: c.high * mult, low: c.low * mult };
  });
  const sHot = shortLegRisk(violent, { holdBars: 48, leverage: 10 });
  check('at 10× a real rally reaches liquidation', sHot.breachShare > 0);
  check('the leverage that would have survived this history is reported',
    sHot.safeLeverage > 1 && sHot.safeLeverage < 10);
  check('liquidation sits closer at higher leverage',
    shortLegRisk(violent, { holdBars: 48, leverage: 20 }).liquidationPct <
    shortLegRisk(violent, { holdBars: 48, leverage: 5 }).liquidationPct);
  check('a longer hold cannot be safer than a shorter one',
    shortLegRisk(violent, { holdBars: 96, leverage: 10 }).breachShare >=
    shortLegRisk(violent, { holdBars: 12, leverage: 10 }).breachShare);
}

/* ------------------------- rank correlation --------------------------- */
{
  const rising = [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 60]];
  check('a perfect ranking gives rho = 1', near(spearman(rising).rho, 1, 1e-12));
  const falling = rising.map(([a, b]) => [a, -b]);
  check('a reversed ranking gives rho = −1', near(spearman(falling).rho, -1, 1e-12));
  check('a perfect ranking of six points is significant', spearman(rising).significant);
  check('too few points gives no correlation at all', spearman([[1, 1], [2, 2]]).rho === null);
  check('ties do not break the ranking',
    Number.isFinite(spearman([[1, 1], [1, 2], [2, 3], [2, 4], [3, 5], [3, 6]]).rho));
  check('a flat column has no correlation to report',
    spearman([[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]).rho === null);
}

/* ------------------------------- splits ------------------------------- */
{
  const by = {
    A: series(new Array(100).fill(0.0001)),
    B: series(new Array(50).fill(0.0002)),
  };
  const [fit, check1, vault] = splitFunding(by, [0.5, 0.3, 0.2]);
  check('each symbol is split by its own length, not by a shared index',
    fit.A.length === 50 && fit.B.length === 25);
  check('the slices are in chronological order',
    fit.A[fit.A.length - 1].time < check1.A[0].time && check1.A[check1.A.length - 1].time < vault.A[0].time);
  check('no settlement appears in two slices',
    new Set([...fit.A, ...check1.A, ...vault.A].map((p) => p.time)).size ===
    fit.A.length + check1.A.length + vault.A.length);
}

/* ------------------ persistence, and the random benchmark ------------- */
{
  /*
   * The case the test exists for. Every symbol pays the same funding, so the
   * ranking in the first half is pure noise — and a selection rule MUST come
   * out as "none" here. Reporting the top five as a strategy on data like this
   * is the error the random-entry benchmark caught in the signal work.
   */
  let seed = 123456789;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const flat = {};
  for (let i = 0; i < 14; i++) {
    const rates = [];
    for (let j = 0; j < 140; j++) rates.push(0.0001 + (rnd() - 0.5) * 0.0006);
    flat[`F${i}USDT`] = series(rates);
  }
  const noRule = persistenceTest(flat, { topK: 4, replicates: 300 });
  check('a universe where everyone pays the same yields no selection rule',
    noRule.verdict === 'none' || noRule.verdict === 'unclear');
  check('and the ranking that produced it carries no real signal',
    Math.abs(noRule.rank.rho) < 0.5 && !noRule.rank.significant);
  check('the random benchmark is reported as a percentile, not a share',
    noRule.nullPercentile >= 0 && noRule.nullPercentile <= 100);

  /*
   * And the case where a rule genuinely exists: half the symbols pay five times
   * as much in BOTH halves. The test must find it, or it cannot find anything.
   */
  const real = {};
  for (let i = 0; i < 12; i++) {
    const base = i < 6 ? 0.0005 : 0.00005;
    const rates = [];
    for (let j = 0; j < 120; j++) rates.push(base + ((i * 13 + j * 7) % 11 - 5) * 0.000005);
    real[`R${i}USDT`] = series(rates);
  }
  const rule = persistenceTest(real, { topK: 4, replicates: 300 });
  check('a genuinely persistent ranking is detected', rule.verdict === 'persists');
  check('the detected ranking has a positive rank correlation', rule.rank.rho > 0.5);
  check('the picks beat the universe average when a rule exists',
    rule.pickedAnnualPct > rule.universeAnnualPct);
  check('the picks also beat the random benchmark', rule.nullPercentile >= 90);
  check('only the high-funding symbols were picked',
    rule.picked.every((s) => Number(s.slice(1, -4)) < 6));
  check('a universe of three symbols is too small to test', persistenceTest({
    A: series(new Array(60).fill(0.0001)),
    B: series(new Array(60).fill(0.0002)),
    C: series(new Array(60).fill(0.0003)),
  }) === null);
}

/* -------------------------------- vault ------------------------------- */
{
  const by = { A: series(new Array(100).fill(0.0001)), B: series(new Array(100).fill(0.0002)) };
  const res = reserveFundingVault(by, 0.2);
  check('the reserved slice is the most recent fifth',
    res.vault.A.length === 20 && res.working.A.length === 80);
  check('nothing in the working set comes from the vault period',
    res.working.A.every((p) => p.time < res.vault.A[0].time));
  check('the vault is described by size and dates only',
    res.info.periods === 40 && res.info.from != null && res.info.to != null);

  // The guarantee: the report must not touch a reserved settlement.
  const rep = analyseFunding({ fundingBySymbol: by, vaultRatio: 0.2 });
  const cut = res.vault.A[0].time;
  check('no number in the report is computed on a vault settlement',
    rep.portfolio.to < cut);
  check('the report still says how much was held back', rep.vault.periods === 40);
}

/* ------------------------------- verdict ------------------------------ */
{
  const negative = verdictOf({
    portfolio: describeFunding(series(new Array(200).fill(-0.0002))),
  });
  check('negative funding is called a cost, not an opportunity',
    negative.code === 'negative');
  check('the verdict says the mirror trade is not symmetric',
    /занимать монету/.test(negative.text));

  const good = verdictOf({ portfolio: describeFunding(series(new Array(200).fill(0.0003))) });
  check('a clearly positive rate gets a positive verdict', good.code === 'positive');
  check('a positive verdict still states the minimum hold',
    /дней/.test(good.text) && good.breakEvenDays > 0);

  const thin = verdictOf({ portfolio: describeFunding(series(new Array(200).fill(0.00002))) });
  check('a yield under 5% a year is called thin, not good', thin.code === 'thin');

  // The verdict must carry the warnings, not bury them under the headline.
  const warned = verdictOf({
    portfolio: describeFunding(series(new Array(200).fill(0.0003))),
    persistence: { verdict: 'none' },
    shortRisk: { breachShare: 0.05, leverage: 10, holdBars: 48 },
  });
  check('a verdict with a useless selection rule says so',
    /не работает|случайных/.test(warned.text));
  check('a verdict with reachable liquidation says so', /ликвидации/.test(warned.text));
}

/* ---------------------------- whole report ---------------------------- */
{
  const by = {};
  for (const s of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT']) {
    by[s] = syntheticFunding(s, 400);
  }
  const rep = analyseFunding({ fundingBySymbol: by, source: 'synthetic' });

  check('the report is JSON-serialisable for the site',
    typeof JSON.stringify(rep) === 'string');
  check('the report names its source', rep.source === 'synthetic');

  /*
   * The guard that matters most on this path. The generator builds each symbol
   * around a fixed mean, so the selection test passes BY CONSTRUCTION — the
   * ranking persists because it was written in, not because markets do that.
   * A run on the generator must therefore refuse to reach a market verdict.
   */
  check('a generated run is marked as not measured', rep.measured === false);
  check('and reaches no verdict about the market', rep.verdict.code === 'synthetic');
  check('the synthetic verdict says which flag to rerun with',
    /COINSCOPE_SOURCE=binance/.test(rep.verdict.text));
  check('a run labelled as an exchange is treated as measured',
    analyseFunding({ fundingBySymbol: by, source: 'binance futures (x)' }).measured === true);
  check('the report covers every symbol handed in', rep.perSymbol.length === 6);
  check('symbols are ordered by what they pay',
    rep.perSymbol.every((r, i) => i === 0 || rep.perSymbol[i - 1].meanRate >= r.meanRate));
  check('the pooled series is annualised on a single symbol’s grid, not its own',
    near(rep.portfolio.intervalHours, 8, 1e-9));
  check('the offline generator produces both payers and receivers',
    rep.perSymbol.some((r) => r.meanRate < 0) && rep.perSymbol.some((r) => r.meanRate > 0));
  check('the report reaches a verdict', !!rep.verdict.code);
  check('the round trip is stated in the report', near(rep.roundTripPct, 0.4, 1e-9));
}

/* --------------------------- perp universe ---------------------------- */
{
  const rows = [
    { symbol: 'BTCUSDT', quoteVolume: '9000000000' },
    { symbol: 'THINUSDT', quoteVolume: '1000000' },
    { symbol: 'BTCUSDC', quoteVolume: '9000000000' },
    { symbol: 'ETHUSDT', quoteVolume: '4000000000' },
  ];
  const uni = selectPerpUniverse(rows, { limit: 10, minQuoteVolume: 50e6 });
  check('the turnover floor drops thin perpetuals',
    !uni.some((u) => u.symbol === 'THINUSDT'));
  check('only USDT-quoted perpetuals are kept', uni.every((u) => u.symbol.endsWith('USDT')));
  check('the universe is ranked by turnover', uni[0].symbol === 'BTCUSDT');
}

/* ----------------------------- page wiring ---------------------------- */
{
  /*
   * Cheap, and it catches a failure mode that is otherwise invisible: the
   * renderer does `$('#id').innerHTML = …`, so a missing element is not an empty
   * panel, it is a null dereference that takes the whole tab down. Nothing in
   * the suite exercises a browser, so the ids are checked as text.
   */
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');

  const ids = [...app.matchAll(/\$\('#(funding[A-Za-z]*)'\)/g)].map((m) => m[1]);
  check('the funding renderer targets at least every panel', ids.length >= 7);
  const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
  check(`every id the funding renderer writes to exists in the page${missing.length ? ': ' + missing.join(', ') : ''}`,
    missing.length === 0);
  check('the funding tab exists and is wired to a view',
    html.includes('data-view="funding"') && html.includes('id="view-funding"'));
  check('the tab handler loads the funding report', /'funding'\) loadFunding\(\)/.test(app));
  check('both data layers can read the funding report',
    (app.match(/funding: \(\) => getJson\('data\/funding\.json'\)/g) || []).length === 2);
  check('the page explains what the trade is before showing a yield',
    /бессрочного/.test(html) && /ничего не угадывают/.test(html));
}

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
