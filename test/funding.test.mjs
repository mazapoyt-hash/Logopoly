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
  parsePerpSymbols, parseBybitFunding, parseBybitTickers, parseBybitPerps,
  describeAttempts, clearHttpLog, httpLog, resetVenue,
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

  /*
   * The fallback route, and the one thing it does better than the ticker: it
   * states the contract type, so a quarterly delivery cannot slip in. Those have
   * a fixed expiry and funding of a different shape; measuring them alongside
   * perpetuals would pool two instruments into one number.
   */
  const info = {
    symbols: [
      { symbol: 'BTCUSDT', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT' },
      { symbol: 'BTCUSDT_251226', contractType: 'CURRENT_QUARTER', status: 'TRADING', quoteAsset: 'USDT' },
      { symbol: 'OLDUSDT', contractType: 'PERPETUAL', status: 'SETTLING', quoteAsset: 'USDT' },
      { symbol: 'ETHUSDC', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDC' },
      { symbol: 'ETHUSDT', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT' },
    ],
  };
  const perps = parsePerpSymbols(info);
  check('the contract catalogue yields only live USDT perpetuals',
    perps.length === 2 && perps.includes('BTCUSDT') && perps.includes('ETHUSDT'));
  check('a quarterly delivery contract is not treated as a perpetual',
    !perps.includes('BTCUSDT_251226'));
  check('a contract that is no longer trading is dropped', !perps.includes('OLDUSDT'));
  let threwInfo = false;
  try { parsePerpSymbols({}); } catch { threwInfo = true; }
  check('a malformed catalogue fails loudly rather than yielding an empty universe', threwInfo);
}

/* ------------------- the failure that killed the first run ------------- */
{
  /*
   * The first live run died on `SyntaxError: Unexpected end of JSON input` from
   * inside undici, because `request()` called res.json() straight off a 200 and
   * the futures ticker answered 200 with an EMPTY body. The stack named no host,
   * no path, and did not say the body was empty.
   *
   * This replaces global fetch to reproduce that exact answer and assert two
   * things: the run does not crash on it, and whatever comes out names the
   * problem. An ok status is a claim about the transport, never about the payload.
   */
  const realFetch = globalThis.fetch;
  const seen = [];
  const reply = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  });

  const mod = await import('../server/sources/funding.js');

  globalThis.fetch = async (url) => { seen.push(String(url)); return reply(''); };
  let err = null;
  try {
    await mod.fetchFundingRange('BTCUSDT', 100);
  } catch (e) { err = e; }
  globalThis.fetch = realFetch;

  check('a 200 with an empty body does not surface as a JSON parse error',
    err && !/Unexpected end of JSON input/.test(err.message));
  check('the error says the body was empty', err && /пустое тело/.test(err.message));
  check('the error names the path and the host',
    err && /fundingRate/.test(err.message) && /fapi/.test(err.message));
  check('an empty body is retried and then failed over to a mirror, not given up on',
    new Set(seen.map((u) => new URL(u).host)).size > 1);

  // Valid status, body that is not JSON at all — same treatment, clearer message.
  globalThis.fetch = async () => reply('<html>blocked</html>');
  let err2 = null;
  try { await mod.fetchFundingRange('BTCUSDT', 100); } catch (e) { err2 = e; }
  globalThis.fetch = realFetch;
  check('a non-JSON 200 is reported as such, with what arrived',
    err2 && /не JSON/.test(err2.message) && /blocked/.test(err2.message));

  // And the happy path still parses normally through the same code.
  globalThis.fetch = async () => reply(JSON.stringify([
    { symbol: 'BTCUSDT', fundingTime: 1000, fundingRate: '0.0001', markPrice: '60000' },
  ]));
  const ok = await mod.fetchFundingRange('BTCUSDT', 10);
  globalThis.fetch = realFetch;
  check('a valid body still comes back parsed', ok.length === 1 && ok[0].rate === 0.0001);
}

