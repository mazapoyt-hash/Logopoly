/**
 * Cross-sectional momentum.
 *
 * The point of this suite is not that the module runs. It is that the module
 * can say NO. Every previous idea in this project was killed by a measurement,
 * and a test suite that only proves the happy path would let the next one
 * survive on presentation instead of evidence.
 *
 * So the suite is built around two synthetic universes:
 *
 *   - one where ranking genuinely predicts, because each coin carries a fixed
 *     drift and past returns therefore carry information about future ones;
 *   - one where it cannot, because every coin is the same random walk.
 *
 * A test that only checks the first is worthless: any buggy simulator finds an
 * edge in data that has one. It is the second universe that has teeth.
 */
import { makeChecker, close } from './helpers.mjs';
import {
  alignCloses, rankAt, simulate, describe, crossSectional, crossGrid, splitByTime,
  shuffleLabels,
} from '../server/cross.js';
import { makeRng } from '../server/nulls.js';

const results = [];
const check = makeChecker(results);

const DAY = 24 * 3600_000;
const FREE = { feeRate: 0, slippageRate: 0 };

/** Candles from closes, on a daily grid, starting at a chosen bar index. */
function series(closes, { start = 0, step = DAY } = {}) {
  return closes.map((c, i) => ({
    time: (start + i) * step,
    open: i === 0 ? c : closes[i - 1],
    high: c * 1.002, low: c * 0.998, close: c, volume: 1000,
  }));
}

/**
 * A universe of `n` coins over `bars` days.
 *
 * `driftSpread` is the whole experiment. At 0 every coin has the same expected
 * return and a ranking can only sort noise. Above 0 the coins differ
 * persistently, so a coin that led last month is genuinely more likely to lead
 * next month — momentum by construction, which is what a working detector must
 * find and a broken one must not invent.
 */
function universe({ n = 12, bars = 600, driftSpread = 0, baseDrift = 0.001,
  noise = 0.012, seed = 4242 } = {}) {
  const rng = makeRng(seed);
  const data = {};
  for (let k = 0; k < n; k++) {
    const drift = baseDrift + (n > 1 ? (k / (n - 1) - 0.5) * 2 * driftSpread : 0);
    let price = 100;
    const closes = [];
    for (let i = 0; i < bars; i++) {
      // Two uniforms make a rough bell; the exact shape does not matter here.
      const shock = (rng() + rng() + rng() - 1.5) * noise;
      price *= 1 + drift + shock;
      closes.push(price);
    }
    data[`C${k}USDT`] = { candles: series(closes) };
  }
  return data;
}

/* --------------------------- aligning the panel ----------------------- */

{
  const data = {
    A: { candles: series([1, 2, 3, 4], { start: 0 }) },
    B: { candles: series([10, 20, 30, 40], { start: 2 }) },   // lists two days later
    C: { candles: series([5, 6, 7, 8], { start: 0 }) },
  };
  const panel = alignCloses(data, { minCoverage: 0.9 });
  check('a panel too short to say anything is refused outright', panel === null);
}

{
  // 40 bars, three coins, one of which starts late.
  const n = 40;
  const data = {
    A: { candles: series(Array.from({ length: n }, (_, i) => 100 + i)) },
    B: { candles: series(Array.from({ length: n }, (_, i) => 50 + i)) },
    C: { candles: series(Array.from({ length: n - 10 }, (_, i) => 20 + i), { start: 10 }) },
  };
  const full = alignCloses(data, { minCoverage: 1 });
  check('full coverage drops every date where a coin has no bar', full.times.length === n - 10);
  check('the surviving dates start where the last coin listed', full.times[0] === 10 * DAY);

  const loose = alignCloses(data, { minCoverage: 0.6 });
  check('a looser coverage rule keeps the earlier, thinner dates', loose.times.length === n);

  /*
   * The flaw this guards against: comparing coin A's array index 5 with coin
   * C's array index 5, which are ten days apart. Aligned by time they are the
   * same date or they are absent — never silently mismatched.
   */
  const i = full.times.indexOf(15 * DAY);
  check('closes are keyed by date, so coin C at day 15 is its day-15 price',
    close(full.closes[i].C, 20 + 5, 1e-9) && close(full.closes[i].A, 100 + 15, 1e-9));
}

