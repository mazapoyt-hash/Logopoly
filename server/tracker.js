/**
 * Live scanning loop.
 *
 * Each cycle, per symbol:
 *   1. resolve any open signal against candles that closed after its entry bar
 *   2. if flat, look for a new signal on the newest closed candle
 *
 * Resolution reuses the backtest's rules (`resolveOnBar`), so the live track
 * record and the historical one are measured the same way.
 */
import { EventEmitter } from 'node:events';
import { config, timeframeMs } from './config.js';
import { getCandles, getPrices, referenceNow } from './sources/index.js';
import { scanLatest, PARAMS } from './strategy.js';
import { resolveOnBar, backtestSymbol, summarize, netR } from './backtest.js';
import { Signals, Backtests, BacktestTrades } from './db.js';
import { estimateProbability } from './probability.js';
import { auditCandles, describeAudit } from './dataQuality.js';

export const events = new EventEmitter();

let running = false;
let timer = null;
let priceTimer = null;

/** Latest exchange price per symbol, refreshed by the price loop. */
export const prices = { at: null, values: {} };

/** Latest data-integrity report per symbol, surfaced on /api/status. */
export const dataQuality = {};

export const status = {
  lastScanAt: null,
  lastScanMs: null,
  lastPriceAt: null,
  scanned: 0,
  errors: [],
  skipped: [],
  priceError: null,
  source: config.source,
};

/** Resolve one open signal against the bars that followed it. */
export function resolveSignal(signal, candles) {
  const after = candles.filter((c) => c.time > signal.bar_time);
  const trade = {
    direction: signal.direction,
    entry: signal.entry,
    stop: signal.stop,
    target: signal.target,
    expiryBars: signal.expiry_bars,
  };
  for (let k = 0; k < after.length; k++) {
    const res = resolveOnBar(trade, after[k], k + 1);
    if (res) {
      const updated = Signals.resolve(signal.id, {
        status: res.status,
        exitPrice: res.exit,
        exitTime: res.exitTime,
        barsHeld: res.barsHeld,
        r: res.r,
      });
      if (updated) events.emit('signal:resolved', updated);
      return updated;
    }
  }
  return null;
}

async function scanSymbol(symbol) {
  const candles = await getCandles(symbol, config.timeframe, config.candleLimit, { fresh: true });
  const htf = await getCandles(symbol, config.higherTimeframe, config.candleLimit, { fresh: true });
  if (!candles.length) return;

  // 1. Close out anything already running. Resolution is allowed even on a
  //    flawed series — an open position must not be left hanging because the
  //    feed hiccuped.
  for (const sig of Signals.open(symbol)) {
    resolveSignal(sig, candles);
  }

  // 2. Refuse to open anything new on questionable data. A gap or a stale feed
  //    shifts every indicator, and the resulting signal looks entirely normal.
  const audit = auditCandles(candles, config.timeframe, {
    minBars: PARAMS.emaSlow + 5, now: referenceNow(config.timeframe),
  });
  const htfAudit = auditCandles(htf, config.higherTimeframe, {
    now: referenceNow(config.higherTimeframe),
  });
  dataQuality[symbol] = { ...audit, htfOk: htfAudit.ok, checkedAt: Date.now() };
  if (!audit.ok || !htfAudit.ok) {
    status.skipped.push({ symbol, reason: describeAudit(audit.ok ? htfAudit : audit) });
    return;
  }

  // 3. One idea per symbol at a time.
  if (Signals.hasOpen(symbol, config.timeframe)) return;

  const sig = scanLatest(candles, htf, { symbol, timeframe: config.timeframe });
  if (!sig) return;

  // Attach the success estimate as it stands right now, and store it with the
  // signal so the history shows what was actually claimed at publication.
  sig.probability = estimateProbability({
    symbol, direction: sig.direction, score: sig.score, timeframe: config.timeframe,
  });

  const saved = Signals.add(sig);
  if (saved) events.emit('signal:new', saved);
}

/**
 * Check open signals against the current exchange price.
 *
 * The backtest assumes a stop or target that trades intrabar is filled, so the
 * live side must do the same — waiting for the candle to close would make the
 * forward record look better than the historical one.
 */
