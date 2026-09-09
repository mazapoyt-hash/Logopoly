/**
 * Binance public market data (read-only, no API key required).
 *
 * Only public endpoints are used — no account, no orders, no keys. If
 * api.binance.com is blocked in your region, point BINANCE_BASE_URL at a
 * mirror such as https://api-gcp.binance.com or https://data-api.binance.vision
 * (the latter is Binance's public market-data-only host).
 */
import { config } from '../config.js';

export const name = 'binance';

/** Binance interval strings happen to match ours, but map explicitly. */
const INTERVAL = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '1d': '1d',
};

async function request(path, params) {
  const url = new URL(config.binance.baseUrl + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.binance.timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Binance ${res.status} on ${path}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse Binance's kline rows into our candle shape.
 * Row: [openTime, open, high, low, close, volume, closeTime, ...]
 * Exported so the format can be tested without network access.
 */
export function parseKlines(rows) {
  if (!Array.isArray(rows)) throw new Error('Binance klines: expected an array');
  return rows.map((r) => {
    const candle = {
      time: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      closeTime: Number(r[6]),
    };
    for (const k of ['time', 'open', 'high', 'low', 'close', 'volume']) {
      if (!Number.isFinite(candle[k])) throw new Error(`Binance klines: bad ${k}`);
    }
    return candle;
  });
}

/**
 * The most recent candle is still forming; including it would make signals
 * fire on incomplete data and repaint. Drop it unless explicitly asked.
 */
export function dropUnclosed(candles, nowMs = Date.now()) {
  if (!candles.length) return candles;
  const last = candles[candles.length - 1];
  if (Number.isFinite(last.closeTime) && last.closeTime >= nowMs) return candles.slice(0, -1);
  return candles;
}

export async function fetchCandles(symbol, timeframe, limit) {
  const interval = INTERVAL[timeframe];
  if (!interval) throw new Error(`Unsupported timeframe for Binance: ${timeframe}`);
  // +1 because the in-progress candle gets dropped.
  const rows = await request('/api/v3/klines', {
    symbol, interval, limit: Math.min(limit + 1, 1000),
  });
  return dropUnclosed(parseKlines(rows)).slice(-limit);
}

export async function fetchPrice(symbol) {
  const data = await request('/api/v3/ticker/price', { symbol });
  const price = Number(data?.price);
  if (!Number.isFinite(price)) throw new Error(`Binance price: bad payload for ${symbol}`);
  return price;
}

/** Parse the batch ticker payload. Exported so it can be tested offline. */
export function parseTickers(rows) {
  if (!Array.isArray(rows)) throw new Error('Binance tickers: expected an array');
  const out = {};
  for (const r of rows) {
    const price = Number(r?.price);
    if (r?.symbol && Number.isFinite(price)) out[r.symbol] = price;
  }
  return out;
}

/**
 * One request for every tracked coin — the price loop runs every few seconds,
 * so asking per symbol would burn the rate limit for nothing.
 */
export async function fetchPrices(symbols) {
  if (!symbols?.length) return {};
  const rows = await request('/api/v3/ticker/price', {
    symbols: JSON.stringify(symbols),
  });
  return parseTickers(rows);
}

/** Sanity check used at startup so a misconfigured host fails loudly. */
export async function ping() {
  await request('/api/v3/ping', {});
  return true;
}