/* ------------------------------- ranking ------------------------------ */

{
  /*
   * The lookahead test. Coin A is flat for the whole lookback and then
   * explodes; coin B rises steadily through it. At the moment of the decision
   * only the past is visible, so B must rank first — a ranking that already
   * knew about A's move would be reading the future.
   */
  const bars = 40;
  const aCloses = Array.from({ length: bars }, (_, i) => (i < 30 ? 100 : 100 * 3));
  const bCloses = Array.from({ length: bars }, (_, i) => 100 * (1 + i * 0.01));
  const cCloses = Array.from({ length: bars }, () => 100);
  const panel = alignCloses({
    A: { candles: series(aCloses) },
    B: { candles: series(bCloses) },
    C: { candles: series(cCloses) },
  }, { minCoverage: 1 });

  const ranking = rankAt(panel, 20, 10);
  check('ranking at a bar uses only closed bars before it', ranking[0].symbol === 'B');
  check('a coin whose whole move is still in the future ranks last, not first',
    ranking[ranking.length - 1].symbol !== 'B' && ranking.find((r) => r.symbol === 'A').momentum === 0);
  check('ranking comes back sorted, strongest first',
    ranking.every((r, i) => i === 0 || ranking[i - 1].momentum >= r.momentum));

  const late = rankAt(panel, 5, 10);
  check('a bar with no lookback available is not ranked at all', late.length === 0);
}

/* ------------------------- costs and turnover ------------------------- */

{
  const data = universe({ n: 6, bars: 200, seed: 11 });
  const panel = alignCloses(data);
  const costs = { feeRate: 0.0005, slippageRate: 0.0005 };
  const fixed = panel.symbols.slice(0, 3);

  const periods = simulate(panel, {
    lookback: 20, hold: 10, topK: 3, mode: 'longOnly', costs,
    pick: () => ({ longs: fixed, shorts: [] }),
  });

  check('a basket that never changes pays entry once and nothing after',
    close(periods[0].turnover, 0.5, 1e-12) && periods.slice(1).every((p) => p.turnover === 0));
  check('the one entry it pays is one side of the round trip, not both',
    close(periods[0].cost, (0.0005 + 0.0005), 1e-12));

  const churn = simulate(panel, {
    lookback: 20, hold: 10, topK: 3, mode: 'longOnly', costs,
    pick: (ranking, i) => ({
      longs: (i / 10) % 2 === 0 ? panel.symbols.slice(0, 3) : panel.symbols.slice(3, 6),
      shorts: [],
    }),
  });
  check('a basket replaced wholesale every period pays a full round trip',
    churn.slice(1).every((p) => p.turnover === 1 && close(p.cost, 0.002, 1e-12)));

  const half = simulate(panel, {
    lookback: 20, hold: 10, topK: 2, mode: 'longOnly', costs,
    pick: (ranking, i) => ({
      longs: (i / 10) % 2 === 0 ? [panel.symbols[0], panel.symbols[1]]
        : [panel.symbols[1], panel.symbols[2]],
      shorts: [],
    }),
  });
  check('replacing one holding of two costs half a round trip, not a whole one',
    close(half[1].turnover, 0.5, 1e-12));

  check('net is gross minus exactly the cost that was charged',
    periods.every((p) => close(p.net, p.gross - p.cost, 1e-12)));

  const free = simulate(panel, {
    lookback: 20, hold: 10, topK: 3, mode: 'longOnly', costs: FREE,
    pick: () => ({ longs: fixed, shorts: [] }),
  });
  check('at zero cost gross and net are the same number',
    free.every((p) => p.cost === 0 && close(p.net, p.gross, 1e-12)));
}

/* ------------------------- annualising honestly ----------------------- */

