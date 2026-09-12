/**
 * Static run: the whole pipeline with no server and no database.
 *
 * GitHub Pages can only serve files, so the scanner runs in GitHub Actions on
 * a schedule and commits its results as JSON. This module is that run: it
 * loads the previous state, fetches candles, settles anything that reached its
 * stop or target, publishes new signals, and writes the files the site reads.
 *
 * It deliberately reuses the same strategy, resolution, backtest and
 * probability code as the server build. Only storage differs — a JSON file
 * instead of SQLite — so the numbers cannot drift apart between the two.
 *
 * Keeping the record in git has a useful side effect: every change to the
 * history is a commit, so it cannot be quietly rewritten after the fact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, timeframeMs } from './config.js';
import { getCandles, getPrices, referenceNow, checkSource, getUniverse } from './sources/index.js';
import { computeIndicators, htfTrendAt, scanLatest, PARAMS } from './strategy.js';
import { resolveOnBar, netR, backtestSymbol, summarize } from './backtest.js';
import { estimateProbability, scoreBucket } from './probability.js';
import { auditCandles, describeAudit } from './dataQuality.js';
import { segmentTrades, judgeConsistency } from './validate.js';
import { screenByToll } from './economics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.COINSCOPE_SITE_DATA || path.join(__dirname, '..', 'data');

const STATE_FILE = 'state.json';

/* ------------------------------- Storage ------------------------------ */
export function loadState(dir = DATA_DIR) {
  try {
    const raw = fs.readFileSync(path.join(dir, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
      nextId: parsed.nextId || 1,
      backtestTrades: Array.isArray(parsed.backtestTrades) ? parsed.backtestTrades : [],
    };
  } catch {
    return { signals: [], nextId: 1, backtestTrades: [] };
  }
}

export function writeJson(dir, name, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 1) + '\n');
}

/* ----------------------------- Probability ---------------------------- */
/**
 * Evidence collector over JSON state, mirroring the database one: backtest
 * trades plus already-resolved signals in the same score bucket.
 */
export function makeCollector(state) {
  return ({ timeframe, symbol, direction, bucket }) => {
    const match = (row, r) => (
      row.timeframe === timeframe &&
      row.score >= bucket.min && row.score <= bucket.max &&
      (!symbol || row.symbol === symbol) &&
      (!direction || row.direction === direction) &&
      Number.isFinite(r)
    );
    const out = [];
    for (const t of state.backtestTrades) if (match(t, t.r)) out.push({ r: t.r, source: 'backtest' });
    for (const s of state.signals) {
      if (s.status === 'open') continue;
      if (match(s, s.r)) out.push({ r: s.r ?? 0, source: 'live' });
    }
    return out;
  };
}

