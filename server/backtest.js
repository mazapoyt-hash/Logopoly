/**
 * Historical verification of the strategy.
 *
 * Design rules, because they are what separate an honest backtest from a
 * flattering one:
 *
 *  1. No lookahead. A signal on bar i is decided from bars <= i and can only
 *     be resolved by bars > i.
 *  2. Entry on the signal bar's close — the first price actually reachable
 *     once that bar has closed.
 *  3. If a bar's range covers both the stop and the target, the STOP is
 *     assumed to have hit first. Without tick data you cannot know the order,
 *     and assuming the winner is how backtests lie.
 *  4. Fees and slippage are charged on both sides. A strategy with a 2:1
 *     reward:risk looks very different once round-trip costs are real.
 *  5. One open position per symbol — no pyramiding into a single idea.
 */
import { computeIndicators, evaluateBar, htfTrendAt, PARAMS } from './strategy.js';
import { config, timeframeMs } from './config.js';

export const COSTS = {
  /** Taker fee per side, as a fraction (0.0005 = 0.05%, Binance spot taker). */
  feeRate: Number(process.env.COINSCOPE_FEE ?? 0.0005),
  /** Assumed slippage per side. */
  slippageRate: Number(process.env.COINSCOPE_SLIPPAGE ?? 0.0005),
};

/** Net R multiple of a completed trade, after costs. */
export function netR({ direction, entry, stop, exit }) {
  const riskFraction = Math.abs(entry - stop) / entry;
  if (!(riskFraction > 0)) return 0;

  const { feeRate, slippageRate } = COSTS;
  // Slippage always works against you: worse entry, worse exit.
  const entryEff = direction === 'LONG' ? entry * (1 + slippageRate) : entry * (1 - slippageRate);
  const exitEff = direction === 'LONG' ? exit * (1 - slippageRate) : exit * (1 + slippageRate);

  const gross = direction === 'LONG'
    ? (exitEff - entryEff) / entryEff
    : (entryEff - exitEff) / entryEff;

  const pnlFraction = gross - feeRate * 2;
  return pnlFraction / riskFraction;
}

/**
 * Decide whether `bar` closes the trade. Shared by the backtest and the live
 * tracker so historical and forward statistics are produced by identical
 * rules — otherwise the two numbers on the site would not be comparable.
 *
 * `barsSinceEntry` counts bars strictly after the entry bar.
 * Returns null when the trade stays open.
 */
export function resolveOnBar(trade, bar, barsSinceEntry) {
  const long = trade.direction === 'LONG';
  const hitStop = long ? bar.low <= trade.stop : bar.high >= trade.stop;
  const hitTarget = long ? bar.high >= trade.target : bar.low <= trade.target;

  let exit = null;
  let resolved = null;
  if (hitStop) { exit = trade.stop; resolved = 'loss'; }          // ties go to the stop
  else if (hitTarget) { exit = trade.target; resolved = 'win'; }
  else if (barsSinceEntry >= trade.expiryBars) { exit = bar.close; resolved = 'expired'; }
  if (exit === null) return null;

  const r = netR({ direction: trade.direction, entry: trade.entry, stop: trade.stop, exit });
  return {
    exit,
    exitTime: bar.time,
    barsHeld: barsSinceEntry,
    resolved,
    status: resolved,
    outcome: resolved === 'expired' ? (r > 0 ? 'expired_win' : 'expired_loss') : resolved,
    r,
  };
}

/**
 * Walk one symbol's history and collect trades.
 * Returns { trades, stats }.
 */
export function backtestSymbol({ symbol, timeframe, candles, htfCandles, params = null }) {
  const tfMs = timeframeMs(timeframe);
  const ind = computeIndicators(candles);
  const htfInd = computeIndicators(htfCandles);
  const trades = [];

  const warmup = PARAMS.emaSlow + 5;
  let open = null; // the single in-flight trade

  for (let i = warmup; i < candles.length; i++) {
    const bar = candles[i];

    // --- Resolve an open trade using THIS bar (which is strictly after entry)
    if (open) {
      const res = resolveOnBar(open, bar, i - open.entryIndex);
      if (res) {
        trades.push({ ...open, ...res });
        open = null;
      }
    }

    // --- Look for a new entry only when flat
    if (!open) {
      const closeMs = bar.time + tfMs;
      const { trend } = htfTrendAt(htfCandles, htfInd, closeMs);
      const sig = evaluateBar(ind, i, trend, { symbol, timeframe, barTime: bar.time }, params);
      if (sig) {
        open = {
          symbol, timeframe,
          direction: sig.direction,
          entry: sig.entry,
          stop: sig.stop,
          target: sig.target,
          score: sig.score,
          entryTime: bar.time,
          entryIndex: i,
          expiryBars: sig.expiryBars,
        };
      }
    }
  }

  return { trades, stats: summarize(trades) };
}

/** Aggregate trade statistics. All returns are in R (risk multiples). */
export function summarize(trades) {
  const n = trades.length;
  if (!n) {
    return {
      trades: 0, wins: 0, losses: 0, winRate: null, avgR: null,
      expectancy: null, profitFactor: null, totalR: 0, maxDrawdownR: 0,
      grossWinR: 0, grossLossR: 0,
      bestR: null, worstR: null, avgBarsHeld: null, reliable: false,
    };
  }

  const wins = trades.filter((t) => t.r > 0);
  const losses = trades.filter((t) => t.r <= 0);
  const totalR = trades.reduce((s, t) => s + t.r, 0);
  const grossWin = wins.reduce((s, t) => s + t.r, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.r, 0));

  // Max drawdown of the cumulative R curve.
  let peak = 0;
  let equity = 0;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.r;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / n,
    avgR: totalR / n,
    expectancy: totalR / n, // same thing in R terms; named for readability
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : null) : grossWin / grossLoss,
    totalR,
    maxDrawdownR: maxDD,
    // Kept so several symbols can be aggregated into one honest profit factor;
    // it cannot be recovered from per-symbol ratios alone.
    grossWinR: grossWin,
    grossLossR: grossLoss,
    bestR: Math.max(...trades.map((t) => t.r)),
    worstR: Math.min(...trades.map((t) => t.r)),
    avgBarsHeld: trades.reduce((s, t) => s + t.barsHeld, 0) / n,
    /** Below this many trades the numbers are noise, not evidence. */
    reliable: n >= config.minSampleForStats,
  };
}

/** Merge per-symbol results into one portfolio-level view. */
export function combine(results) {
  const all = results.flatMap((r) => r.trades);
  all.sort((a, b) => a.entryTime - b.entryTime);
  return { trades: all, stats: summarize(all) };
}