{
  const periods = [
    { at: 0, until: 10 * DAY, gross: 0.1, cost: 0, net: 0.1, turnover: 0, basket: [] },
    { at: 10 * DAY, until: 20 * DAY, gross: 0.1, cost: 0, net: 0.1, turnover: 0, basket: [] },
  ];
  const d = describe(periods, 10);
  check('the multiple compounds the periods rather than adding them',
    close(d.multiple, 1.21, 1e-12));
  check('annualisation spans the time the money was at work, not the whole panel',
    close(d.years, 20 / 365, 1e-12));
  check('win rate counts periods, not coins', d.winRate === 1);

  /*
   * The flaw: annualising over the panel span would divide by the lookback
   * warm-up and the reserved slice too, quietly shrinking every figure. The
   * period that earned the money is the period that dates it.
   */
  const withLoss = describe([
    ...periods,
    { at: 20 * DAY, until: 30 * DAY, gross: -0.05, cost: 0, net: -0.05, turnover: 0, basket: [] },
  ], 10);
  check('a losing period pulls the multiple down', withLoss.multiple < d.multiple);
  check('and shows up in the win rate', close(withLoss.winRate, 2 / 3, 1e-12));
}

/* -------------------- the universe where ranking works ---------------- */

{
  const data = universe({ n: 14, bars: 900, driftSpread: 0.0025, noise: 0.010, seed: 777 });
  const rep = crossSectional(data, { lookback: 40, hold: 10, topK: 4, costs: FREE, replicates: 200 });

  check('a universe with persistent per-coin drift is detected as an edge',
    rep.verdict === 'edge');
  check('and the strategy beats simply holding everything there',
    rep.excessAnnualPct > 0);
  check('and it sits in the upper tail of random baskets of the same size',
    rep.nullPercentile >= 95);
  check('the benchmark is the universe, so its return is not zero',
    Number.isFinite(rep.benchmark.annualPct) && rep.benchmark.annualPct !== 0);
  check('the report says in words what the numbers say', /работает/.test(rep.text));
}

/* ------------------ the universe where it cannot work ----------------- */

{
  const data = universe({ n: 14, bars: 900, driftSpread: 0, noise: 0.012, seed: 31337 });
  const rep = crossSectional(data, { lookback: 40, hold: 10, topK: 4, costs: FREE, replicates: 200 });

  /*
   * A trap worth naming, because I walked into it.
   *
   * Every coin here is the same process, so no ranking can carry information —
   * which makes "this universe must not be called an edge" look like the
   * obvious assertion. It is the wrong one. A threshold set at the 95th
   * percentile is DEFINED to fire on about one information-free universe in
   * twenty, and this particular seed is one of them: it lands at the 97.5th.
   * Asserting otherwise would not test the detector, it would test the seed,
   * and the only way to make it pass would be to shop for a friendlier one —
   * which is the same fitting this module exists to catch.
   *
   * Calibration is a RATE, so it is measured as a rate a few blocks down. What
   * belongs here are the things that must hold on every run regardless of the
   * draw.
   */
  check('an information-free universe produces no excess beyond the control tail',
    rep.strategy.annualPct <= rep.nullP95AnnualPct * 1.2);
  check('the control is centred on the strategy, not far below it',
    Math.abs(rep.nullMedianAnnualPct - rep.benchmark.annualPct) < 10);
  check('every verdict shows its percentile against the control, lucky draws included',
    Number.isFinite(rep.nullPercentile)
      && rep.text.includes(rep.nullPercentile.toFixed(0))
      && /случайн/.test(rep.text));
}

/* ----------------- the control has to match the strategy -------------- */

