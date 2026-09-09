/**
 * Replay: walk past candles through the live signal logic to seed a history.
 *
 *   npm run replay
 *
 * Why this exists: on a fresh install the history is empty for days, because a
 * signal takes hours to reach its stop or target. Replay produces the signals
 * the strategy WOULD have published over the available history, resolved by
 * the same rules.
 *
 * These are marked `origin = 'replay'` and are deliberately excluded from the
 * live track record — they were never published in real time, and counting
 * them as live performance would be a lie. They are shown in the history with
 * a badge, and they do count as evidence for probability estimates, exactly
 * like backtest trades.
 */
import { config, timeframeMs } from './config.js';
import { getCandles } from './sources/index.js';
import { computeIndicators, evaluateBar, htfTrendAt, PARAMS } from './strategy.js';
import { resolveOnBar } from './backtest.js';
import { estimateProbability } from './probability.js';
import { Signals } from './db.js';

export async function replaySymbol(symbol, { timeframe = config.timeframe } = {}) {
  const tfMs = timeframeMs(timeframe);
  const candles = await getCandles(symbol, timeframe, config.candleLimit, { fresh: true });
  const htf = await getCandles(symbol, config.higherTimeframe, config.candleLimit, { fresh: true });
  if (candles.length < PARAMS.emaSlow + 10) return { symbol, created: 0, resolved: 0, skipped: 'мало истории' };

  const ind = computeIndicators(candles);
  const htfInd = computeIndicators(htf);

  let created = 0;
  let resolved = 0;
  let open = null;

  for (let i = PARAMS.emaSlow + 5; i < candles.length; i++) {
    const bar = candles[i];

    // Settle what is running before considering anything new — same order as
    // the live scanner.
    if (open) {
      const res = resolveOnBar(open, bar, i - open.entryIndex);
      if (res) {
        Signals.resolve(open.id, {
          status: res.status,
          exitPrice: res.exit,
          exitTime: res.exitTime,
          barsHeld: res.barsHeld,
          r: res.r,
        });
        resolved++;
        open = null;
      }
    }
    if (open) continue;

    const closeMs = bar.time + tfMs;
    const { trend } = htfTrendAt(htf, htfInd, closeMs);
    const sig = evaluateBar(ind, i, trend, { symbol, timeframe, barTime: bar.time });
    if (!sig) continue;

    sig.probability = estimateProbability({
      symbol, direction: sig.direction, score: sig.score, timeframe,
    });
    sig.origin = 'replay';
    // Timestamp it as of the candle, not as of now — the history is a record
    // of when the setup appeared.
    sig.createdAt = closeMs;

    const saved = Signals.add(sig);
    if (!saved) continue;
    created++;
    open = {
      id: saved.id,
      direction: saved.direction,
      entry: saved.entry,
      stop: saved.stop,
      target: saved.target,
      expiryBars: saved.expiry_bars,
      entryIndex: i,
    };
  }

  return { symbol, created, resolved, stillOpen: open ? 1 : 0 };
}

export async function replayAll() {
  const results = [];
  for (const symbol of config.symbols) {
    try {
      results.push(await replaySymbol(symbol));
    } catch (err) {
      results.push({ symbol, error: err.message });
    }
  }
  return results;
}
