/**
 * Funding-rate history for perpetual futures — from whichever venue will serve it.
 *
 * WHY THIS IS NOT JUST ONE ADAPTER
 *
 * The first two live runs both died before reading a single rate, and the second
 * one said why precisely:
 *
 *     Binance futures 202 on /fapi/v1/exchangeInfo (https://fapi2.binance.com):
 *     пустое тело ответа
 *
 * A 202 with an empty body, from all three futures hosts, is not an API error —
 * it is a gate. A reachability probe then measured the whole picture from CI,
 * and it was wider than assumed: `api.binance.com` answers 451 "restricted
 * location" TOO, not just `fapi.*`. The project keeps working only because
 * `data-api.binance.vision` sits second in the spot host list and does answer —
 * failover, not availability. (An earlier version of this comment claimed the
 * spot host was fine; the probe disproved it.)
 *
 * What the probe also found is that the gate is Binance-and-Bybit specific:
 * OKX, gate.io, bitget, deribit and hyperliquid all answer from the same runner.
 *
 * The question being measured is what THE MARKET pays for holding the unpopular
 * side of a perpetual. That is not a question about Binance. So this module
 * tries venues in order and records which one answered; the report says so, and
 * every HTTP attempt is logged with its status and body length, so a run that
 * fails anyway still teaches us something instead of just ending.
 *
 * The funding interval is never assumed — most perpetuals settle every 8 hours,
 * some every 4 or 1, and schedules change. It is measured from the timestamps.
 */
import { config } from '../config.js';
import { classifyStatus } from './binance.js';

export const name = 'funding';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------- request diagnostics ---------------------- */

/**
 * Every HTTP attempt, with what came back.
 *
 * Two failed runs were spent learning what a plain stack trace refused to say:
 * which host, which path, what status, and whether a body arrived at all. That
 * is cheap to record and is the difference between a run that fails and a run
 * that fails informatively.
 */
const log = [];
export const httpLog = () => [...log];
export const clearHttpLog = () => { log.length = 0; };

const note = (entry) => {
  log.push(entry);
  if (log.length > 200) log.shift();
  return entry;
};

/** One line per attempt, for the report and for the error message. */
export function describeAttempts(entries = log) {
  if (!entries.length) return 'ни одного запроса не сделано';
  return entries.map((a) => (
    `${a.venue} ${a.path} (${a.host}): ${a.status ?? 'нет ответа'}` +
    (a.bodyLength === 0 ? ', пустое тело' : a.bodyLength == null ? '' : `, ${a.bodyLength} байт`) +
    (a.detail ? ` — ${a.detail}` : '')
  )).join('\n');
}

/* ------------------------------ HTTP plumbing ------------------------- */

/**
 * One public GET, with retries and host failover, against any venue.
 *
 * Never `res.json()` straight off an ok status: the first live run died exactly
 * there, because an ok status is a claim about the transport and says nothing
 * about the payload. The body is read as text and parsed here, where a failure
 * can name the host, the path, and what actually arrived.
 */