{
  /*
   * How the fix above was found, kept as a test because the flaw is invisible
   * in any single run.
   *
   * A momentum basket persists; a freshly drawn random basket does not. That
   * makes the fresh control's outcomes narrower than the strategy's, and a
   * strategy compared against a null narrower than itself sits in that null's
   * tail far more often than 5% of the time. Measured across forty seeds of
   * information-free data, the fresh control called 2 in 5 an edge; the
   * label-permuted control calls 1 in 40.
   *
   * The permuted control is the real one precisely BECAUSE its turnover
   * matches: it is the same basket under different names.
   */
  const data = universe({ n: 14, bars: 900, driftSpread: 0, noise: 0.012, seed: 31337 });
  const panel = alignCloses(data);
  const base = { lookback: 40, hold: 10, topK: 4, mode: 'longOnly', costs: FREE };
  const avgTurnover = (ps) => ps.reduce((s, p) => s + p.turnover, 0) / ps.length;

  const strategy = avgTurnover(simulate(panel, {
    ...base, pick: (r) => ({ longs: r.slice(0, 4).map((x) => x.symbol), shorts: [] }),
  }));

  const swap = shuffleLabels(panel.symbols, makeRng(3));
  const permuted = avgTurnover(simulate(panel, {
    ...base,
    pick: (r) => ({ longs: r.map((x) => swap.get(x.symbol)).slice(0, 4), shorts: [] }),
  }));

  const fresh = makeRng(3);
  const redrawn = avgTurnover(simulate(panel, {
    ...base,
    pick: (r) => {
      const pool = [...r]; const longs = [];
      for (let k = 0; k < 4 && pool.length; k++) {
        longs.push(pool.splice(Math.floor(fresh() * pool.length), 1)[0].symbol);
      }
      return { longs, shorts: [] };
    },
  }));

  check('relabelling the ranking reproduces the strategy\'s persistence exactly',
    close(permuted, strategy, 1e-12));
  check('redrawing the basket every period does not — it churns far more',
    redrawn > strategy * 1.5);

  check('a permutation is a bijection: every coin is used exactly once',
    new Set(swap.values()).size === panel.symbols.length
      && panel.symbols.every((s) => swap.has(s)));
  check('and it actually moves labels rather than returning identity',
    panel.symbols.some((s) => swap.get(s) !== s));
}

{
  /*
   * The calibration itself, measured rather than asserted. Ten independent
   * information-free universes; a detector worth trusting should put roughly
   * one in twenty above the 95th percentile, not one in three.
   */
  let edges = 0;
  const percentiles = [];
  for (let s = 0; s < 10; s++) {
    const rep = crossSectional(
      universe({ n: 12, bars: 700, driftSpread: 0, noise: 0.012, seed: 500 + s * 977 }),
      { lookback: 40, hold: 10, topK: 4, costs: FREE, replicates: 120 },
    );
    if (rep.verdict === 'edge') edges++;
    percentiles.push(rep.nullPercentile);
  }
  check('across ten information-free universes almost none are called an edge',
    edges <= 1);
  check('and their percentiles scatter across the range instead of hugging the top',
    Math.min(...percentiles) < 40 && Math.max(...percentiles) > 40);
}

/* ------------------- beating zero is not beating drift ---------------- */

{
  /*
   * A rising market where the ranking is useless. The strategy makes money in
   * absolute terms — which is exactly how a bad idea gets funded — and still
   * has to be reported as a failure, because holding everything made more.
   */
  const data = universe({ n: 12, bars: 700, driftSpread: 0, baseDrift: 0.003,
    noise: 0.012, seed: 9001 });
  const costs = { feeRate: 0.0005, slippageRate: 0.0005 };
  const rep = crossSectional(data, { lookback: 30, hold: 5, topK: 3, costs, replicates: 150 });

  check('in a rising market the strategy does make money in absolute terms',
    rep.strategy.annualPct > 0);
  check('but it is judged against holding everything, not against zero',
    rep.verdict !== 'edge');
  check('paying to reshuffle a universe that is all one coin is a loss vs holding',
    rep.excessAnnualPct < 0 && rep.verdict === 'worse-than-holding');
  check('and the text says to hold instead', /Держать всё было бы лучше/.test(rep.text));
}

/* ------------------------- the random control ------------------------- */