/* ---------------- the gate, and venue failover around it --------------- */
{
  /*
   * The second live run, reproduced. Binance futures answered **202 with an
   * empty body** from all three hosts — a gate, not an API error — and the run
   * ended with no measurement at all. Two things must hold: a gated venue is
   * abandoned for the next one rather than ending the run, and the failure (when
   * everything is gated) names every attempt instead of a bare stack trace.
   */
  const realFetch = globalThis.fetch;
  const reply = (body, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => body,
    json: async () => JSON.parse(body),
  });

  const mod = await import('../server/sources/funding.js');

  /*
   * The suite runs with COINSCOPE_SOURCE=synthetic so no test can touch an
   * exchange — but these tests are ABOUT the live path, and with the offline
   * branch taken they would pass while exercising nothing. Flip the source for
   * this block only; every request is served by the mock above, so nothing
   * leaves the machine.
   */
  const { config } = await import('../server/config.js');
  const realSource = config.source;
  config.source = 'binance';

  const bybitTickers = JSON.stringify({
    retCode: 0, retMsg: 'OK',
    result: { list: [
      { symbol: 'BTCUSDT', turnover24h: '9000000000' },
      { symbol: 'ETHUSDT', turnover24h: '4000000000' },
      { symbol: 'THINUSDT', turnover24h: '1000000' },
    ] },
  });

  // Binance futures gated with 202/empty; bybit healthy.
  resetVenue(); clearHttpLog();
  const hosts = [];
  const bybitFundingPage = JSON.stringify({
    retCode: 0, retMsg: 'OK',
    result: { list: [{ symbol: 'BTCUSDT', fundingRate: '0.0001', fundingRateTimestamp: '1700000000000' }] },
  });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    hosts.push(u.host);
    if (u.host.startsWith('fapi')) return reply('', 202);
    if (u.pathname === '/v5/market/funding/history') return reply(bybitFundingPage);
    return reply(bybitTickers);
  };
  const uni = await mod.getPerpUniverse({ limit: 10, minQuoteVolume: 50e6 });
  globalThis.fetch = realFetch;

  check('a gated venue does not end the run — the next one is tried',
    uni.length === 2 && uni[0].symbol === 'BTCUSDT');
  check('the fallback venue is actually a different host',
    hosts.some((h) => h.startsWith('fapi')) && hosts.some((h) => h.includes('bybit')));
  check('the report can say which venue answered',
    mod.activeVenue()?.id === 'bybit' && /bybit/.test(mod.sourceLabel()));
  check('the gate is visible in the attempt log',
    httpLog().some((a) => a.status === 202 && a.bodyLength === 0));

  /*
   * And the flaw in my own first fallback: it began with /fapi/v1/exchangeInfo,
   * so it failed wherever the primary path failed. A fallback that needs the
   * gate to open is not a fallback. With every venue ticker gated, the last
   * route must reach only the SPOT host — which these runners do reach.
   */
  resetVenue(); clearHttpLog();
  const paths = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    paths.push(u.host + u.pathname);
    if (u.host.startsWith('fapi') || u.host.includes('bybit')) return reply('', 202);
    if (u.pathname === '/api/v3/ticker/24hr') {
      return reply(JSON.stringify([
        { symbol: 'BTCUSDT', quoteVolume: '9000000000', count: 1, priceChangePercent: '1' },
        { symbol: 'ETHUSDT', quoteVolume: '4000000000', count: 1, priceChangePercent: '1' },
      ]));
    }
    return reply('', 202);
  };
  let gatedErr = null;
  try { await mod.getPerpUniverse({ limit: 10, minQuoteVolume: 50e6 }); } catch (e) { gatedErr = e; }
  globalThis.fetch = realFetch;

  /*
   * The flaw the third live run exposed. The old code chose a venue on its
   * TICKER alone, so with every ticker gated it fell back to a spot-ranked list
   * while still pointing the funding fetch at the blocked host — and then asked
   * that closed door for sixteen symbols in a row. A list is worthless if the
   * rates behind it are unreachable, so the rates decide.
   */
  check('a venue whose funding is gated is rejected, not used with a spot list',
    gatedErr != null && /историю фандинга/.test(gatedErr.message));
  const fundingCalls = paths.filter((p) => p.includes('/fapi/v1/fundingRate')).length;
  check('and it is rejected after one probe, not after one request per symbol',
    fundingCalls > 0 && fundingCalls <= 6);
  check('the last-resort route never asks a gated futures host for the list',
    !paths.some((p) => p.includes('/fapi/v1/exchangeInfo')));

  /*
   * The same spot-ranked route, now with funding that actually answers: the
   * route must still be taken, and still be NAMED, so spot turnover is never
   * passed off as perpetual turnover.
   */
  resetVenue(); clearHttpLog();
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/fapi/v1/ticker/24hr') return reply('', 202);
    if (u.pathname === '/fapi/v1/fundingRate') {
      return reply(JSON.stringify([
        { symbol: 'BTCUSDT', fundingTime: 1700000000000, fundingRate: '0.0001', markPrice: '60000' },
      ]));
    }
    if (u.pathname === '/api/v3/ticker/24hr') {
      return reply(JSON.stringify([
        { symbol: 'BTCUSDT', quoteVolume: '9000000000', count: 1, priceChangePercent: '1' },
        { symbol: 'ETHUSDT', quoteVolume: '4000000000', count: 1, priceChangePercent: '1' },
      ]));
    }
    return reply('', 202);
  };
  const spotRanked = await mod.getPerpUniverse({ limit: 10, minQuoteVolume: 50e6 });
  globalThis.fetch = realFetch;

  check('a gated LIST with working funding still yields a universe from spot turnover',
    spotRanked.length > 0 && spotRanked.every((r) => r.volumeFrom === 'spot'));
  check('the route is named, so spot turnover is not passed off as perp turnover',
    mod.activeVenue()?.route === 'spot-ranked' && /оборот спота/.test(mod.sourceLabel()));

  // Everything closed, including spot: the error must teach, not just fail.
  resetVenue(); clearHttpLog();
  globalThis.fetch = async () => reply('', 202);
  let err = null;
  try { await mod.getPerpUniverse({ limit: 10 }); } catch (e) { err = e; }
  globalThis.fetch = realFetch;
  resetVenue();

  check('when nothing answers, the error lists every venue tried',
    err && /binance futures/.test(err.message) && /bybit/.test(err.message));
  check('and says the missing thing was funding history, not a symbol list',
    err && /историю фандинга/.test(err.message));
  check('and every HTTP attempt with its status and body size',
    err && /202/.test(err.message) && /пустое тело/.test(err.message));
  check('the attempt log is renderable on its own',
    /202/.test(describeAttempts()));

  config.source = realSource;
  check('the offline guard is restored, so no later test can reach an exchange',
    config.source === realSource);
}