async function get(venue, hosts, path, params, { attempts = 2 } = {}) {
  let lastError = null;

  for (const host of hosts) {
    let abandonHost = false;

    for (let attempt = 0; attempt < attempts && !abandonHost; attempt++) {
      const url = new URL(host + path);
      for (const [k, v] of Object.entries(params || {})) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), config.binance.timeoutMs);
      let status = null;
      let softFail = false;
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: { accept: 'application/json' },
        });
        status = res.status;
        const text = await res.text();

        if (res.ok) {
          if (!text.trim()) {
            /*
             * The gate that stopped both earlier runs. A 2xx carrying nothing is
             * neither success nor a permanent error: retry, then try a mirror,
             * then let the caller move to another venue.
             */
            softFail = true;
            note({ venue, host, path, status, bodyLength: 0 });
            lastError = new Error(`${venue} ${status} on ${path} (${host}): пустое тело ответа`);
          } else {
            try {
              const data = JSON.parse(text);
              note({ venue, host, path, status, bodyLength: text.length, detail: 'ok' });
              return { data, host };
            } catch {
              softFail = true;
              note({ venue, host, path, status, bodyLength: text.length, detail: 'не JSON' });
              lastError = new Error(
                `${venue} ${status} on ${path} (${host}): тело не JSON — ${text.slice(0, 120)}`);
            }
          }
        } else {
          note({ venue, host, path, status, bodyLength: text.length, detail: text.slice(0, 80) });
          lastError = new Error(`${venue} ${status} on ${path} (${host}): ${text.slice(0, 120)}`);
        }
      } catch (err) {
        note({ venue, host, path, status, bodyLength: null, detail: err.message.slice(0, 80) });
        lastError = err;
      } finally {
        clearTimeout(timer);
      }

      const action = softFail ? 'retry' : classifyStatus(status);
      if (action === 'fatal') throw lastError;
      if (action === 'nextHost') { abandonHost = true; break; }
      if (attempt < attempts - 1) {
        await sleep((status === 429 || status === 418 ? 2000 : 300) * 2 ** attempt);
      }
    }
  }

  throw lastError || new Error(`${venue}: ни один хост не ответил на ${path}`);
}

/* ---------------------------- shared helpers -------------------------- */

/**
 * Funding rows → our shape. A rate is a fraction PER SETTLEMENT INTERVAL
 * (0.0001 = 0.01% every 8 hours), which is why it must never be printed
 * without saying per what.
 */
export function parseFunding(rows) {
  if (!Array.isArray(rows)) throw new Error('Funding: expected an array');
  return rows.map((r) => {
    const point = {
      time: Number(r.fundingTime),
      rate: Number(r.fundingRate),
      markPrice: Number(r.markPrice),
    };
    if (!Number.isFinite(point.time)) throw new Error('Funding: bad fundingTime');
    if (!Number.isFinite(point.rate)) throw new Error('Funding: bad fundingRate');
    if (!Number.isFinite(point.markPrice)) point.markPrice = null;
    return point;
  }).sort((a, b) => a.time - b.time);
}

/** De-duplicate overlapping pages; page edges overlap by design. */
export function mergeByTime(pages) {
  const byTime = new Map();
  for (const page of pages) for (const p of page) byTime.set(p.time, p);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The settlement interval, measured rather than assumed.
 *
 * The median gap, not the mean: a symbol whose schedule changed mid-history, or
 * one with a missing settlement, would drag a mean off the grid the series
 * actually sits on, and the annualisation factor would then be wrong for the
 * whole sample instead of for a few points.
 */
export function medianIntervalMs(points) {
  if (points.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < points.length; i++) {
    const g = points[i].time - points[i - 1].time;
    if (g > 0) gaps.push(g);
  }
  return gaps.length ? median(gaps) : null;
}

/**
 * Perpetuals worth harvesting, ranked by turnover.
 *
 * The liquidity floor is the same honesty filter as on spot, and here it bites
 * twice: a thin perpetual pays the widest funding precisely because nobody will
 * take the other side, and the spread you cross to get delta-neutral eats the
 * yield that attracted you.
 */
export function selectPerpUniverse(rows, { limit = 40, minQuoteVolume = 50e6 } = {}) {
  if (!Array.isArray(rows)) throw new Error('Perp tickers: expected an array');
  return rows
    .filter((r) => typeof r?.symbol === 'string' && r.symbol.endsWith('USDT'))
    .map((r) => ({ symbol: r.symbol, quoteVolume: Number(r.quoteVolume) }))
    .filter((r) => Number.isFinite(r.quoteVolume) && r.quoteVolume >= minQuoteVolume)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, limit);
}

/* ============================ venue: Binance ========================== */