{
  const data = universe({ n: 12, bars: 500, driftSpread: 0.002, seed: 5150 });
  const a = crossSectional(data, { lookback: 30, hold: 10, topK: 3, costs: FREE, replicates: 120, seed: 1 });
  const b = crossSectional(data, { lookback: 30, hold: 10, topK: 3, costs: FREE, replicates: 120, seed: 1 });
  check('the whole report is reproducible from its seed',
    a.nullPercentile === b.nullPercentile && close(a.strategy.annualPct, b.strategy.annualPct, 1e-12));

  const c = crossSectional(data, { lookback: 30, hold: 10, topK: 3, costs: FREE, replicates: 120, seed: 2 });
  check('a different seed moves the control but not the strategy',
    close(c.strategy.annualPct, a.strategy.annualPct, 1e-12));

  check('the control spread is reported, not just the verdict',
    Number.isFinite(a.nullMedianAnnualPct) && Number.isFinite(a.nullP95AnnualPct)
      && a.nullP95AnnualPct >= a.nullMedianAnnualPct);

  /*
   * The control has to pay what the strategy pays. If the strategy were charged
   * costs and the control were not, every comparison here would be rigged
   * against the strategy — and the reverse would rig it in favour.
   */
  const panel = alignCloses(data);
  const costs = { feeRate: 0.0005, slippageRate: 0.0005 };
  const swap = shuffleLabels(panel.symbols, makeRng(7));
  const control = simulate(panel, {
    lookback: 30, hold: 10, topK: 3, mode: 'longOnly', costs,
    pick: (ranking) => ({
      longs: ranking.map((r) => swap.get(r.symbol)).slice(0, 3), shorts: [],
    }),
  });
  check('the control is charged costs on every rebalance it makes',
    control.filter((p) => p.turnover > 0).every((p) => p.cost > 0));
  check('and it is charged them at the same rate as the strategy',
    control.every((p) => close(p.cost, p.turnover * 0.002, 1e-12)));
}

/* ------------------------------ long/short ---------------------------- */

{
  const data = universe({ n: 14, bars: 900, driftSpread: 0.0025, noise: 0.010, seed: 777 });
  const rep = crossSectional(data, {
    lookback: 40, hold: 10, topK: 3, mode: 'longShort', costs: FREE, replicates: 150,
  });
  check('long/short runs and reports its mode', rep.params.mode === 'longShort');
  check('a market-neutral book is not the market: its return differs from holding',
    Math.abs(rep.strategy.annualPct - rep.benchmark.annualPct) > 1e-9);
  check('shorting the weakest of a spread-drift universe still finds the effect',
    rep.excessAnnualPct > 0);
}

/* ------------------------------- holdout ------------------------------ */

{
  const data = universe({ n: 10, bars: 600, driftSpread: 0.002, seed: 60613 });
  const split = splitByTime(data, { ratio: 0.3, warmupBars: 50 });

  const lastWorking = Math.max(...Object.values(split.working)
    .flatMap((d) => d.candles.map((c) => c.time)));
  const firstReserved = Math.min(...Object.values(split.reserved)
    .flatMap((d) => d.candles.map((c) => c.time)));

  check('the two slices do not overlap in scored time', lastWorking < split.cut);
  check('the reserved slice carries a warm-up tail from before the cut',
    firstReserved < split.cut);
  check('the cut is one date for every coin, not a per-coin array offset',
    Object.values(split.working).every((d) => d.candles.every((c) => c.time < split.cut)));

  /*
   * The warm-up bars exist to be looked back at, never to be scored. If
   * `startAt` were ignored, the "unseen" result would contain the tail of the
   * data the grid was fitted on — a holdout in name only.
   */
  const panel = alignCloses(split.reserved);
  const scored = simulate(panel, {
    lookback: 20, hold: 10, topK: 3, mode: 'longOnly', costs: FREE, startAt: split.from,
    pick: (r) => ({ longs: r.slice(0, 3).map((x) => x.symbol), shorts: [] }),
  });
  check('nothing before the cut is scored, even though it is present for lookback',
    scored.every((p) => p.at >= split.from));

  const unguarded = simulate(panel, {
    lookback: 20, hold: 10, topK: 3, mode: 'longOnly', costs: FREE,
    pick: (r) => ({ longs: r.slice(0, 3).map((x) => x.symbol), shorts: [] }),
  });
  check('and the guard actually removes periods rather than being decorative',
    unguarded.length > scored.length);
}