/* -------------------------------- Run --------------------------------- */
export async function runStatic({ dir = DATA_DIR, now = Date.now() } = {}) {
  const state = loadState(dir);
  const collect = makeCollector(state);
  const log = [];

  /*
   * The coins to scan. A wider universe is the only way to raise how often a
   * signal appears at all: the strategy fires on a confluence that is rare per
   * coin, so the rate scales with how many coins are watched, not with how
   * loose the thresholds are. Loosening thresholds instead would buy frequency
   * by lowering the bar, which is the opposite of what is wanted.
   *
   * The turnover floor stays: a coin thin enough to break the cost assumption
   * does not belong here however much it would add to the count.
   */
  let symbols = config.symbols;
  let universe = null;
  if (config.universe.size > 0) {
    try {
      universe = await getUniverse({
        limit: config.universe.size, minQuoteVolume: config.universe.minQuoteVolume,
      });
      if (universe.length) symbols = universe.map((u) => u.symbol);
    } catch (err) {
      // A universe we cannot fetch is not a reason to skip the scan entirely.
      log.push(`вселенная недоступна (${err.message}), работаю по списку из настроек`);
    }
  }

  /*
   * Symbols we must WATCH, as opposed to symbols we may ENTER.
   *
   * An open signal has to be carried to its stop or target whatever happens to
   * the universe afterwards — and three ways of losing it were live at once:
   * the top-40 by turnover churns between runs, the toll screen below removes
   * coins deliberately, and a failed universe fetch falls back to the eight
   * configured names. The settle loop iterated the narrowed list, so a signal
   * whose coin had left it was never visited again: no price, no level check,
   * no resolution, forever.
   *
   * That is not a cosmetic gap. A signal that never resolves never becomes a
   * win or a loss, so it silently leaves the track record — and it leaves for
   * reasons correlated with the coin's own behaviour, which biases what remains
   * rather than thinning it evenly. The project's promise is that every signal
   * is carried to an outcome without exceptions, and this is what keeps it.
   */
  const openSymbols = [...new Set(
    state.signals.filter((s) => s.status === 'open').map((s) => s.symbol),
  )];
  const trackSymbols = [...new Set([...symbols, ...openSymbols])];
  const orphans = openSymbols.filter((s) => !symbols.includes(s));
  if (orphans.length) {
    log.push(`веду вне вселенной (открытые сигналы): ${orphans.join(', ')}`);
  }

  const health = await checkSource();
  if (!health.ok) {
    // Write a status file so the site can say what is wrong instead of
    // silently showing yesterday's data as if it were current.
    writeJson(dir, 'status.json', {
      updatedAt: now, source: config.source, ok: false, error: health.error,
      timeframe: config.timeframe, symbols,
    });
    throw new Error(`источник недоступен: ${health.error}`);
  }

  const market = [];
  const quality = [];
  let created = 0;
  let resolved = 0;

  // Live prices settle anything that already hit its level between runs.
  let prices = {};
  try { prices = await getPrices(trackSymbols); } catch { /* candles still work */ }

  // Fetch once, use for everything below. Watched set, not the entry set.
  const data = {};
  for (const symbol of trackSymbols) {
    data[symbol] = {
      candles: await getCandles(symbol, config.timeframe, config.candleLimit, { fresh: true }),
      htf: await getCandles(symbol, config.higherTimeframe, config.candleLimit, { fresh: true }),
    };
  }

  /*
   * Disqualify by arithmetic before a single signal is considered. A coin
   * whose ATR-scaled stop is so tight that costs exceed half the risk cannot
   * be traded profitably by any strategy — a stablecoin that slipped past the
   * name-based filter produced −8.7R per trade before this existed.
   */
  const screen = screenByToll(data, { minBars: PARAMS.emaSlow + 5 });
  for (const d of screen.dropped) {
    log.push(`${d.symbol}: исключён — ${d.reason}` +
      (d.costR ? ` (ATR ${d.atrPct.toFixed(3)}%, пошлина ${d.costR.toFixed(2)}R)` : ''));
  }
  /*
   * The screen decides where to ENTER, never where to stop watching. A coin it
   * drops keeps its open signal tracked below — RLUSD is exactly the case:
   * the screen exists because of it, and its open signal was stranded by the
   * very filter added to keep new ones from being opened on it.
   */
  symbols = symbols.filter((s) => screen.kept[s]);

  /*
   * Backtest FIRST. A signal's success estimate is frozen when it is
   * published, so the evidence has to exist by then — running the backtest
   * afterwards left the very first batch of signals permanently marked
   * "нет оценки" even though the history to judge them was already there.
   */
  const btPerSymbol = [];
  const allTrades = [];
  for (const symbol of symbols) {
    const { candles, htf } = data[symbol];
    if (!candles.length) continue;
    const { trades, stats } = backtestSymbol({ symbol, timeframe: config.timeframe, candles, htfCandles: htf });
    btPerSymbol.push({ symbol, stats });
    allTrades.push(...trades);
  }
  state.backtestTrades = allTrades.map((t) => ({
    symbol: t.symbol, timeframe: t.timeframe, direction: t.direction,
    score: Math.round(t.score ?? 0), r: t.r, entryTime: t.entryTime,
  }));

  for (const symbol of trackSymbols) {
    const { candles, htf } = data[symbol] || {};
    if (!candles?.length) continue;
    /* Entry is gated by the screened universe; settling is not. */
    const mayEnter = symbols.includes(symbol);

    // 1. Settle open signals for this symbol.
    for (const sig of state.signals) {
      if (sig.status !== 'open' || sig.symbol !== symbol) continue;
      const after = candles.filter((c) => c.time > sig.barTime);
      for (let k = 0; k < after.length; k++) {
        const res = resolveOnBar(sig, after[k], k + 1);
        if (!res) continue;
        Object.assign(sig, {
          status: res.status, exit: res.exit, exitTime: res.exitTime,
          barsHeld: res.barsHeld, r: res.r,
        });
        resolved++;
        break;
      }
      // Between candle closes, the current price can already have hit a level.
      if (sig.status === 'open' && Number.isFinite(prices[symbol])) {
        const p = prices[symbol];
        const long = sig.direction === 'LONG';
        const hitStop = long ? p <= sig.stop : p >= sig.stop;
        const hitTarget = long ? p >= sig.target : p <= sig.target;
        if (hitStop || hitTarget) {
          const exit = hitStop ? sig.stop : sig.target;   // ties go to the stop
          Object.assign(sig, {
            status: hitStop ? 'loss' : 'win', exit, exitTime: now,
            r: netR({ direction: sig.direction, entry: sig.entry, stop: sig.stop, exit }),
          });
          resolved++;
        }
      }
    }

    /*
     * Everything below is entry-side: the quality gate, the overview row and the
     * signal itself. An orphan is watched, not scanned — it should not reappear
     * in the market table as if it were part of the universe.
     */
    if (!mayEnter) continue;

    // 2. Data integrity gate before publishing anything new.
    const audit = auditCandles(candles, config.timeframe, {
      minBars: PARAMS.emaSlow + 5, now: referenceNow(config.timeframe),
    });
    const htfAudit = auditCandles(htf, config.higherTimeframe, { now: referenceNow(config.higherTimeframe) });
    quality.push({ symbol, ok: audit.ok && htfAudit.ok, detail: describeAudit(audit.ok ? htfAudit : audit),
      bars: audit.bars, missingBars: audit.missingBars, staleBars: audit.staleBars });

    // 3. Market snapshot for the overview table.
    const ind = computeIndicators(candles);
    const htfInd = computeIndicators(htf);
    const i = candles.length - 1;
    const last = candles[i];
    const back = candles[Math.max(0, i - 24)];
    const { trend } = htfTrendAt(htf, htfInd, last.time + timeframeMs(config.timeframe));
    market.push({
      symbol, price: last.close,
      change24: back ? ((last.close - back.close) / back.close) * 100 : null,
      rsi: ind.rsi[i], adx: ind.adx[i], relVol: ind.relVol[i],
      aboveEma200: ind.ema200[i] != null ? last.close > ind.ema200[i] : null,
      htfTrend: trend, updatedAt: last.time,
    });

    if (!audit.ok || !htfAudit.ok) { log.push(`${symbol}: пропущен — ${describeAudit(audit.ok ? htfAudit : audit)}`); continue; }

    // 4. One open idea per symbol.
    if (state.signals.some((s) => s.status === 'open' && s.symbol === symbol)) continue;

    const sig = scanLatest(candles, htf, { symbol, timeframe: config.timeframe });
    if (!sig) continue;
    // Never publish twice for the same candle.
    if (state.signals.some((s) => s.symbol === symbol && s.barTime === sig.barTime)) continue;

    const p = estimateProbability({
      symbol, direction: sig.direction, score: sig.score, timeframe: config.timeframe, collect,
    });
    state.signals.push({
      id: state.nextId++,
      symbol: sig.symbol, timeframe: sig.timeframe, direction: sig.direction,
      entry: sig.entry, stop: sig.stop, target: sig.target, atr: sig.atr,
      score: sig.score, reasons: sig.reasons, context: sig.context,
      barTime: sig.barTime, expiryBars: sig.expiryBars,
      status: 'open', createdAt: now,
      winProb: p.probability, probLow: p.low, probHigh: p.high,
      probSample: p.sample, probBasis: p.basis, expectedR: p.expectedR,
    });
    created++;
    log.push(`${symbol}: новый сигнал ${sig.direction}, score ${sig.score}`);
  }

  /* ------------------------------- Stats ------------------------------ */
  const closed = state.signals.filter((s) => s.status !== 'open');
  const liveStats = summarize(closed.map((s) => ({ r: s.r ?? 0, barsHeld: s.barsHeld ?? 0 })));
  const timeline = segmentTrades(allTrades, 4);

  /* ------------------------------- Output ----------------------------- */
  writeJson(dir, STATE_FILE, state);
  writeJson(dir, 'signals.json', {
    updatedAt: now,
    open: state.signals.filter((s) => s.status === 'open'),
    closed: closed.sort((a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0)).slice(0, 300),
  });
  writeJson(dir, 'market.json', { updatedAt: now, timeframe: config.timeframe, market });
  writeJson(dir, 'stats.json', {
    updatedAt: now,
    live: liveStats,
    backtest: { perSymbol: btPerSymbol, portfolio: summarize(allTrades) },
    timeline,
    consistency: judgeConsistency(timeline),
    minSample: config.minSampleForStats,
  });
  writeJson(dir, 'status.json', {
    updatedAt: now, source: config.source, ok: true,
    timeframe: config.timeframe, higherTimeframe: config.higherTimeframe,
    symbols,
    /*
     * What the page must request prices for: the universe plus any coin still
     * carrying an open signal. Using `symbols` alone left three open cards with
     * no quote for hours — the browser simply never asked for those coins.
     */
    tracked: trackSymbols,
    strategy: config.strategy,
    screened: screen.dropped,
    universe: universe && { size: universe.length, minQuoteVolume: config.universe.minQuoteVolume },
    minSampleForStats: config.minSampleForStats,
    dataQuality: quality,
    counts: { open: state.signals.filter((s) => s.status === 'open').length, closed: closed.length },
  });

  return { created, resolved, log, market, quality };
}