/** Futures market-data hosts, in order. Overridable for blocked regions. */
export function fapiHosts() {
  const extra = (process.env.BINANCE_FAPI_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([
    ...extra,
    process.env.BINANCE_FAPI_URL || 'https://fapi.binance.com',
    'https://fapi1.binance.com',
    'https://fapi2.binance.com',
  ])];
}

const PAGE = 1000;

/** Funding history, paged backwards until `periods` settlements are in hand. */
export async function fetchFundingRange(symbol, periods, { onPage } = {}) {
  const pages = [];
  let endTime = Date.now();
  let have = 0;

  const maxPages = Math.ceil(periods / PAGE) + 4;
  for (let p = 0; p < maxPages && have < periods; p++) {
    const { data } = await get('binance-futures', fapiHosts(), '/fapi/v1/fundingRate',
      { symbol, limit: PAGE, endTime });
    const page = parseFunding(data);
    if (!page.length) break;

    pages.push(page);
    have += page.length;
    onPage?.({ symbol, fetched: have, want: periods });

    const nextEnd = page[0].time - 1;
    if (nextEnd >= endTime) break;
    endTime = nextEnd;
    if (page.length < PAGE) break;
    await sleep(120);
  }

  return mergeByTime(pages).slice(-periods);
}

/** Perpetual klines, for basis and for the up-move risk on the short leg. */
export async function fetchPerpKlines(symbol, interval, bars) {
  const out = [];
  let endTime = Date.now();
  const maxPages = Math.ceil(bars / PAGE) + 2;

  for (let p = 0; p < maxPages && out.length < bars; p++) {
    const { data } = await get('binance-futures', fapiHosts(), '/fapi/v1/klines',
      { symbol, interval, limit: PAGE, endTime });
    if (!Array.isArray(data) || !data.length) break;
    const page = data.map((r) => ({
      time: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
      low: Number(r[3]), close: Number(r[4]), closeTime: Number(r[6]),
    }));
    out.push(...page);
    const nextEnd = page[0].time - 1;
    if (nextEnd >= endTime) break;
    endTime = nextEnd;
    if (page.length < PAGE) break;
    await sleep(120);
  }

  const byTime = new Map();
  for (const c of out) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-bars);
}

/**
 * Perpetual symbols from the contract catalogue.
 *
 * Stricter than a ticker list in one way that matters: it states the contract
 * type, so quarterly deliveries cannot slip in. Those have a fixed expiry and
 * funding of a different shape, and pooling them with perpetuals would measure
 * two instruments as one.
 */
export function parsePerpSymbols(info) {
  const symbols = info?.symbols;
  if (!Array.isArray(symbols)) throw new Error('Binance futures exchangeInfo: expected symbols[]');
  return symbols
    .filter((s) => s?.contractType === 'PERPETUAL' && s?.status === 'TRADING' && s?.quoteAsset === 'USDT')
    .map((s) => s.symbol);
}

async function binanceUniverse(opts) {
  const { data } = await get('binance-futures', fapiHosts(), '/fapi/v1/ticker/24hr', {});
  const uni = selectPerpUniverse(data, opts);
  if (!uni.length) throw new Error('Фьючерсный тикер вернул пустой список');
  return uni;
}

/* ============================= venue: Bybit =========================== */

export function bybitHosts() {
  const extra = (process.env.BYBIT_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...extra, process.env.BYBIT_URL || 'https://api.bybit.com'])];
}

/**
 * Bybit wraps every answer in a return code, and a non-zero code arrives with
 * HTTP 200. Unwrapping it here means the rest of the module never has to know,
 * and a venue-level rejection is not mistaken for data.
 */
function bybitResult(data, path) {
  if (data?.retCode !== 0 && data?.retCode !== undefined && Number(data.retCode) !== 0) {
    throw new Error(`bybit ${path}: retCode ${data.retCode} — ${data.retMsg || 'без сообщения'}`);
  }
  const result = data?.result;
  if (!result) throw new Error(`bybit ${path}: нет result в ответе`);
  return result;
}