/* -------------------------------- the grid ---------------------------- */

{
  const data = universe({ n: 12, bars: 900, driftSpread: 0.0025, noise: 0.010, seed: 4711 });
  const grid = crossGrid(data, {
    lookbacks: [20, 40], holds: [5, 10], topKs: [3], costs: FREE, replicates: 80,
  });

  check('the grid reports every cell, not only the winner', grid.cells.length === 4);
  check('and how many of them beat the benchmark, so one lucky cell cannot stand alone',
    Number.isInteger(grid.beatingBenchmark) && grid.beatingBenchmark <= grid.total);
  check('the best cell is the one with the largest excess over holding',
    grid.cells.every((c) => c.excessAnnualPct <= grid.best.excessAnnualPct + 1e-12));
  check('a real effect shows up in most cells, not one',
    grid.beatingBenchmark >= 3 && grid.withEdge >= 1);

  check('the grid is tuned on one slice and checked on another', grid.holdout !== null);
  check('the holdout is scored only after the cut',
    grid.holdout.params.startAt > 0 && grid.holdout.strategy.from >= grid.holdout.params.startAt);
  check('the holdout runs the settings the grid chose, not its own',
    grid.holdout.params.lookback === grid.best.params.lookback
      && grid.holdout.params.hold === grid.best.params.hold);
  check('the report states the in-sample and out-of-sample excess side by side',
    /подгоночном куске/.test(grid.holdoutText) && /отложенном/.test(grid.holdoutText));
}

{
  const data = universe({ n: 12, bars: 800, driftSpread: 0, noise: 0.012, seed: 24601 });
  const grid = crossGrid(data, {
    lookbacks: [20, 40], holds: [5, 10], topKs: [3], costs: FREE, replicates: 80,
  });
  check('an information-free universe produces no edge anywhere in the grid',
    grid.withEdge === 0);
  check('and the grid says so instead of quoting its best cell',
    /не несёт информации/.test(grid.text));
}

/* ------------------------------ refusals ------------------------------ */

{
  check('two coins are not a cross-section', crossSectional({
    A: { candles: series(Array.from({ length: 200 }, (_, i) => 100 + i)) },
    B: { candles: series(Array.from({ length: 200 }, (_, i) => 50 + i)) },
  }) === null);

  check('a universe smaller than the basket it is asked to pick is refused',
    crossSectional(universe({ n: 4, bars: 300 }), { topK: 4 }) === null);

  check('an empty input is refused rather than defended against downstream',
    crossSectional({}) === null && alignCloses({}) === null);

  check('a history too short to split is not split',
    splitByTime({ A: { candles: series([1, 2, 3]) } }) === null);
}

/* ------------------------------- the page ----------------------------- */

