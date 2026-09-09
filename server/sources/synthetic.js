/**
 * Deterministic synthetic market data.
 *
 * Used when no exchange is reachable (locked-down networks, CI) and by the test
 * suite, which needs identical candles on every run.
 *
 * Key property: the candle for a given timestamp is a PURE FUNCTION of that
 * timestamp. Asking for 1 candle and asking for 500 return the same last
 * candle, and yesterday's history does not change when a new bar appears.
 * An earlier version accumulated a random walk from the start of the requested
 * window, which made prices depend on how many bars you asked for — a request
 * for the latest price disagreed with the chart.
 *
 * The shape comes from layered value noise (a cheap fBm): long waves give
 * trends, short ones give chop, and a little white noise gives candle-level
 * jitter. It is NOT a market simulator and says nothing about real-world
 * performance — it exists so the pipeline can be built and verified offline.
 */
import { timeframeMs } from '../config.js';

/** Deterministic hash -> uint32. */
function hash32(seed, n) {
  let h = (seed ^ Math.imul(n, 0x9E3779B1)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x85EBCA6B) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
const rand01 = (seed, n) => hash32(seed, n) / 4294967296;

function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Smooth (cosine-interpolated) value noise at position x. */
function valueNoise(seed, x) {
  const i = Math.floor(x);
  const f = x - i;
  const a = rand01(seed, i);
  const b = rand01(seed, i + 1);
  const t = (1 - Math.cos(f * Math.PI)) / 2; // smoothstep-ish
  return a + (b - a) * t;
}

/** Octaves: wavelength in bars paired with amplitude in log-price. */
const OCTAVES = [
  [520, 0.26], [211, 0.13], [97, 0.07], [41, 0.035], [17, 0.018], [7, 0.009],
];

const BASE_PRICE = {
  BTCUSDT: 64000, ETHUSDT: 3200, SOLUSDT: 145, BNBUSDT: 580,
  XRPUSDT: 0.52, ADAUSDT: 0.45, AVAXUSDT: 28, LINKUSDT: 14,
};

/** Log-price at absolute bar index k — pure function of k. */
function logPriceAt(seed, k) {
  let sum = 0;
  for (let o = 0; o < OCTAVES.length; o++) {
    const [wavelength, amp] = OCTAVES[o];
    sum += (valueNoise(seed + o * 7919, k / wavelength) - 0.5) * 2 * amp;
  }
  // Per-bar jitter so consecutive closes are not unnaturally smooth.
  sum += (rand01(seed ^ 0x5bf03635, k) - 0.5) * 2 * 0.0035;
  return sum;
}

/**
 * Fixed origin for bar indexing. Bars are numbered from here, so the candle at
 * a given time never changes as the clock advances.
 */
const ORIGIN_MS = Date.UTC(2020, 0, 1);
const FIXED_ANCHOR_MS = Date.UTC(2026, 0, 1);

function endIndexFor(step) {
  const end = process.env.COINSCOPE_SYNTHETIC_ANCHOR === 'fixed'
    ? FIXED_ANCHOR_MS
    : Math.floor(Date.now() / step) * step; // only closed candles
  return Math.floor((end - ORIGIN_MS) / step);
}

export function fetchCandles(symbol, timeframe, limit) {
  const step = timeframeMs(timeframe);
  const seed = seedFrom(`${symbol}:${timeframe}`);
  const base = BASE_PRICE[symbol] || 10 + (seedFrom(symbol) % 1000) / 10;
  const endIdx = endIndexFor(step);
  const startIdx = endIdx - limit + 1;

  const priceAt = (k) => base * Math.exp(logPriceAt(seed, k));

  const candles = [];
  for (let k = startIdx; k <= endIdx; k++) {
    const close = priceAt(k);
    const open = priceAt(k - 1);
    const body = Math.abs(close - open);
    // Wick size scales with the bar's own movement, plus a floor so quiet
    // bars still have a range.
    const scale = body + close * 0.0012;
    const high = Math.max(open, close) + scale * rand01(seed ^ 0xA5A5, k) * 0.9;
    const low = Math.min(open, close) - scale * rand01(seed ^ 0x5A5A, k) * 0.9;
    const move = body / open;
    const volume = (500 + rand01(seed ^ 0x1234, k) * 500) * (1 + move * 80);

    candles.push({ time: ORIGIN_MS + k * step, open, high, low, close, volume });
  }
  return candles;
}

export async function fetchPrice(symbol, timeframe = '1h') {
  const c = fetchCandles(symbol, timeframe, 1);
  return c[c.length - 1].close;
}

export const name = 'synthetic';