/** Bybit funding rows → our shape. */
export function parseBybitFunding(result) {
  const list = result?.list;
  if (!Array.isArray(list)) throw new Error('bybit funding: expected result.list[]');
  return list.map((r) => {
    const point = {
      time: Number(r.fundingRateTimestamp),
      rate: Number(r.fundingRate),
      markPrice: null,
    };
    if (!Number.isFinite(point.time)) throw new Error('bybit funding: bad fundingRateTimestamp');
    if (!Number.isFinite(point.rate)) throw new Error('bybit funding: bad fundingRate');
    return point;
  }).sort((a, b) => a.time - b.time);
}

/** Bybit linear tickers → the shape selectPerpUniverse expects. */
export function parseBybitTickers(result) {
  const list = result?.list;
  if (!Array.isArray(list)) throw new Error('bybit tickers: expected result.list[]');
  return list.map((r) => ({ symbol: r.symbol, quoteVolume: Number(r.turnover24h) }));
}

/**
 * Bybit linear instruments → live USDT perpetuals only.
 * `contractType: 'LinearPerpetual'` is the perpetual; `LinearFutures` is dated.
 */
export function parseBybitPerps(result) {
  const list = result?.list;
  if (!Array.isArray(list)) throw new Error('bybit instruments: expected result.list[]');
  return list
    .filter((s) => s?.contractType === 'LinearPerpetual' && s?.status === 'Trading' && s?.quoteCoin === 'USDT')
    .map((s) => s.symbol);
}

const BYBIT_PAGE = 200;

export async function bybitFundingRange(symbol, periods, { onPage } = {}) {
  const pages = [];
  let endTime = Date.now();
  let have = 0;

  const maxPages = Math.ceil(periods / BYBIT_PAGE) + 4;
  for (let p = 0; p < maxPages && have < periods; p++) {
    const { data } = await get('bybit', bybitHosts(), '/v5/market/funding/history',
      { category: 'linear', symbol, limit: BYBIT_PAGE, endTime });
    const page = parseBybitFunding(bybitResult(data, '/v5/market/funding/history'));
    if (!page.length) break;

    pages.push(page);
    have += page.length;
    onPage?.({ symbol, fetched: have, want: periods });

    const nextEnd = page[0].time - 1;
    if (nextEnd >= endTime) break;
    endTime = nextEnd;
    if (page.length < BYBIT_PAGE) break;
    await sleep(120);
  }

  return mergeByTime(pages).slice(-periods);
}

/** Bybit intervals are minutes as strings; '60' is an hour, 'D' a day. */
const BYBIT_INTERVAL = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' };

export async function bybitKlines(symbol, interval, bars) {
  const iv = BYBIT_INTERVAL[interval];
  if (!iv) throw new Error(`bybit: неподдерживаемый интервал ${interval}`);

  const out = [];
  let end = Date.now();
  const maxPages = Math.ceil(bars / BYBIT_PAGE) + 2;

  for (let p = 0; p < maxPages && out.length < bars; p++) {
    const { data } = await get('bybit', bybitHosts(), '/v5/market/kline',
      { category: 'linear', symbol, interval: iv, limit: BYBIT_PAGE, end });
    const list = bybitResult(data, '/v5/market/kline')?.list;
    if (!Array.isArray(list) || !list.length) break;

    // Bybit returns newest first; our series is ascending everywhere else.
    const page = list.map((r) => ({
      time: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
      low: Number(r[3]), close: Number(r[4]),
    })).sort((a, b) => a.time - b.time);

    out.push(...page);
    const nextEnd = page[0].time - 1;
    if (nextEnd >= end) break;
    end = nextEnd;
    if (page.length < BYBIT_PAGE) break;
    await sleep(120);
  }

  const byTime = new Map();
  for (const c of out) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-bars);
}