{
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
  const cli = readFileSync(new URL('../server/cli-cross.js', import.meta.url), 'utf8');
  const wf = readFileSync(new URL('../.github/workflows/cross.yml', import.meta.url), 'utf8');

  check('the site has a tab for it and a view to render into',
    /data-view="cross"/.test(html) && /id="view-cross"/.test(html));
  check('every box the loader fills exists in the markup',
    ['crossVerdict', 'crossHeadlineBox', 'crossControlBox', 'crossGridBox',
      'crossHoldoutBox', 'crossMeta', 'crossEmpty', 'crossBody']
      .every((id) => html.includes(`id="${id}"`)));
  check('both the live and the static build read the same committed file',
    (app.match(/cross: \(\) => getJson\('data\/cross\.json'\)/g) || []).length === 2);
  check('the tab loads the report when it is opened',
    /tab\.dataset\.view === 'cross'\) loadCross\(\)/.test(app));

  /*
   * The banner guard, which the funding view needed for the same reason: the
   * generator builds the effect into the data, so a green verdict off synthetic
   * data would be the page claiming a discovery the data was made to contain.
   */
  check('a generated run is marked as not being the market, on the page',
    /source === 'synthetic'/.test(app) && /Это не рынок/.test(app));
  check('and in the job summary too', /synthetic/.test(cli) && /Это не рынок|не на бирже/.test(cli));

  check('report text is escaped before its markers are honoured, as elsewhere',
    /md\(rep\.text/.test(app) && !/innerHTML = rep\.text/.test(app));
  check('the page leads with the excess over holding, not the absolute return',
    /Разница/.test(app) && /excessAnnualPct/.test(app));
  check('the page explains which control produced the percentile',
    /crossControlHtml/.test(app) && /переставляются названия монет/.test(app));

  check('the workflow runs on live data, never the generator',
    /COINSCOPE_SOURCE: binance/.test(wf));
  check('and pipes through bash so a crashed measurement cannot report success',
    /shell: bash/.test(wf) && /tee cross\.log/.test(wf));
  check('the suite is registered in the runner',
    readFileSync(new URL('./run.mjs', import.meta.url), 'utf8').includes('cross.test.mjs'));
}

/* ------------------ a thin universe must not be silent ---------------- */

{
  /*
   * The failure this guards against actually happened, and it is the worst
   * shape a bug can take: one that reports success.
   *
   * The scan asked the exchange for 40 coins, got 7, screened none of them, and
   * wrote `ok: true`. No line of any report said the sample had shrunk sixfold,
   * so every statistic downstream silently became a statistic about seven
   * coins. It ran that way for days, and the first thing to notice was a
   * cross-sectional run refusing to start — by accident, because ranking seven
   * coins is impossible rather than merely misleading.
   *
   * A narrow universe is not itself a bug; it may be a real market fact, or a
   * deliberate setting. Saying nothing about it is the bug.
   */
  const { readFileSync } = await import('node:fs');
  const staticRun = readFileSync(new URL('../server/staticRun.js', import.meta.url), 'utf8');
  const cli = readFileSync(new URL('../server/cli-cross.js', import.meta.url), 'utf8');
  const wf = readFileSync(new URL('../.github/workflows/universe.yml', import.meta.url), 'utf8');
  const diag = readFileSync(new URL('../server/cli-universe.js', import.meta.url), 'utf8');

  check('a scan whose universe comes back half-size says so in its log',
    /universe\.length < config\.universe\.size \/ 2/.test(staticRun)
      && /вернулась узкой/.test(staticRun));
  check('and status.json records what was ASKED for, not only what arrived',
    /requested: config\.universe\.size/.test(staticRun) && /thin:/.test(staticRun));
  check('the cross run names the upstream cause instead of blaming the idea',
    /Диагностика вселенной/.test(cli) && /вместо \$\{UNIVERSE\}/.test(cli));

  /*
   * The diagnostic must not share the adapter's request path: the adapter is
   * the suspect, and a probe that reuses its suspect can hide the defect.
   */
  check('the diagnostic asks the hosts directly rather than through the adapter',
    /fetch\(host \+ path/.test(diag) && !/from '\.\/sources\/index\.js'/.test(diag));
  check('it counts every funnel stage separately, so the collapsing one is visible',
    ['rows', 'usdt', 'notStable', 'notLeveraged', 'withVolume', 'aboveFloor']
      .every((k) => diag.includes(`${k}:`)));
  check('it reports which fields a row actually has, since a missing one reads as thin',
    /fields:/.test(diag) && /quoteVolume/.test(diag));
  check('it separates "the array was short" from "the floor cut it down"',
    /f\.rows < 500/.test(diag) && /Массив полный/.test(diag));
  check('it is dispatchable from a phone and commits nothing',
    /workflow_dispatch/.test(wf) && /contents: read/.test(wf) && !/git commit/.test(wf));
  check('importing the diagnostic does not fire requests',
    /cli-universe\\.js\$\/\.test\(process\.argv\[1\]/.test(diag));
}

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