/* ----------------------------- bybit parsing -------------------------- */
{
  const funding = parseBybitFunding({ list: [
    { symbol: 'BTCUSDT', fundingRate: '0.0001', fundingRateTimestamp: '2000' },
    { symbol: 'BTCUSDT', fundingRate: '-0.00005', fundingRateTimestamp: '1000' },
  ] });
  check('bybit funding is parsed and sorted ascending',
    funding.length === 2 && funding[0].time === 1000 && funding[0].rate === -0.00005);
  check('bybit rates keep their sign', funding.some((p) => p.rate < 0));
  let threw = false;
  try { parseBybitFunding({ list: [{ fundingRate: 'x', fundingRateTimestamp: '1' }] }); } catch { threw = true; }
  check('a bybit row with a bad rate is rejected, not read as NaN', threw);

  const tickers = parseBybitTickers({ list: [{ symbol: 'BTCUSDT', turnover24h: '9000000000' }] });
  check('bybit turnover is already in the quote currency, so it maps straight across',
    tickers[0].quoteVolume === 9e9);

  const perps = parseBybitPerps({ list: [
    { symbol: 'BTCUSDT', contractType: 'LinearPerpetual', status: 'Trading', quoteCoin: 'USDT' },
    { symbol: 'BTCUSDT-28MAR25', contractType: 'LinearFutures', status: 'Trading', quoteCoin: 'USDT' },
    { symbol: 'OLDUSDT', contractType: 'LinearPerpetual', status: 'Closed', quoteCoin: 'USDT' },
  ] });
  check('bybit dated futures are not counted as perpetuals',
    perps.length === 1 && perps[0] === 'BTCUSDT');
}

/* --------------------- the probe must not guess causes ----------------- */
{
  /*
   * The probe exists to report, and its first version broke that by asserting
   * every 403 was "a geo-block, usually CloudFront by country". Run in the
   * development sandbox, every 403 was in fact the environment's own egress
   * allowlist — the probe stated the wrong cause with total confidence, inside
   * the one tool built to stop exactly that.
   */
  // Any request at import time would be visible here.
  let probeRan = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { probeRan = true; return { ok: false, status: 0, text: async () => '' }; };
  const { reason } = await import('../server/cli-probe.js');
  await new Promise((r) => setTimeout(r, 50));
  globalThis.fetch = realFetch;

  /*
   * And the guard that makes this import safe at all. Without it, importing the
   * probe FIRED it — ten live requests from inside `npm test`, in a suite that
   * runs with COINSCOPE_SOURCE=synthetic precisely so it cannot reach an
   * exchange. A module doing its work at import time voids that silently.
   */
  check('importing the probe does not run it',
    !probeRan);

  check('an egress block is named as the environment, not as the venue',
    /egress/.test(reason({ status: 403, bytes: 102, snippet: 'Host not in allowlist: api.binance.com. Add this host to your network egress settings.' })));
  check('a real geo-restriction is named as the venue',
    /локации/.test(reason({ status: 451, bytes: 224, snippet: '{"code":0,"msg":"Service unavailable from a restricted location according to..."}' })));
  check('a CloudFront country block is named as such',
    /CloudFront/.test(reason({ status: 403, bytes: 96, snippet: 'error: The Amazon CloudFront distribution is configured to block access from your country' })));
  check('an unexplained 403 does not get a cause invented for it',
    !/гео|CloudFront|egress/.test(reason({ status: 403, bytes: 12, snippet: 'nope' })));
  check('a 2xx with an empty body is reported as a gate, not as reachable',
    /шлагбаум/.test(reason({ status: 202, bytes: 0, snippet: '' })));
  check('an answering host is simply answering',
    reason({ ok: true }) === 'отвечает');
}

/* ------------------------- the workflow that lied --------------------- */
{
  /*
   * The second half of the same incident. `node cli-funding.js | tee funding.log`
   * returns TEE's exit code, so the crashed measurement reported success and the
   * failure only surfaced two steps later as "pathspec 'data/funding.json' did
   * not match any files" — a message that points at git rather than at the bug.
   * Both long-running workflows pipe into tee, so both need pipefail.
   */
  const { readFileSync } = await import('node:fs');
  for (const wf of ['funding.yml', 'deep.yml']) {
    const text = readFileSync(new URL(`../.github/workflows/${wf}`, import.meta.url), 'utf8');
    const pipes = text.includes('| tee ');
    check(`${wf} pipes into tee, so it must not swallow the exit code`,
      !pipes || /shell: bash/.test(text));
  }
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