async function bybitUniverse(opts) {
  const { data } = await get('bybit', bybitHosts(), '/v5/market/tickers', { category: 'linear' });
  const rows = parseBybitTickers(bybitResult(data, '/v5/market/tickers'));
  const uni = selectPerpUniverse(rows, opts);
  if (!uni.length) throw new Error('Тикеры bybit вернули пустой список');
  return uni;
}

/* ============================== venue: OKX ============================ */

/**
 * OKX, chosen because it actually answers and because it serves BOTH legs.
 *
 * The reachability probe settled the choice with measurements instead of
 * guesses: from GitHub's runners Binance (spot and futures alike) returns 451
 * "restricted location" and Bybit 403 from CloudFront, while OKX, gate.io,
 * bitget, deribit and hyperliquid all answer. Among those, OKX is the one that
 * lists both spot and perpetual markets for the same coin — so the basis can be
 * measured INSIDE one venue, which is the tighter and more honest version of
 * the risk than a spread between two exchanges.
 *
 * Its shape differs from Binance in three ways that all have to be handled
 * rather than assumed: instruments are named `BTC-USDT-SWAP`, every answer is
 * wrapped in a string `code`, and pages are walked with `after` rather than
 * `endTime`.
 */
export function okxHosts() {
  const extra = (process.env.OKX_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...extra, process.env.OKX_URL || 'https://www.okx.com'])];
}

/**
 * Unwrap OKX's envelope. A rejected request arrives with HTTP 200 and a
 * non-zero `code`, so treating the status as the verdict would read an error
 * message as data.
 */
function okxData(payload, path) {
  if (payload?.code !== undefined && String(payload.code) !== '0') {
    throw new Error(`okx ${path}: code ${payload.code} — ${payload.msg || 'без сообщения'}`);
  }
  const data = payload?.data;
  if (!Array.isArray(data)) throw new Error(`okx ${path}: нет data[] в ответе`);
  return data;
}

/* Symbol shapes. Kept as small pure functions because getting them wrong is
 * silent: a malformed instId returns an empty list, not an error. */
export const okxPerpId = (symbol) => `${symbol.replace(/USDT$/, '')}-USDT-SWAP`;
export const okxSpotId = (symbol) => `${symbol.replace(/USDT$/, '')}-USDT`;
export const symbolFromOkx = (instId) => String(instId || '').replace(/-USDT(-SWAP)?$/, '') + 'USDT';

/** OKX funding rows → our shape. */
export function parseOkxFunding(data) {
  if (!Array.isArray(data)) throw new Error('okx funding: expected an array');
  return data.map((r) => {
    const point = {
      time: Number(r.fundingTime),
      /*
       * `realizedRate` is what was actually charged; `fundingRate` on a
       * historical row is the same value for settled periods. Prefer the
       * realized one where present — the measurement is about money that moved,
       * not about a rate that was predicted.
       */
      rate: Number(r.realizedRate ?? r.fundingRate),
      markPrice: null,
    };
    if (!Number.isFinite(point.time)) throw new Error('okx funding: bad fundingTime');
    if (!Number.isFinite(point.rate)) throw new Error('okx funding: bad fundingRate');
    return point;
  }).sort((a, b) => a.time - b.time);
}

/**
 * OKX tickers → the shape selectPerpUniverse expects.
 *
 * The turnover needs building, not reading: `volCcy24h` is in the BASE currency
 * for a USDT-margined swap, so quote turnover is that times the last price.
 * Taking `vol24h` (contracts) or `volCcy24h` directly would rank the universe by
 * a quantity that means something different for every coin.
 */
export function parseOkxTickers(data) {
  if (!Array.isArray(data)) throw new Error('okx tickers: expected an array');
  return data
    .filter((r) => typeof r?.instId === 'string' && r.instId.endsWith('-USDT-SWAP'))
    .map((r) => {
      const base = Number(r.volCcy24h);
      const last = Number(r.last);
      return {
        symbol: symbolFromOkx(r.instId),
        quoteVolume: Number.isFinite(base) && Number.isFinite(last) ? base * last : NaN,
      };
    });
}

