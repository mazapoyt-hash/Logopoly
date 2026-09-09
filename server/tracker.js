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
import { getCandles } from './sources/index.js';
import { scanLatest } from './strategy.js';
import { resolveOnBar, backtestSymbol, summarize } from './backtest.js';
import { Signals, Backtests } from './db.js';

export const events = new EventEmitter();

let running = false;
let timer = null;
export const status = {
  lastScanAt: null,
  lastScanMs: null,
  scanned: 0,
  errors: [],
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

  // 1. Close out anything already running.
  for (const sig of Signals.open(symbol)) {
    resolveSignal(sig, candles);
  }

  // 2. One idea per symbol at a time.
  if (Signals.hasOpen(symbol, config.timeframe)) return;

  const sig = scanLatest(candles, htf, { symbol, timeframe: config.timeframe });
  if (!sig) return;

  const saved = Signals.add(sig);
  if (saved) events.emit('signal:new', saved);
}

export async function scanOnce() {
  const started = Date.now();
  const errors = [];
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
  const loop = async () => {
    try { await scanOnce(); } catch (err) { status.errors = [{ error: err.message }]; }
    if (running) timer = setTimeout(loop, config.scanIntervalSec * 1000);
  };
  loop();
}

export function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
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