export function resolveAgainstPrice(signal, price) {
  const long = signal.direction === 'LONG';
  const hitStop = long ? price <= signal.stop : price >= signal.stop;
  const hitTarget = long ? price >= signal.target : price <= signal.target;

  let exit = null;
  let outcome = null;
  if (hitStop) { exit = signal.stop; outcome = 'loss'; }   // stop wins ties, as in the backtest
  else if (hitTarget) { exit = signal.target; outcome = 'win'; }
  if (exit === null) return null;

  const r = netR({ direction: signal.direction, entry: signal.entry, stop: signal.stop, exit });
  const updated = Signals.resolve(signal.id, {
    status: outcome,
    exitPrice: exit,
    exitTime: Date.now(),
    barsHeld: signal.bars_held ?? null,
    r,
  });
  if (updated) events.emit('signal:resolved', updated);
  return updated;
}

/** Poll current prices and settle anything that has hit its level. */
export async function priceTick() {
  try {
    const values = await getPrices(config.symbols);
    prices.values = values;
    prices.at = Date.now();
    status.lastPriceAt = prices.at;
    status.priceError = null;

    for (const sig of Signals.open()) {
      const price = values[sig.symbol];
      if (Number.isFinite(price)) resolveAgainstPrice(sig, price);
    }
    events.emit('prices', { at: prices.at, values });
  } catch (err) {
    status.priceError = err.message;
    events.emit('prices:error', { error: err.message });
  }
  return prices;
}

export async function scanOnce() {
  const started = Date.now();
  const errors = [];
  status.skipped = [];
  for (const symbol of config.symbols) {
    try {
      await scanSymbol(symbol);
    } catch (err) {
      errors.push({ symbol, error: err.message });
    }
  }
  status.lastScanAt = Date.now();
  status.lastScanMs = Date.now() - started;
  status.scanned = config.symbols.length;
  status.errors = errors;
  events.emit('scan:done', { ...status });
  return status;
}

export function start() {
  if (running) return;
  running = true;

  const scanLoop = async () => {
    try { await scanOnce(); } catch (err) { status.errors = [{ error: err.message }]; }
    if (running) timer = setTimeout(scanLoop, config.scanIntervalSec * 1000);
  };
  // Prices move continuously; candles only close occasionally. Two cadences.
  const priceLoop = async () => {
    await priceTick();
    if (running) priceTimer = setTimeout(priceLoop, config.priceIntervalSec * 1000);
  };

  scanLoop();
  priceLoop();
}

export function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  if (priceTimer) clearTimeout(priceTimer);
  timer = null;
  priceTimer = null;
}

/** Run the historical verification for every configured symbol and store it. */
export async function runBacktests() {
  const results = [];
  for (const symbol of config.symbols) {
    try {
      const candles = await getCandles(symbol, config.timeframe, config.candleLimit);
      const htf = await getCandles(symbol, config.higherTimeframe, config.candleLimit);
      const { trades, stats } = backtestSymbol({
        symbol, timeframe: config.timeframe, candles, htfCandles: htf,
      });
      Backtests.save({
        symbol, timeframe: config.timeframe, source: config.source, stats, bars: candles.length,
      });
      // Individual trades feed the success estimate on future signals.
      BacktestTrades.replaceFor({
        symbol, timeframe: config.timeframe, source: config.source, trades,
      });
      results.push({ symbol, stats, trades });
    } catch (err) {
      results.push({ symbol, error: err.message });
    }
  }
  const all = results.flatMap((r) => r.trades || []);
  return { perSymbol: results.map(({ trades, ...rest }) => rest), portfolio: summarize(all) };
}

/** Live (forward) performance of published signals. */
export function liveRecord(symbol = null) {
  const resolved = Signals.record({ symbol });
  const trades = resolved.map((s) => ({
    r: s.r ?? 0,
    barsHeld: s.bars_held ?? 0,
    outcome: s.status,
  }));
  return summarize(trades);
}

export { timeframeMs };