/** Live USDT perpetuals from the instrument catalogue. */
export function parseOkxPerps(data) {
  if (!Array.isArray(data)) throw new Error('okx instruments: expected an array');
  return data
    .filter((s) => s?.state === 'live' && typeof s.instId === 'string' && s.instId.endsWith('-USDT-SWAP'))
    .map((s) => symbolFromOkx(s.instId));
}

/** OKX candles are newest-first arrays; ours are ascending objects. */
export function parseOkxCandles(data) {
  if (!Array.isArray(data)) throw new Error('okx candles: expected an array');
  return data.map((r) => ({
    time: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
    low: Number(r[3]), close: Number(r[4]),
  })).filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
    .sort((a, b) => a.time - b.time);
}

const OKX_FUNDING_PAGE = 100;

export async function okxFundingRange(symbol, periods, { onPage } = {}) {
  const instId = okxPerpId(symbol);
  const pages = [];
  let after = null;          // OKX: return records EARLIER than this fundingTime
  let have = 0;

  const maxPages = Math.ceil(periods / OKX_FUNDING_PAGE) + 4;
  for (let p = 0; p < maxPages && have < periods; p++) {
    const { data } = await get('okx', okxHosts(), '/api/v5/public/funding-rate-history',
      { instId, limit: OKX_FUNDING_PAGE, ...(after ? { after } : {}) });
    const page = parseOkxFunding(okxData(data, '/api/v5/public/funding-rate-history'));
    if (!page.length) break;

    pages.push(page);
    have += page.length;
    onPage?.({ symbol, fetched: have, want: periods });

    const oldest = page[0].time;
    if (after != null && oldest >= Number(after)) break;   // no progress: stop
    after = String(oldest);
    if (page.length < OKX_FUNDING_PAGE) break;             // history starts here
    await sleep(120);
  }

  return mergeByTime(pages).slice(-periods);
}

/** OKX bar codes: minutes are plain, hours and days are upper case. */
const OKX_BAR = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1d': '1D' };
const OKX_CANDLE_PAGE = 100;

async function okxCandleRange(instId, interval, bars) {
  const bar = OKX_BAR[interval];
  if (!bar) throw new Error(`okx: неподдерживаемый интервал ${interval}`);

  const out = [];
  let after = null;
  const maxPages = Math.ceil(bars / OKX_CANDLE_PAGE) + 2;

  for (let p = 0; p < maxPages && out.length < bars; p++) {
    // history-candles reaches back; /market/candles only covers the recent tail.
    const { data } = await get('okx', okxHosts(), '/api/v5/market/history-candles',
      { instId, bar, limit: OKX_CANDLE_PAGE, ...(after ? { after } : {}) });
    const page = parseOkxCandles(okxData(data, '/api/v5/market/history-candles'));
    if (!page.length) break;

    out.push(...page);
    const oldest = page[0].time;
    if (after != null && oldest >= Number(after)) break;
    after = String(oldest);
    if (page.length < OKX_CANDLE_PAGE) break;
    await sleep(120);
  }

  const byTime = new Map();
  for (const c of out) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-bars);
}

export const okxKlines = (symbol, interval, bars) => okxCandleRange(okxPerpId(symbol), interval, bars);

/**
 * The spot leg from the SAME venue — the reason OKX was picked.
 *
 * With both legs on one exchange the basis is the real spread the position
 * carries. A Binance spot leg against an OKX short would be a working trade too,
 * but its basis is a spread between two venues, which is a wider and different
 * risk; measuring one and reporting it as the other would understate exactly
 * the thing the basis panel exists to show.
 */
export const okxSpotKlines = (symbol, interval, bars) => okxCandleRange(okxSpotId(symbol), interval, bars);

async function okxUniverse(opts) {
  const { data } = await get('okx', okxHosts(), '/api/v5/market/tickers', { instType: 'SWAP' });
  const rows = parseOkxTickers(okxData(data, '/api/v5/market/tickers'));
  const uni = selectPerpUniverse(rows, opts);
  if (!uni.length) throw new Error('Тикеры okx вернули пустой список');
  return uni;
}

