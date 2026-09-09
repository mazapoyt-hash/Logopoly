/** Indicator correctness — the base every signal rests on. */
import { sma, ema, rsi, atr, adx, macd, bollinger, trueRange } from '../server/indicators.js';
import { makeChecker, close } from './helpers.mjs';

const results = [];
const check = makeChecker(results);

/* ------------------------------- shape ------------------------------- */
const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
check('sma keeps input length', sma(ten, 3).length === ten.length);
check('sma pads warmup with null', sma(ten, 3)[0] === null && sma(ten, 3)[1] === null);
check('sma value is correct', close(sma(ten, 3)[2], 2));
check('sma slides', close(sma(ten, 3)[9], 9));

check('ema pads warmup', ema(ten, 5)[3] === null);
check('ema seeds with sma', close(ema(ten, 5)[4], 3));
// Next EMA: 6*(2/6) + 3*(4/6) = 2 + 2 = 4
check('ema advances correctly', close(ema(ten, 5)[5], 4));

/* -------------------------------- rsi -------------------------------- */
const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
const falling = Array.from({ length: 40 }, (_, i) => 140 - i);
check('rsi of a pure uptrend is 100', close(rsi(rising, 14).at(-1), 100));
check('rsi of a pure downtrend is 0', close(rsi(falling, 14).at(-1), 0));
check('rsi warmup is null', rsi(rising, 14)[13] === null);
check('rsi is defined from period', rsi(rising, 14)[14] !== null);

// Alternating +1/-1 around a level averages to a neutral reading.
const chop = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 1 : 0));
const chopRsi = rsi(chop, 14).at(-1);
check('rsi of chop sits near 50', chopRsi > 40 && chopRsi < 60);

/* -------------------------------- atr -------------------------------- */
// Every bar spans exactly 2 and closes at its midpoint -> ATR converges to 2.
const n = 40;
const highs = Array.from({ length: n }, () => 101);
const lows = Array.from({ length: n }, () => 99);
const closes = Array.from({ length: n }, () => 100);
check('atr of a constant range equals the range', close(atr(highs, lows, closes, 14).at(-1), 2, 1e-6));
check('atr warmup is null', atr(highs, lows, closes, 14)[13] === null);

check('trueRange uses the previous close', (() => {
  const tr = trueRange([10, 20], [5, 18], [8, 19]);
  // bar 1: max(20-18, |20-8|, |18-8|) = 12
  return close(tr[1], 12);
})());

/* -------------------------------- adx -------------------------------- */
const upH = Array.from({ length: 80 }, (_, i) => 100 + i * 2 + 1);
const upL = Array.from({ length: 80 }, (_, i) => 100 + i * 2 - 1);
const upC = Array.from({ length: 80 }, (_, i) => 100 + i * 2);
const d = adx(upH, upL, upC, 14);
check('adx is high in a clean trend', d.adx.at(-1) > 50);
check('+DI dominates in an uptrend', d.plusDI.at(-1) > d.minusDI.at(-1));
check('adx warmup is null', d.adx[26] === null);

/* ------------------------------- macd -------------------------------- */
const m = macd(rising);
check('macd line is positive while rising', m.line.at(-1) > 0);
check('macd histogram is defined at the end', Number.isFinite(m.hist.at(-1)));
check('macd arrays keep input length', m.line.length === rising.length && m.signal.length === rising.length);

/* ----------------------------- bollinger ----------------------------- */
const flat = Array.from({ length: 30 }, () => 100);
const bb = bollinger(flat, 20, 2);
check('bollinger collapses with no volatility',
  close(bb.upper.at(-1), 100) && close(bb.lower.at(-1), 100));

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
