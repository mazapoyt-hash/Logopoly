/**
 * Success probability: it must come from measured outcomes, widen its
 * comparison set honestly, and refuse to print a number it cannot support.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.COINSCOPE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coinscope-prob-'));
process.env.COINSCOPE_SOURCE = 'synthetic';
process.env.COINSCOPE_MIN_PROB_SAMPLE = '15';

const { BacktestTrades, Signals } = await import('../server/db.js');
const { estimateProbability, wilsonInterval, scoreBucket } = await import('../server/probability.js');
const { makeChecker, close } = await import('./helpers.mjs');

const results = [];
const check = makeChecker(results);

/* ---------------------------- score buckets --------------------------- */
check('score 64 falls in the 60–69 bucket', scoreBucket(64).min === 60 && scoreBucket(64).max === 69);
check('score 70 falls in the 70–79 bucket', scoreBucket(70).min === 70);
check('high scores share one bucket', scoreBucket(85).min === 80 && scoreBucket(100).min === 80);

/* --------------------------- wilson interval -------------------------- */
const w = wilsonInterval(6, 10);
check('wilson interval brackets the observed rate', w.low < 0.6 && w.high > 0.6);
check('wilson interval stays inside [0,1]', w.low >= 0 && w.high <= 1);
check('a perfect record still admits uncertainty', (() => {
  const p = wilsonInterval(10, 10);
  return close(p.high, 1, 1e-9) && p.low < 1 && p.low > 0.5;
})());
check('wilson narrows as the sample grows',
  (wilsonInterval(60, 100).high - wilsonInterval(60, 100).low) <
  (wilsonInterval(6, 10).high - wilsonInterval(6, 10).low));
check('no sample means no interval', wilsonInterval(0, 0).low === null);

/* ------------------------- not enough evidence ------------------------ */
const bare = estimateProbability({ symbol: 'BTCUSDT', direction: 'LONG', score: 65, timeframe: '1h' });
check('with no history there is no probability', bare.available === false && bare.probability === null);
check('the shortfall is reported honestly', bare.sample === 0 && bare.required === 15);

/* ------------------------ enough for one symbol ----------------------- */
// 20 comparable BTC long trades: 12 winners, 8 losers.
const trades = [];
for (let i = 0; i < 20; i++) {
  trades.push({
    direction: 'LONG', score: 65, r: i < 12 ? 1.9 : -1.05,
    resolved: i < 12 ? 'win' : 'loss', entryTime: 1_700_000_000_000 + i * 3600_000,
  });
}
BacktestTrades.replaceFor({ symbol: 'BTCUSDT', timeframe: '1h', source: 'synthetic', trades });

const est = estimateProbability({ symbol: 'BTCUSDT', direction: 'LONG', score: 65, timeframe: '1h' });
check('a sufficient sample yields a probability', est.available === true);
check('the probability is the measured hit rate', close(est.probability, 12 / 20, 1e-9));
check('the sample size is reported', est.sample === 20);
check('the narrowest matching basis is used', est.basis === 'symbol+direction');
check('expected R is the mean of actual outcomes',
  close(est.expectedR, (12 * 1.9 + 8 * -1.05) / 20, 1e-9));
check('a confidence interval is attached', est.low > 0 && est.high < 1 && est.low < est.probability);

/* --------------------- the bucket actually filters -------------------- */
// A score-85 signal has no comparable history here. Falling all the way back
// to the pooled "any score" sample is allowed, but only if it says so — the
// UI discloses the basis, so borrowing must never masquerade as a same-bucket
// measurement.
const otherBucket = estimateProbability({ symbol: 'BTCUSDT', direction: 'LONG', score: 85, timeframe: '1h' });
check('a different score bucket never claims a same-bucket measurement',
  otherBucket.basis !== 'symbol+direction' && otherBucket.basis !== 'score');
check('borrowing across buckets is labelled as pooled evidence',
  otherBucket.available === false || otherBucket.basis === 'all');
check('the pooled basis is spelled out for the reader',
  otherBucket.available === false || /все сигналы/.test(otherBucket.basisLabel || ''));

const otherSymbol = estimateProbability({ symbol: 'ETHUSDT', direction: 'LONG', score: 65, timeframe: '1h' });
check('another coin falls back to the wider basis, not the coin-specific one',
  otherSymbol.basis !== 'symbol+direction' && otherSymbol.basis !== 'symbol');
check('the wider basis still finds the evidence', otherSymbol.available === true && otherSymbol.sample === 20);

/* ------------------ live results count as evidence too ---------------- */
const before = estimateProbability({ symbol: 'SOLUSDT', direction: 'SHORT', score: 65, timeframe: '1h' });
const sig = Signals.add({
  symbol: 'SOLUSDT', timeframe: '1h', direction: 'SHORT', entry: 100, stop: 102, target: 96,
  atr: 1, score: 65, reasons: [], context: {}, barTime: 9_000_000_000, expiryBars: 24,
});
Signals.resolve(sig.id, { status: 'win', exitPrice: 96, exitTime: Date.now(), barsHeld: 3, r: 1.9 });
const after = estimateProbability({ symbol: 'SOLUSDT', direction: 'SHORT', score: 65, timeframe: '1h' });
check('a resolved live signal joins the evidence pool', after.sample === before.sample + 1);

/* ------------------------- open signals excluded ---------------------- */
const openSig = Signals.add({
  symbol: 'SOLUSDT', timeframe: '1h', direction: 'SHORT', entry: 100, stop: 102, target: 96,
  atr: 1, score: 65, reasons: [], context: {}, barTime: 9_100_000_000, expiryBars: 24,
});
const afterOpen = estimateProbability({ symbol: 'SOLUSDT', direction: 'SHORT', score: 65, timeframe: '1h' });
check('an unresolved signal is not counted as evidence',
  !!openSig && afterOpen.sample === after.sample);

/* --------------------- stored with the signal itself ------------------ */
const withProb = Signals.add({
  symbol: 'BTCUSDT', timeframe: '1h', direction: 'LONG', entry: 100, stop: 98, target: 104,
  atr: 1, score: 65, reasons: [], context: {}, barTime: 9_200_000_000, expiryBars: 24,
  probability: est,
});
check('the estimate is stored on the signal', close(withProb.win_prob, est.probability, 1e-9));
check('the sample size is stored too', withProb.prob_sample === est.sample);
check('the expected R is stored', close(withProb.expected_r, est.expectedR, 1e-9));

fs.rmSync(process.env.COINSCOPE_DATA_DIR, { recursive: true, force: true });

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