/* ======================= venue selection and routing ================== */

/**
 * Last resort, and the one route that depends on no futures host at all.
 *
 * My own fallback in the previous attempt was broken in exactly this way: it
 * began with `/fapi/v1/exchangeInfo`, so it failed wherever the primary path
 * failed. A fallback that needs the gate to open is not a fallback. This one
 * ranks by SPOT turnover from `api.binance.com` — a host these runners reach
 * every hour — and lets the funding fetch itself decide which of those symbols
 * actually has a perpetual: one without history simply drops out.
 */
async function spotRankedUniverse(opts) {
  const spot = await import('./binance.js');
  const rows = await spot.fetchUniverse({
    limit: Math.max((opts.limit || 40) * 3, 60),
    minQuoteVolume: opts.minQuoteVolume ?? 50e6,
  });
  return rows.slice(0, (opts.limit || 40) * 2).map((r) => ({ ...r, volumeFrom: 'spot' }));
}

const VENUES = [
  {
    id: 'binance-futures',
    label: 'binance futures',
    universe: binanceUniverse,
    funding: fetchFundingRange,
    klines: fetchPerpKlines,
  },
  /*
   * OKX sits ahead of Bybit because the reachability probe measured it as open
   * from CI while Bybit is CloudFront-blocked — and because it serves the spot
   * leg too, which keeps the basis inside one venue. Binance stays first: when
   * this runs from somewhere Binance answers, it is the more liquid market and
   * the rest of the project already measures it.
   */
  {
    id: 'okx',
    label: 'okx swap',
    universe: okxUniverse,
    funding: okxFundingRange,
    klines: okxKlines,
    spotKlines: okxSpotKlines,
  },
  {
    id: 'bybit',
    label: 'bybit linear',
    universe: bybitUniverse,
    funding: bybitFundingRange,
    klines: bybitKlines,
  },
];

/** Which venue answered. Sticky for the whole run so numbers stay comparable. */
let chosen = null;
export const activeVenue = () => chosen;
export const resetVenue = () => { chosen = null; };

/**
 * Pick a venue by trying them, and say what happened when none works.
 *
 * Order is deliberate: Binance first because the rest of the project measures
 * Binance spot, and a same-venue basis is the cleaner thing to report. Bybit
 * second because its funding history is public, its symbols are named the same
 * way, and its ticker reports turnover directly in the quote currency.
 */
export async function resolveVenue(opts = {}) {
  if (chosen) return chosen;
  const failures = [];

  for (const venue of VENUES) {
    /*
     * A venue qualifies only if it can serve FUNDING, not merely a symbol list.
     * The previous version checked the ticker alone, and when every ticker was
     * gated it fell back to a spot-ranked universe while still pointing the
     * funding fetch at the blocked host — so the run asked a closed door for
     * sixteen symbols in a row before giving up. Which list we have is useless
     * if the rates behind it are unreachable, so the rates are what decides.
     */
    let universe = null;
    try {
      universe = await venue.universe(opts);
    } catch (err) {
      failures.push(`${venue.label}, список: ${err.message}`);
      /*
       * The list is gated but the rates might not be. Rank by SPOT turnover —
       * a host these runners do reach — and let the funding probe below decide
       * whether this venue is usable at all.
       */
      try {
        universe = await spotRankedUniverse(opts);
      } catch (spotErr) {
        failures.push(`${venue.label}, спот-ранжирование: ${spotErr.message}`);
        continue;
      }
    }

    if (!universe?.length) { failures.push(`${venue.label}: пустой список`); continue; }

    // One cheap funding request decides it. Cheaper than sixteen hopeful ones.
    try {
      const probe = await venue.funding(universe[0].symbol, 10);
      if (!probe.length) throw new Error('история фандинга пуста');
      chosen = {
        ...venue, universe,
        route: universe[0].volumeFrom === 'spot' ? 'spot-ranked' : 'tickers',
      };
      return chosen;
    } catch (err) {
      failures.push(`${venue.label}, фандинг ${universe[0].symbol}: ${err.message}`);
    }
  }

  throw new Error(
    'Ни одна площадка не отдала историю фандинга.\n' +
    failures.map((f) => `  — ${f}`).join('\n') +
    '\nВсе запросы:\n' + describeAttempts(),
  );
}

