/**
 * Signal engine: trend-following confluence with volatility-scaled risk.
 *
 * The rule of this file is that a decision for bar `i` may only read data at
 * index <= i. Everything downstream (backtest, live scan) depends on that, and
 * breaking it is exactly how a strategy ends up with a beautiful, fake equity
 * curve. `computeIndicators` is allowed to run over the whole series because
 * every indicator here is causal — value at i depends only on bars <= i.
 */
import { ema, rsi, macd, atr, adx, relativeVolume, bollinger } from './indicators.js';
import { config, timeframeMs } from './config.js';

export const PARAMS = {
  emaFast: 21,
  emaMid: 50,
  emaSlow: 200,
  rsiPeriod: 14,
  atrPeriod: 14,
  adxPeriod: 14,
  volPeriod: 20,
};

export function computeIndicators(candles) {
  const close = candles.map((c) => c.close);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const volume = candles.map((c) => c.volume);

  const m = macd(close);
  const d = adx(high, low, close, PARAMS.adxPeriod);

  return {
    close, high, low, volume,
    ema21: ema(close, PARAMS.emaFast),
    ema50: ema(close, PARAMS.emaMid),
    ema200: ema(close, PARAMS.emaSlow),
    rsi: rsi(close, PARAMS.rsiPeriod),
    macdLine: m.line,
    macdSignal: m.signal,
    macdHist: m.hist,
    atr: atr(high, low, close, PARAMS.atrPeriod),
    adx: d.adx,
    plusDI: d.plusDI,
    minusDI: d.minusDI,
    relVol: relativeVolume(volume, PARAMS.volPeriod),
    bb: bollinger(close, 20, 2),
  };
}

/**
 * Higher-timeframe trend at a point in time, using only HTF candles that had
 * already closed by then. Passing the whole HTF array and indexing by position
 * would leak the future into the past.
 */
