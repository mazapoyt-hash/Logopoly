/**
 * Market-data source selector with a short in-memory cache.
 *
 * The cache exists so one scan cycle asking several strategies for the same
 * series does not hammer the exchange; it is keyed by symbol+timeframe and
 * expires well within one candle.
 */
import { config } from '../config.js';
import * as synthetic from './synthetic.js';
import * as binance from './binance.js';

const SOURCES = { synthetic, binance };

export function activeSource() {
  const src = SOURCES[config.source];
  if (!src) throw new Error(`Unknown COINSCOPE_SOURCE: ${config.source}`);
  return src;
}

const cache = new Map(); // key -> { at, candles }
const CACHE_MS = 20_000;

export async function getCandles(symbol, timeframe, limit = config.candleLimit, { fresh = false } = {}) {
  const key = `${config.source}:${symbol}:${timeframe}:${limit}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.candles;

  const candles = await activeSource().fetchCandles(symbol, timeframe, limit);
  cache.set(key, { at: Date.now(), candles });
  return candles;
}

export async function getPrice(symbol, timeframe = config.timeframe) {
  return activeSource().fetchPrice(symbol, timeframe);
}

export function clearCache() {
  cache.clear();
}

/** Verify the configured source actually answers; returns a status object. */
export async function checkSource() {
  const src = activeSource();
  try {
    if (src.ping) await src.ping();
    const candles = await src.fetchCandles(config.symbols[0], config.timeframe, 5);
    return { ok: candles.length > 0, source: src.name, candles: candles.length };
  } catch (err) {
    return { ok: false, source: src.name, error: err.message };
  }
}