/* ------------------------------ offline mode -------------------------- */

const HOUR = 3600_000;

/**
 * Deterministic stand-in so the suite runs with no network.
 *
 * Boring on purpose: a small positive mean for most symbols, a negative mean for
 * one, fat-ish noise around it. It must never be mistaken for evidence — the
 * report refuses to draw a market conclusion from it at all.
 */
export function syntheticFunding(symbol, periods, { intervalMs = 8 * HOUR } = {}) {
  let h = 2166136261;
  for (const ch of symbol) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  let s = (h >>> 0) || 1;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };

  const mean = (h % 5 === 0 ? -1 : 1) * (0.00004 + (h % 7) * 0.00002);
  const noise = 0.00025;

  const end = Math.floor(Date.now() / intervalMs) * intervalMs;
  const out = [];
  for (let i = periods - 1; i >= 0; i--) {
    const gauss = (rnd() + rnd() + rnd() + rnd() - 2) / 1.155;  // ~N(0,1)
    out.push({
      time: end - i * intervalMs,
      rate: Math.max(-0.0075, Math.min(0.0075, mean + gauss * noise)),
      markPrice: 100,
    });
  }
  return out;
}

async function syntheticPerpKlines(symbol, interval, bars) {
  const synthetic = await import('./synthetic.js');
  return synthetic.fetchCandlesRange(symbol, interval, bars);
}

const offline = () => config.source === 'synthetic';

/* -------------------- the entry points everything uses ---------------- */

export async function getPerpUniverse(opts = {}) {
  if (offline()) {
    return config.symbols.map((symbol, i) => ({ symbol, quoteVolume: 1e9 - i * 1e6 }));
  }
  return (await resolveVenue(opts)).universe;
}

export async function getFunding(symbol, periods, opts = {}) {
  if (offline()) return syntheticFunding(symbol, periods);
  const venue = await resolveVenue();
  return venue.funding(symbol, periods, opts);
}

export async function getPerpKlines(symbol, interval, bars) {
  if (offline()) return syntheticPerpKlines(symbol, interval, bars);
  const venue = await resolveVenue();
  return venue.klines(symbol, interval, bars);
}

/**
 * The spot leg, from the funding venue when it has one.
 *
 * Returns null when the chosen venue serves no spot market, and the caller then
 * falls back to Binance spot — a working position, but one whose basis is a
 * spread BETWEEN venues. Which of the two happened has to reach the report,
 * because the same number means a tighter risk in one case than the other.
 */
export async function getVenueSpotKlines(symbol, interval, bars) {
  if (offline()) return syntheticPerpKlines(symbol, interval, bars);
  const venue = await resolveVenue();
  return venue.spotKlines ? venue.spotKlines(symbol, interval, bars) : null;
}

/**
 * What produced the numbers — named in the report, because it changes how they
 * should be read. A Bybit perpetual against a Binance spot leg is a real
 * position, but its basis is the spread BETWEEN two venues, which is a wider
 * risk than the same-venue version and has to be labelled as such.
 */
export function sourceLabel() {
  if (offline()) return 'synthetic (генератор, не рынок)';
  if (!chosen) return 'площадка ещё не выбрана';
  return `${chosen.label} (список: ${chosen.route === 'spot-ranked' ? 'оборот спота' : 'тикеры площадки'})`;
}

export async function ping() {
  await resolveVenue({ limit: 5 });
  return true;
}
