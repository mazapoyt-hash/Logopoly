/**
 * Funding-rate history from Binance USDⓈ-M futures (public, read-only).
 *
 * Why a separate source module at all: this lives on a different host from spot
 * market data (`fapi.binance.com`, not `api.binance.com`), the payload has
 * nothing in common with a candle, and the sampling grid is the funding interval
 * rather than a timeframe. Bolting it onto the kline fetcher would have meant
 * two unrelated shapes behind one name.
 *
 * The funding interval is NOT assumed. Most perpetuals settle every 8 hours,
 * but Binance runs some on 4h and a few on 1h, and the interval is changed from
 * time to time. Everything downstream is annualised from the interval measured
 * out of the timestamps themselves, so a 4h symbol is not silently reported at
 * half its real yield.
 */
import { config } from '../config.js';
import { classifyStatus } from './binance.js';

export const name = 'funding';

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

let preferredHost = 0;
export const activeHost = () => fapiHosts()[preferredHost] || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One public GET with retries and host failover. Same policy as spot. */
async function request(path, params, { attempts = 3 } = {}) {
  const hosts = fapiHosts();
  let lastError = null;

  for (let hostTry = 0; hostTry < hosts.length; hostTry++) {
    const host = hosts[(preferredHost + hostTry) % hosts.length];
    let abandonHost = false;

    for (let attempt = 0; attempt < attempts && !abandonHost; attempt++) {
      const url = new URL(host + path);
      for (const [k, v] of Object.entries(params || {})) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), config.binance.timeoutMs);
      let status = null;
      let emptyBody = false;
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          // Without these the futures host has been observed answering 200 with
          // an empty body, which is what broke the first live run.
          headers: { accept: 'application/json', 'user-agent': 'coinscope/0.1' },
        });
        status = res.status;

        /*
         * Never `res.json()` straight off a 200. The first live run died exactly
         * there: the futures ticker answered 200 with an EMPTY body, and
         * `Unexpected end of JSON input` came out of undici's internals with no
         * hint of which host, which path, or that the body was empty at all.
         * An ok status is a claim about the transport, not about the payload —
         * so the body is read as text and parsed here, where a failure can say
         * what actually arrived and be retried like any other bad answer.
         */
        const text = await res.text();
        if (res.ok) {
          if (!text.trim()) {
            emptyBody = true;
            lastError = new Error(
              `Binance futures ${res.status} on ${path} (${host}): пустое тело ответа`);
          } else {
            try {
              const data = JSON.parse(text);
              preferredHost = (preferredHost + hostTry) % hosts.length;
              return data;
            } catch {
              emptyBody = true;     // not JSON: same treatment, retry then fail over
              lastError = new Error(
                `Binance futures ${res.status} on ${path} (${host}): тело не JSON — ` +
                `${text.slice(0, 160)}`);
            }
          }
        } else {
          lastError = new Error(
            `Binance futures ${res.status} on ${path} (${host}): ${text.slice(0, 160)}`);
        }
      } catch (err) {
        lastError = err;
      } finally {
        clearTimeout(timer);
      }

      // A 200 carrying nothing is not a success and not a permanent failure:
      // retry here, then let the loop try a mirror.
      const action = emptyBody ? 'retry' : classifyStatus(status);
      if (action === 'fatal') throw lastError;
      if (action === 'nextHost') { abandonHost = true; break; }
      if (attempt < attempts - 1) {
        await sleep((status === 429 || status === 418 ? 2000 : 300) * 2 ** attempt);
      }
    }
  }
  throw lastError || new Error(`Binance futures: ни один хост не ответил на ${path}`);
}

/* ------------------------------- parsing ------------------------------ */

/**
 * Funding rows → our shape. A rate is a fraction PER FUNDING INTERVAL
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

/**
 * The settlement interval, measured rather than assumed.
 *
 * The median gap is used, not the mean: a symbol whose schedule was changed
 * mid-history, or one with a missing settlement, would drag a mean far off the
 * grid the series actually sits on, and the annualisation factor would be wrong
 * for the whole sample instead of for a few points.
 */
