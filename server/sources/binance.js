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

/** Hosts to try in order; the first that answers becomes the preferred one. */
export function hostList() {
  const extra = (process.env.BINANCE_BASE_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const defaults = [
    config.binance.baseUrl,
    'https://data-api.binance.vision', // Binance's market-data-only host
    'https://api-gcp.binance.com',
    'https://api1.binance.com',
  ];
  return [...new Set([...extra, ...defaults])];
}

/** Index of the host currently believed to work; sticky between calls. */
let preferredHost = 0;

/** Which mirror actually served the last successful request. */
export function activeHost() {
  return hostList()[preferredHost] || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How to react to a failed response.
 *
 *  'retry'    — transient: same host, after a pause.
 *  'nextHost' — this host will not serve us (geo-block, forbidden), but a
 *               mirror might. Binance answers 451/403 by location, which is
 *               precisely what the mirror list exists for.
 *  'fatal'    — a bad symbol or malformed argument fails identically
 *               everywhere; retrying just burns the rate limit.
 */
export function classifyStatus(status) {
  if (status === null) return 'retry';              // transport / timeout
  if (status === 429 || status === 418) return 'retry';
  if (status >= 500) return 'retry';
  if (status === 403 || status === 451 || status === 401) return 'nextHost';
  return 'fatal';
}

/**
 * One public GET with retries and host failover.
 *
 * A silent stall here is worse than an error: if the price loop stops, open
 * signals never reach their stop or target and the track record quietly
 * freezes. So transient failures are retried, and a dead host is abandoned in
 * favour of a mirror.
 */
async function request(path, params, { attempts = 3 } = {}) {
  const hosts = hostList();
  let lastError = null;

  for (let hostTry = 0; hostTry < hosts.length; hostTry++) {
    const host = hosts[(preferredHost + hostTry) % hosts.length];
    let abandonHost = false;

    for (let attempt = 0; attempt < attempts && !abandonHost; attempt++) {
      const url = new URL(host + path);
      for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), config.binance.timeoutMs);
      let status = null;
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        status = res.status;
        if (res.ok) {
          preferredHost = (preferredHost + hostTry) % hosts.length;
          return await res.json();
        }
        const body = await res.text().catch(() => '');
        lastError = new Error(`Binance ${res.status} on ${path} (${host}): ${body.slice(0, 160)}`);
      } catch (err) {
        lastError = err;
      } finally {
        clearTimeout(timer);
      }

      const action = classifyStatus(status);
      if (action === 'fatal') throw lastError;
      if (action === 'nextHost') { abandonHost = true; break; }

      if (attempt < attempts - 1) {
        // Exponential backoff, and honour a rate-limit cool-off generously.
        await sleep((status === 429 || status === 418 ? 2000 : 300) * 2 ** attempt);
      }
    }
  }
  throw lastError || new Error(`Binance: ни один хост не ответил на ${path}`);
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

/**
 * Merge overlapping pages into one clean ascending series.
 * Pages are requested by time window, so their edges overlap by design;
 * a duplicate bar would be counted twice by every statistic downstream.
 */
export function mergePages(pages) {
  const byTime = new Map();
  for (const page of pages) for (const c of page) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * A long history, assembled by paging backwards.
 *
 * One request returns at most 1000 candles — about 41 days on 1h. That is a
 * single market regime, and any conclusion drawn from it says more about the
 * last six weeks than about the strategy. Statistics sliced by score, session
 * or volatility need far more than that before a bucket holds enough trades to
 * mean anything, so this walks back page by page.
 *
 * `onPage` reports progress; a long fetch is otherwise a silent several-minute
 * wait in CI.
 */
export async function fetchCandlesRange(symbol, timeframe, bars, { onPage } = {}) {
  const interval = INTERVAL[timeframe];
  if (!interval) throw new Error(`Unsupported timeframe for Binance: ${timeframe}`);

  const PAGE = 1000;
  const pages = [];
  let endTime = Date.now();
  let have = 0;

  // The bound is generous: pages can come back short near the listing date,
  // and the loop must end even then.
  const maxPages = Math.ceil(bars / PAGE) + 4;
  for (let p = 0; p < maxPages && have < bars; p++) {
    const rows = await request('/api/v3/klines', {
      symbol, interval, limit: PAGE, endTime,
    });
    const page = parseKlines(rows);
    if (!page.length) break;

    pages.push(page);
    have += page.length;
    onPage?.({ symbol, fetched: have, want: bars });

    // Step strictly before this page's first bar, or the same page repeats.
    const nextEnd = page[0].time - 1;
    if (nextEnd >= endTime) break;      // no progress: stop rather than spin
    endTime = nextEnd;

    // Fewer bars than asked means the coin's history starts here.
    if (page.length < PAGE) break;
    // Binance allows 6000 weight/minute; this stays far below it while still
    // being polite on a fetch that issues dozens of requests in a row.
    await sleep(120);
  }

  const merged = mergePages(pages);
  const closed = dropUnclosed(merged);
  // A gap-free tail matters more than raw count: statistics are computed on
  // consecutive bars, so hand back the newest `bars` of what we actually got.
  return closed.slice(-bars);
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
/**
 * The tradable universe, ranked by how much money actually moves through it.
 *
 * Adding coins is the cheapest way to multiply the sample, but "more" is the
 * wrong selection rule. The whole cost model assumes a fixed 0.05% slippage,
 * and that assumption is defensible on a pair turning over hundreds of
 * millions a day and fantasy on one turning over two. Ranking by 24h quote
 * volume and cutting below a floor keeps the assumption honest — a universe
 * chosen by "whatever exists" would quietly inflate every result by charging
 * illiquid coins a liquid coin's costs.
 *
 * Excluded on sight: anything not quoted in USDT, leveraged tokens (UP/DOWN/
 * BULL/BEAR — they track a derivative, not the coin), and stablecoin pairs,
 * whose price barely moves and whose ATR-scaled stops would be absurd.
 */
export function selectUniverse(rows, { limit = 40, minQuoteVolume = 50e6 } = {}) {
  if (!Array.isArray(rows)) throw new Error('Binance 24hr: expected an array');

  const STABLE = /^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EUR|GBP|AEUR|USD1)USDT$/;
  const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;

  return rows
    .filter((r) => typeof r?.symbol === 'string' && r.symbol.endsWith('USDT'))
    .filter((r) => !STABLE.test(r.symbol) && !LEVERAGED.test(r.symbol))
    .map((r) => ({
      symbol: r.symbol,
      quoteVolume: Number(r.quoteVolume),
      trades: Number(r.count),
      changePct: Number(r.priceChangePercent),
    }))
    .filter((r) => Number.isFinite(r.quoteVolume) && r.quoteVolume >= minQuoteVolume)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, limit);
}

/** Live universe from the exchange. Falls back to the configured list on error. */
export async function fetchUniverse(opts = {}) {
  const rows = await request('/api/v3/ticker/24hr', {});
  return selectUniverse(rows, opts);
}

export async function ping() {
  await request('/api/v3/ping', {});
  return true;
}