export function htfTrendAt(htfCandles, htfIndicators, atMs) {
  const htfMs = timeframeMs(config.higherTimeframe);
  let idx = -1;
  for (let i = htfCandles.length - 1; i >= 0; i--) {
    if (htfCandles[i].time + htfMs <= atMs) { idx = i; break; }
  }
  if (idx < 0) return { trend: 'flat', index: -1 };

  const e50 = htfIndicators.ema50[idx];
  const e200 = htfIndicators.ema200[idx];
  const price = htfIndicators.close[idx];
  if (!isNum(e50) || !isNum(e200) || !isNum(price)) return { trend: 'flat', index: idx };

  if (e50 > e200 && price > e200) return { trend: 'up', index: idx };
  if (e50 < e200 && price < e200) return { trend: 'down', index: idx };
  return { trend: 'flat', index: idx };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Score one direction at bar `i`. Returns { score, reasons }.
 * Weights are deliberately blunt — a fine-tuned weighting on this little data
 * would be curve fitting, not insight.
 */
function scoreDirection(ind, i, dir) {
  const long = dir === 'LONG';
  const reasons = [];
  let score = 0;

  const add = (cond, weight, text) => {
    if (cond) { score += weight; reasons.push({ weight, text }); }
  };

  const price = ind.close[i];
  const e21 = ind.ema21[i];
  const e50 = ind.ema50[i];
  const e200 = ind.ema200[i];
  const r = ind.rsi[i];
  const hist = ind.macdHist[i];
  const histPrev = ind.macdHist[i - 1];
  const a = ind.adx[i];
  const aPrev = ind.adx[i - 1];
  const pDI = ind.plusDI[i];
  const mDI = ind.minusDI[i];
  const rv = ind.relVol[i];

  add(isNum(e200) && (long ? price > e200 : price < e200), 18,
    long ? 'Цена выше EMA200 — общий тренд вверх' : 'Цена ниже EMA200 — общий тренд вниз');

  add(isNum(e50) && isNum(e200) && (long ? e50 > e200 : e50 < e200), 14,
    long ? 'EMA50 выше EMA200 (золотой крест)' : 'EMA50 ниже EMA200 (мёртвый крест)');

  add(isNum(hist) && (long ? hist > 0 : hist < 0), 14,
    long ? 'MACD-гистограмма положительная' : 'MACD-гистограмма отрицательная');

  add(isNum(hist) && isNum(histPrev) && (long ? hist > histPrev : hist < histPrev), 8,
    'Импульс MACD усиливается');

  add(isNum(r) && (long ? r > 45 && r < 70 : r < 55 && r > 30), 12,
    `RSI ${isNum(r) ? r.toFixed(0) : '—'} — в рабочей зоне, без перегрева`);

  add(isNum(pDI) && isNum(mDI) && (long ? pDI > mDI : mDI > pDI), 12,
    long ? '+DI выше −DI — покупатели давят' : '−DI выше +DI — продавцы давят');

  add(isNum(rv) && rv >= 1.1, 8,
    `Объём выше среднего (×${isNum(rv) ? rv.toFixed(2) : '—'})`);

  // Fresh reclaim of the fast EMA — a pullback entry rather than chasing.
  const prevPrice = ind.close[i - 1];
  const prevE21 = ind.ema21[i - 1];
  add(
    isNum(e21) && isNum(prevPrice) && isNum(prevE21) &&
      (long ? price > e21 && prevPrice <= prevE21 : price < e21 && prevPrice >= prevE21),
    14,
    long ? 'Откат выкуплен: цена вернулась выше EMA21' : 'Отскок продан: цена ушла под EMA21'
  );

  add(isNum(a) && isNum(aPrev) && a > aPrev, 10, 'ADX растёт — тренд набирает силу');

  return { score: Math.min(100, score), reasons };
}

/**
 * Evaluate bar `i` and return a signal, or null when nothing qualifies.
 * `htfTrend` must already be resolved for this bar's close time.
 */
export function evaluateBar(ind, i, htfTrend, meta = {}) {
  const s = config.strategy;
  const price = ind.close[i];
  const a = ind.adx[i];
  const atrNow = ind.atr[i];

  // Not enough history, or the indicators that gate everything are undefined.
  if (!isNum(price) || !isNum(a) || !isNum(atrNow) || atrNow <= 0) return null;
  if (!isNum(ind.ema200[i])) return null;

  // Chop filter: without a trend, this strategy has no edge at all.
  if (a < s.minAdx) return null;

  const candidates = [];
  for (const dir of ['LONG', 'SHORT']) {
    if (s.requireHtfAlignment) {
      if (dir === 'LONG' && htfTrend !== 'up') continue;
      if (dir === 'SHORT' && htfTrend !== 'down') continue;
    }
    candidates.push({ dir, ...scoreDirection(ind, i, dir) });
  }
  if (!candidates.length) return null;

  candidates.sort((x, y) => y.score - x.score);
  const best = candidates[0];
  if (best.score < s.minScore) return null;

  const long = best.dir === 'LONG';
  const stopDist = atrNow * s.atrStopMult;
  const entry = price;
  const stop = long ? entry - stopDist : entry + stopDist;
  const target = long ? entry + stopDist * s.rewardRisk : entry - stopDist * s.rewardRisk;

  return {
    symbol: meta.symbol || null,
    timeframe: meta.timeframe || config.timeframe,
    direction: best.dir,
    barTime: meta.barTime ?? null,
    entry,
    stop,
    target,
    atr: atrNow,
    rewardRisk: s.rewardRisk,
    stopPct: (stopDist / entry) * 100,
    score: best.score,
    reasons: best.reasons,
    context: {
      htfTrend,
      adx: a,
      rsi: ind.rsi[i],
      relVol: ind.relVol[i],
      ema200: ind.ema200[i],
    },
    expiryBars: s.expiryBars,
  };
}

/**
 * Scan the newest closed bar of a series. Returns a signal or null.
 */
export function scanLatest(candles, htfCandles, meta = {}) {
  if (candles.length < PARAMS.emaSlow + 5) return null;
  const ind = computeIndicators(candles);
  const htfInd = computeIndicators(htfCandles);
  const i = candles.length - 1;
  const closeMs = candles[i].time + timeframeMs(meta.timeframe || config.timeframe);
  const { trend } = htfTrendAt(htfCandles, htfInd, closeMs);
  return evaluateBar(ind, i, trend, {
    ...meta,
    barTime: candles[i].time,
  });
}
