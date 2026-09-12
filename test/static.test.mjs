/**
 * The static (GitHub Pages) build: a full pipeline run with no server and no
 * database, writing the JSON the site reads. What matters here is that it
 * produces the same decisions as the server build and never loses history.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coinscope-static-'));
process.env.COINSCOPE_SITE_DATA = DIR;
process.env.COINSCOPE_SOURCE = 'synthetic';
process.env.COINSCOPE_SYNTHETIC_ANCHOR = 'fixed';
process.env.COINSCOPE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coinscope-db-'));

const { runStatic, loadState, makeCollector } = await import('../server/staticRun.js');
const { estimateProbability } = await import('../server/probability.js');
const { makeChecker, close } = await import('./helpers.mjs');

const results = [];
const check = makeChecker(results);
const read = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));

/* ------------------------------ first run ----------------------------- */
const first = await runStatic();
check('a run completes with no server and no database', Number.isFinite(first.created));

const files = ['state.json', 'signals.json', 'market.json', 'stats.json', 'status.json'];
check('every file the site reads is written', files.every((f) => fs.existsSync(path.join(DIR, f))));

const status = read('status.json');
check('status says the source is healthy', status.ok === true);
check('status lists the tracked coins', status.symbols.length > 0);
check('status carries a per-coin data-quality report', status.dataQuality.length === status.symbols.length);
check('status is timestamped', Number.isFinite(status.updatedAt));

const market = read('market.json');
check('market covers every coin', market.market.length === status.symbols.length);
check('market rows carry price and indicators',
  market.market.every((m) => Number.isFinite(m.price) && ('rsi' in m)));

const signals = read('signals.json');
check('signals.json separates open from closed',
  Array.isArray(signals.open) && Array.isArray(signals.closed));
check('open signals carry entry, stop and target',
  signals.open.every((s) => [s.entry, s.stop, s.target].every(Number.isFinite)));
check('open signals carry their reasoning',
  signals.open.every((s) => Array.isArray(s.reasons)));
check('stop and target straddle the entry', signals.open.every((s) => (
  s.direction === 'LONG' ? s.stop < s.entry && s.target > s.entry
    : s.stop > s.entry && s.target < s.entry)));

// Regression: the backtest used to run after signals were generated, so the
// first batch was published with no evidence and, because the estimate is
// frozen at publication, stayed "нет оценки" for good.
check('the very first run already has probability evidence',
  loadState(DIR).backtestTrades.length > 0);
check('signals from the first run carry an estimate when evidence exists',
  signals.open.every((s) => s.probSample > 0 || loadState(DIR).backtestTrades.length === 0));

const stats = read('stats.json');
check('stats include the backtest', stats.backtest.perSymbol.length === status.symbols.length);
check('stats include the time-segment verdict', !!stats.consistency?.verdict);
check('stats report the live record separately from the backtest',
  stats.live && 'trades' in stats.live);

/* ----------------------------- second run ----------------------------- */
// Deterministic candles mean the same bar must not produce a second signal.
const before = loadState(DIR).signals.length;
const second = await runStatic();
const after = loadState(DIR).signals.length;
check('re-running does not duplicate signals for the same candle',
  second.created === 0 && after === before);
check('history survives a re-run', after >= before);

/* --------------------------- state integrity -------------------------- */
const state = loadState(DIR);
check('every signal has a stable id', new Set(state.signals.map((s) => s.id)).size === state.signals.length);
check('ids keep counting up across runs', state.nextId > state.signals.length - 1);
check('backtest trades are stored as probability evidence', state.backtestTrades.length > 0);
check('stored trades carry what the estimator needs',
  state.backtestTrades.every((t) => t.timeframe && t.direction && Number.isFinite(t.score) && Number.isFinite(t.r)));

/* -------------------- probability without a database ------------------ */
// The JSON collector must feed the same estimator the server uses.
const collect = makeCollector(state);
const sample = state.backtestTrades[0];
const est = estimateProbability({
  symbol: sample.symbol, direction: sample.direction, score: sample.score,
  timeframe: sample.timeframe, collect,
});
check('the estimator works off JSON state', est.sample > 0);
check('a stated probability stays within [0,1]',
  est.probability === null || (est.probability >= 0 && est.probability <= 1));
check('a probability always comes with its sample size',
  est.probability === null || Number.isFinite(est.sample));

check('the collector respects the score bucket', (() => {
  const low = collect({ timeframe: sample.timeframe, symbol: null, direction: null, bucket: { min: 0, max: 9 } });
  return low.length === 0; // no signal is ever published below the score floor
})());

check('the collector ignores signals that are still open', (() => {
  const openOnes = state.signals.filter((s) => s.status === 'open');
  if (!openOnes.length) return true;
  const o = openOnes[0];
  const got = collect({
    timeframe: o.timeframe, symbol: o.symbol, direction: o.direction,
    bucket: { min: o.score, max: o.score },
  });
  return got.every((g) => g.source === 'backtest');
})());

