/**
 * Technical indicators — pure functions, no state, no I/O.
 *
 * Every function returns an array the same length as its input, with `null`
 * for bars that do not have enough history yet. Keeping the alignment makes
 * indexing by bar index safe and removes a whole class of off-by-one bugs
 * (which, in a backtest, quietly turn into lookahead bias).
 *
 * Wilder's smoothing is used for RSI/ATR/ADX to match what charting platforms
 * show, so signals here line up with what a person sees on TradingView.
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values (standard practice). */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period || period <= 0) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  const means = sma(values, period);
  for (let i = period - 1; i < values.length; i++) {
    const mean = means[i];
    if (!isNum(mean)) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const line = values.map((_, i) =>
    isNum(emaFast[i]) && isNum(emaSlow[i]) ? emaFast[i] - emaSlow[i] : null);

  // The signal line is an EMA of the MACD line, which only exists after `slow`
  // bars — so run it over the defined slice and map the result back.
  const firstDefined = line.findIndex(isNum);
  const signal = new Array(values.length).fill(null);
  const hist = new Array(values.length).fill(null);
  if (firstDefined !== -1) {
    const compact = line.slice(firstDefined);
    const sig = ema(compact, signalPeriod);
    for (let i = 0; i < sig.length; i++) {
      if (!isNum(sig[i])) continue;
      const idx = firstDefined + i;
      signal[idx] = sig[i];
      hist[idx] = line[idx] - sig[i];
    }
  }
  return { line, signal, hist };
}

/** True range for each bar; TR[0] falls back to high-low. */
export function trueRange(highs, lows, closes) {
  const out = new Array(highs.length).fill(null);
  for (let i = 0; i < highs.length; i++) {
    if (i === 0) { out[i] = highs[i] - lows[i]; continue; }
    const prevClose = closes[i - 1];
    out[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - prevClose),
      Math.abs(lows[i] - prevClose)
    );
  }
  return out;
}

/** Wilder's ATR. */
export function atr(highs, lows, closes, period = 14) {
  const tr = trueRange(highs, lows, closes);
  const out = new Array(highs.length).fill(null);
  if (highs.length <= period) return out;

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < highs.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function bollinger(values, period = 20, mult = 2) {
  const middle = sma(values, period);
  const sd = stdev(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (isNum(middle[i]) && isNum(sd[i])) {
      upper[i] = middle[i] + mult * sd[i];
      lower[i] = middle[i] - mult * sd[i];
    }
  }
  return { upper, middle, lower };
}

/**
 * Wilder's DMI/ADX. Returns +DI, -DI and ADX; ADX needs roughly 2*period bars
 * before it is defined.
 */
export function adx(highs, lows, closes, period = 14) {
  const n = highs.length;
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const adxOut = new Array(n).fill(null);
  if (n <= period * 2) return { plusDI, minusDI, adx: adxOut };

  const tr = trueRange(highs, lows, closes);
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  let smTR = 0;
  let smPlus = 0;
  let smMinus = 0;
  for (let i = 1; i <= period; i++) { smTR += tr[i]; smPlus += plusDM[i]; smMinus += minusDM[i]; }

  const dx = new Array(n).fill(null);
  const writeDI = (i) => {
    if (smTR === 0) { plusDI[i] = 0; minusDI[i] = 0; dx[i] = 0; return; }
    const p = 100 * (smPlus / smTR);
    const m = 100 * (smMinus / smTR);
    plusDI[i] = p;
    minusDI[i] = m;
    dx[i] = p + m === 0 ? 0 : 100 * Math.abs(p - m) / (p + m);
  };
  writeDI(period);

  for (let i = period + 1; i < n; i++) {
    smTR = smTR - smTR / period + tr[i];
    smPlus = smPlus - smPlus / period + plusDM[i];
    smMinus = smMinus - smMinus / period + minusDM[i];
    writeDI(i);
  }

  // ADX = Wilder average of DX, first value at index period*2.
  let sumDX = 0;
  for (let i = period; i < period * 2; i++) sumDX += dx[i] ?? 0;
  let prevAdx = sumDX / period;
  adxOut[period * 2 - 1] = prevAdx;
  for (let i = period * 2; i < n; i++) {
    prevAdx = (prevAdx * (period - 1) + (dx[i] ?? 0)) / period;
    adxOut[i] = prevAdx;
  }
  return { plusDI, minusDI, adx: adxOut };
}

/** Volume relative to its own moving average (1.0 = average). */
export function relativeVolume(volumes, period = 20) {
  const avg = sma(volumes, period);
  return volumes.map((v, i) => (isNum(avg[i]) && avg[i] > 0 ? v / avg[i] : null));
}

/** Percent change over `lookback` bars, as a fraction (0.05 = +5%). */
export function roc(values, lookback = 10) {
  return values.map((v, i) => {
    const prev = values[i - lookback];
    return i >= lookback && isNum(prev) && prev !== 0 ? (v - prev) / prev : null;
  });
}