export function medianIntervalMs(points) {
  if (points.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < points.length; i++) {
    const g = points[i].time - points[i - 1].time;
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const m = gaps.length >> 1;
  return gaps.length % 2 ? gaps[m] : (gaps[m - 1] + gaps[m]) / 2;
}

/* ------------------------------- fetching ----------------------------- */

const PAGE = 1000;

/** Funding history, paged backwards until `periods` settlements are in hand. */
export async function fetchFundingRange(symbol, periods, { onPage } = {}) {
  const pages = [];
  let endTime = Date.now();
  let have = 0;

  const maxPages = Math.ceil(periods / PAGE) + 4;
  for (let p = 0; p < maxPages && have < periods; p++) {
    const rows = await request('/fapi/v1/fundingRate', { symbol, limit: PAGE, endTime });
    const page = parseFunding(rows);
    if (!page.length) break;

    pages.push(page);
    have += page.length;
    onPage?.({ symbol, fetched: have, want: periods });

    const nextEnd = page[0].time - 1;
    if (nextEnd >= endTime) break;
    endTime = nextEnd;
    if (page.length < PAGE) break;     // history starts here
    await sleep(120);
  }

  return mergeByTime(pages).slice(-periods);
}

/** Perpetual klines, used for basis and for the up-move risk on the short leg. */
export async function fetchPerpKlines(symbol, interval, bars) {
  const out = [];
  let endTime = Date.now();
  const maxPages = Math.ceil(bars / PAGE) + 2;

  for (let p = 0; p < maxPages && out.length < bars; p++) {
    const rows = await request('/fapi/v1/klines', { symbol, interval, limit: PAGE, endTime });
    if (!Array.isArray(rows) || !rows.length) break;
    const page = rows.map((r) => ({
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
 * Perpetuals worth harvesting, ranked by turnover.
 *
 * The liquidity floor is the same honesty filter as on spot, and here it bites
 * twice: a thin perpetual pays the widest funding precisely because nobody will
 * take the other side, and the spread you cross to get delta-neutral eats the
 * yield that attracted you. Ranking by turnover keeps the flat cost assumption
 * defensible.
 */
export function selectPerpUniverse(rows, { limit = 40, minQuoteVolume = 50e6 } = {}) {
  if (!Array.isArray(rows)) throw new Error('Binance futures 24hr: expected an array');
  return rows
    .filter((r) => typeof r?.symbol === 'string' && r.symbol.endsWith('USDT'))
    .map((r) => ({ symbol: r.symbol, quoteVolume: Number(r.quoteVolume) }))
    .filter((r) => Number.isFinite(r.quoteVolume) && r.quoteVolume >= minQuoteVolume)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, limit);
}

/**
 * Perpetual symbols straight from the contract catalogue.
 *
 * Used as the fallback universe, and it is stricter than the ticker in one way
 * that matters: it states the contract type, so quarterly deliveries cannot
 * sneak in. They have funding of their own shape and a fixed expiry, and mixing
 * them into a perpetual harvest would measure two different instruments as one.
 */
export function parsePerpSymbols(info) {
  const symbols = info?.symbols;
  if (!Array.isArray(symbols)) throw new Error('Binance futures exchangeInfo: expected symbols[]');
  return symbols
    .filter((s) => s?.contractType === 'PERPETUAL' && s?.status === 'TRADING' && s?.quoteAsset === 'USDT')
    .map((s) => s.symbol);
}

/**
 * The universe, with a fallback that does not depend on one heavy endpoint.
 *
 * The first live run died on `/fapi/v1/ticker/24hr` answering 200 with an empty
 * body — a single request, with no volume data, no universe, and therefore no
 * measurement at all. Ranking by turnover is worth keeping (it is what makes the
 * flat cost assumption defensible), but it should not be the only way in. So:
 * the futures ticker first; failing that, the contract catalogue for WHICH
 * perpetuals exist, ranked by their SPOT turnover from `api.binance.com` — a
 * different host, and the one this project already fetches candles from every
 * hour. Spot turnover is not perp turnover, but as a liquidity ordering it is
 * close enough to choose twenty-five coins by, and the report says which route
 * produced the list.
 */
export async function fetchPerpUniverse(opts = {}) {
  try {
    const rows = await request('/fapi/v1/ticker/24hr', {});
    const uni = selectPerpUniverse(rows, opts);
    if (uni.length) return uni;
    throw new Error('Фьючерсный тикер вернул пустой список');
  } catch (err) {
    const info = await request('/fapi/v1/exchangeInfo', {});
    const perps = new Set(parsePerpSymbols(info));

    const spot = await import('./binance.js');
    const byVolume = await spot.fetchUniverse({
      limit: Math.max((opts.limit || 40) * 4, 100),
      minQuoteVolume: opts.minQuoteVolume ?? 50e6,
    });

    const uni = byVolume
      .filter((r) => perps.has(r.symbol))
      .slice(0, opts.limit || 40)
      .map((r) => ({ ...r, volumeFrom: 'spot' }));

    if (!uni.length) throw err;    // both routes failed: report the first cause
    console.log(`Фьючерсный тикер недоступен (${err.message}); вселенная собрана из ` +
      `каталога контрактов и оборота спота.`);
    return uni;
  }
}

export async function ping() {
  await request('/fapi/v1/ping', {});
  return true;
}

/* ------------------------------ offline mode -------------------------- */

const HOUR = 3600_000;

/**
 * Deterministic stand-in so the suite runs with no network.
 *
 * It is built to be boring on purpose: a small positive mean for most symbols,
 * a negative mean for one, fat-ish noise around it. It must never be mistaken
 * for evidence — the real numbers come from the exchange, and the report says
 * which source produced them.
 */
export function syntheticFunding(symbol, periods, { intervalMs = 8 * HOUR } = {}) {
  let h = 2166136261;
  for (const ch of symbol) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  let s = (h >>> 0) || 1;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };

  // One symbol in roughly five carries a negative mean, so the selection test
  // has something to select against.
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

/** Perp klines for the offline mode: reuse the spot generator. */
async function syntheticPerpKlines(symbol, interval, bars) {
  const synthetic = await import('./synthetic.js');
  return synthetic.fetchCandlesRange(symbol, interval, bars);
}

const offline = () => config.source === 'synthetic';

/* The two entry points everything else uses; they pick live or offline once. */

export async function getFunding(symbol, periods, opts = {}) {
  return offline() ? syntheticFunding(symbol, periods) : fetchFundingRange(symbol, periods, opts);
}

export async function getPerpKlines(symbol, interval, bars) {
  return offline() ? syntheticPerpKlines(symbol, interval, bars) : fetchPerpKlines(symbol, interval, bars);
}

export async function getPerpUniverse(opts = {}) {
  if (offline()) {
    return config.symbols.map((symbol, i) => ({ symbol, quoteVolume: 1e9 - i * 1e6 }));
  }
  return fetchPerpUniverse(opts);
}

export function sourceLabel() {
  return offline() ? 'synthetic (генератор, не рынок)' : `binance futures (${activeHost()})`;
}
