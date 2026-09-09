/**
 * Strategy behaviour — and above all, the guarantee that a decision for bar i
 * never depends on anything after bar i. A backtest without that guarantee is
 * worthless, so this is the suite that matters most.
 */
import { computeIndicators, evaluateBar, htfTrendAt, scanLatest } from '../server/strategy.js';
import { fetchCandles } from '../server/sources/synthetic.js';
import { config } from '../server/config.js';
import { makeChecker } from './helpers.mjs';

const results = [];
const check = makeChecker(results);

const candles = fetchCandles('BTCUSDT', '1h', 600);
const htf = fetchCandles('BTCUSDT', '4h', 600);

/* --------------------- 1. Indicators are causal ---------------------- */
// Values at index i must be identical whether or not later bars exist.
const full = computeIndicators(candles);
const cut = 400;
const truncated = computeIndicators(candles.slice(0, cut + 1));

const keys = ['ema21', 'ema50', 'ema200', 'rsi', 'macdHist', 'atr', 'adx', 'relVol'];
let causalOk = true;
let firstBad = null;
for (const k of keys) {
  const a = full[k][cut];
  const b = truncated[k][cut];
  const same = (a === null && b === null) ||
    (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-6);
  if (!same) { causalOk = false; firstBad = `${k}: full=${a} truncated=${b}`; }
}
check(`indicators at bar ${cut} ignore future bars${causalOk ? '' : ' — ' + firstBad}`, causalOk);

/* ------------- 2. Signal decisions are causal (no lookahead) --------- */
// Re-evaluate many bars with only the history available at that time and
// confirm the verdict never changes when the future is revealed.
let mismatches = 0;
let checked = 0;
for (let i = 260; i < candles.length; i += 7) {
  const closeMs = candles[i].time + 3600_000;

  const htfFull = computeIndicators(htf);
  const trendFull = htfTrendAt(htf, htfFull, closeMs).trend;
  const sigFull = evaluateBar(full, i, trendFull, { symbol: 'BTCUSDT', timeframe: '1h', barTime: candles[i].time });

  const past = candles.slice(0, i + 1);
  const pastHtf = htf.filter((c) => c.time + 4 * 3600_000 <= closeMs);
  const indPast = computeIndicators(past);
  const htfPast = computeIndicators(pastHtf);
  const trendPast = htfTrendAt(pastHtf, htfPast, closeMs).trend;
  const sigPast = evaluateBar(indPast, i, trendPast, { symbol: 'BTCUSDT', timeframe: '1h', barTime: candles[i].time });

  checked++;
  const same = (!sigFull && !sigPast) ||
    (sigFull && sigPast && sigFull.direction === sigPast.direction &&
     Math.abs(sigFull.score - sigPast.score) < 1e-9 &&
     Math.abs(sigFull.entry - sigPast.entry) < 1e-9 &&
     Math.abs(sigFull.stop - sigPast.stop) < 1e-9);
  if (!same) mismatches++;
}
check(`signal verdicts identical with and without future data (${checked} bars, ${mismatches} mismatches)`,
  mismatches === 0);

/* ------------------ 3. Higher timeframe never leaks ------------------ */
// The HTF trend at time T must not use an HTF candle that closes after T.
const htfInd = computeIndicators(htf);
const probeMs = htf[100].time + 1; // just inside candle 100, so it has NOT closed
const { index } = htfTrendAt(htf, htfInd, probeMs);
check('htf trend only uses candles that already closed', index === 99);

/* ------------------------ 4. Risk geometry --------------------------- */
let sample = null;
for (let i = 300; i < candles.length && !sample; i++) {
  const closeMs = candles[i].time + 3600_000;
  const trend = htfTrendAt(htf, htfInd, closeMs).trend;
  sample = evaluateBar(full, i, trend, { symbol: 'BTCUSDT', timeframe: '1h', barTime: candles[i].time });
}
check('the engine produces at least one signal on this data', !!sample);
if (sample) {
  const risk = Math.abs(sample.entry - sample.stop);
  const reward = Math.abs(sample.target - sample.entry);
  check('stop sits on the losing side of entry',
    sample.direction === 'LONG' ? sample.stop < sample.entry : sample.stop > sample.entry);
  check('target sits on the winning side of entry',
    sample.direction === 'LONG' ? sample.target > sample.entry : sample.target < sample.entry);
  check('reward:risk matches the configured ratio',
    Math.abs(reward / risk - config.strategy.rewardRisk) < 1e-6);
  check('signal carries its reasoning', Array.isArray(sample.reasons) && sample.reasons.length > 0);
  check('score never exceeds 100', sample.score <= 100 && sample.score >= config.strategy.minScore);
}

/* ---------------------- 5. Gates actually gate ----------------------- */
// Chop (ADX below the floor) must never produce a signal.
let chopSignals = 0;
let chopBars = 0;
for (let i = 260; i < candles.length; i++) {
  const a = full.adx[i];
  if (!Number.isFinite(a) || a >= config.strategy.minAdx) continue;
  chopBars++;
  const closeMs = candles[i].time + 3600_000;
  const trend = htfTrendAt(htf, htfInd, closeMs).trend;
  if (evaluateBar(full, i, trend, { barTime: candles[i].time })) chopSignals++;
}
check(`no signals while ADX < ${config.strategy.minAdx} (${chopBars} such bars)`, chopSignals === 0);

/* ------------------------- 6. Short history -------------------------- */
check('scanLatest refuses to guess on too little history',
  scanLatest(candles.slice(0, 50), htf, { symbol: 'BTCUSDT', timeframe: '1h' }) === null);

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