/* ------------------------- resolution over time ----------------------- */
// Plant a signal that the very next candles must close, and confirm a later
// run books it — that is the whole promise of the tracked record.
{
  const s = loadState(DIR);
  const target = s.signals.find((x) => x.status === 'open');
  if (target) {
    // Move its levels next to the entry so the following bars must hit one.
    target.stop = target.direction === 'LONG' ? target.entry * 0.999 : target.entry * 1.001;
    target.target = target.direction === 'LONG' ? target.entry * 1.001 : target.entry * 0.999;
    target.barTime = s.signals.length ? target.barTime - 50 * 3600_000 : target.barTime;
    fs.writeFileSync(path.join(DIR, 'state.json'), JSON.stringify(s, null, 1));

    await runStatic();
    const done = loadState(DIR).signals.find((x) => x.id === target.id);
    check('a signal whose level was hit gets closed on a later run', done.status !== 'open');
    check('a closed signal records its exit and result',
      Number.isFinite(done.exit) && Number.isFinite(done.r));
    check('the closed signal appears in the published history',
      read('signals.json').closed.some((x) => x.id === target.id));
    check('a closed signal is no longer offered as open',
      !read('signals.json').open.some((x) => x.id === target.id));
  } else {
    check('a signal whose level was hit gets closed on a later run (нет открытых — пропуск)', true);
  }
}

/* ------------- an open signal outlives its place in the universe ------- */
{
  /*
   * The bug three live signals hit. The settle loop walked the NARROWED symbol
   * list, so a coin that had left the universe — by turnover churn, by the toll
   * screen, or by a failed universe fetch falling back to eight configured
   * names — was never visited again: no price, no level check, no resolution,
   * for hours.
   *
   * That silently removes signals from the track record, and removes them for
   * reasons tied to the coin's own behaviour rather than at random. The promise
   * is that every signal reaches an outcome, so WATCHING must not be gated by
   * the list that gates ENTRY.
   */
  const before = read('status.json');
  check('status publishes the watched set alongside the scanned universe',
    Array.isArray(before.tracked) && before.tracked.length >= before.symbols.length);

  const planted = {
    id: 'orphan-test-1',
    symbol: 'ZZZORPHANUSDT',
    timeframe: before.timeframe,
    direction: 'LONG',
    entry: 100, stop: 99, target: 102,
    score: 50, status: 'open',
    createdAt: Date.now() - 7200_000,
    barTime: Date.now() - 7200_000,
    origin: 'test',
  };
  check('the planted coin is outside the scanned universe',
    !before.symbols.includes(planted.symbol));

  const state = loadState(DIR);
  state.signals.push(planted);
  fs.writeFileSync(path.join(DIR, 'state.json'), JSON.stringify(state, null, 1) + '\n');

  let crashed = null;
  try { await runStatic(); } catch (err) { crashed = err.message; }
  check(`a run with an open signal outside the universe does not break${crashed ? ': ' + crashed : ''}`,
    crashed === null);

  const after = read('status.json');
  check('the orphan is watched: it reaches the price request list',
    after.tracked.includes(planted.symbol));
  check('but it is NOT scanned: it stays out of the entry universe',
    !after.symbols.includes(planted.symbol));

  /*
   * Watched, not scanned — so it must not reappear in the market overview as if
   * it were part of the universe, and it must not generate new signals.
   */
  const market = read('market.json').market;
  check('the orphan does not appear in the market overview',
    !market.some((m) => m.symbol === planted.symbol));

  const afterState = loadState(DIR);
  const mine = afterState.signals.filter((s) => s.symbol === planted.symbol);
  check('no second signal is opened on a coin that is only watched',
    mine.length === 1);
  check('and the one that exists was carried forward, not dropped from state',
    mine[0].id === planted.id);

  /*
   * The assertion the whole fix exists for: an orphan must actually RESOLVE.
   * The levels are placed against the coin's own generated price so the outcome
   * is certain — a long whose stop sits far above the current price is already
   * beaten, and under the old code it would have sat open forever because the
   * settle loop never reached the symbol.
   */
  const { getCandles } = await import('../server/sources/index.js');
  const orphanCandles = await getCandles('ZZZORPHAN2USDT', before.timeframe, 300, { fresh: true });
  const last = orphanCandles[orphanCandles.length - 1].close;

  const doomed = {
    id: 'orphan-test-2',
    symbol: 'ZZZORPHAN2USDT',
    timeframe: before.timeframe,
    direction: 'LONG',
    entry: last * 1.5,
    stop: last * 1.4,          // already far above price: the stop is beaten
    target: last * 1.8,
    score: 50, status: 'open',
    createdAt: orphanCandles[0].time,
    barTime: orphanCandles[0].time,
    origin: 'test',
  };
  const st2 = loadState(DIR);
  st2.signals.push(doomed);
  fs.writeFileSync(path.join(DIR, 'state.json'), JSON.stringify(st2, null, 1) + '\n');

  await runStatic();

  const settled = loadState(DIR).signals.find((s) => s.id === doomed.id);
  check('an open signal outside the universe is actually settled, not frozen',
    settled && settled.status !== 'open');
  check('it is settled as a loss, because its stop was beaten',
    settled?.status === 'loss');
  check('and it carries an exit, a time and an R — so it enters the track record',
    Number.isFinite(settled?.exit) && Number.isFinite(settled?.exitTime)
      && Number.isFinite(settled?.r));
  check('the settled orphan shows up in the published history',
    (read('signals.json').closed || []).some((s) => s.id === doomed.id));
}

fs.rmSync(DIR, { recursive: true, force: true });
fs.rmSync(process.env.COINSCOPE_DATA_DIR, { recursive: true, force: true });

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
