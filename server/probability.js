/**
 * Success probability for a signal.
 *
 * This is NOT a model output or a confidence feeling — it is the measured hit
 * rate of comparable signals: same timeframe, same confluence-score bucket,
 * preferring the same coin and direction when there is enough of that history.
 * Evidence comes from both halves of the record:
 *   - backtest trades (large sample, historical)
 *   - resolved live signals (small sample, but forward-tested)
 *
 * When there are too few comparable outcomes it returns `available: false`
 * instead of a number. A probability printed from six samples is decoration,
 * and dressing it up as insight is how signal services mislead people.
 */
import { config } from './config.js';
import { BacktestTrades, Signals } from './db.js';

/** Score buckets: 60-69, 70-79, 80-100 (top bucket merged — signals are rare there). */
export function scoreBucket(score) {
  if (score >= 80) return { min: 80, max: 100, label: '80+' };
  const min = Math.floor(score / 10) * 10;
  return { min, max: min + 9, label: `${min}–${min + 9}` };
}

/**
 * Wilson score interval — honest error bars for a proportion, and unlike the
 * naive formula it stays sane at small n and at rates near 0 or 1.
 */
export function wilsonInterval(wins, n, z = 1.96) {
  if (!n) return { low: null, high: null };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
  };
}

/**
 * Default evidence source: the SQLite store. The static (GitHub Pages) build
 * has no database, so it passes its own collector over JSON state — the
 * estimation logic below stays exactly the same either way.
 */
function collectFromDb({ timeframe, symbol, direction, bucket }) {
  const bt = BacktestTrades.find({
    timeframe, symbol, direction, scoreMin: bucket.min, scoreMax: bucket.max,
  }).map((t) => ({ r: t.r, source: 'backtest' }));

  const live = Signals.resolvedFor({
    timeframe, symbol, direction, scoreMin: bucket.min, scoreMax: bucket.max,
  }).map((s) => ({ r: s.r ?? 0, source: 'live' }));

  return [...bt, ...live];
}

function summarise(samples) {
  const n = samples.length;
  const wins = samples.filter((s) => s.r > 0).length;
  const totalR = samples.reduce((acc, s) => acc + s.r, 0);
  const { low, high } = wilsonInterval(wins, n);
  return {
    probability: n ? wins / n : null,
    low, high,
    sample: n,
    wins,
    liveSample: samples.filter((s) => s.source === 'live').length,
    expectedR: n ? totalR / n : null,
  };
}

/**
 * Estimate the chance this signal reaches its target before its stop.
 * Widens the comparison set step by step until it has enough evidence.
 */
export function estimateProbability({ symbol, direction, score, timeframe = config.timeframe, collect = collectFromDb }) {
  const bucket = scoreBucket(score);
  const min = config.minSampleForProbability;

  const tiers = [
    { basis: 'symbol+direction', label: `${symbol}, ${direction === 'LONG' ? 'лонг' : 'шорт'}, score ${bucket.label}`,
      query: { timeframe, symbol, direction, bucket } },
    { basis: 'symbol', label: `${symbol}, score ${bucket.label}`,
      query: { timeframe, symbol, direction: null, bucket } },
    { basis: 'direction', label: `все монеты, ${direction === 'LONG' ? 'лонг' : 'шорт'}, score ${bucket.label}`,
      query: { timeframe, symbol: null, direction, bucket } },
    { basis: 'score', label: `все монеты, score ${bucket.label}`,
      query: { timeframe, symbol: null, direction: null, bucket } },
    { basis: 'all', label: 'все сигналы всех уровней',
      query: { timeframe, symbol: null, direction: null, bucket: { min: 0, max: 100, label: 'все' } } },
  ];

  let widest = null;
  for (const tier of tiers) {
    const stats = summarise(collect(tier.query));
    if (!widest || stats.sample > widest.stats.sample) widest = { tier, stats };
    if (stats.sample >= min) {
      return { available: true, basis: tier.basis, basisLabel: tier.label, bucket: bucket.label, ...stats };
    }
  }

  // Nothing met the bar — report the shortfall rather than a number.
  return {
    available: false,
    basis: widest?.tier.basis ?? null,
    basisLabel: widest?.tier.label ?? null,
    bucket: bucket.label,
    probability: null,
    low: null, high: null,
    sample: widest?.stats.sample ?? 0,
    wins: widest?.stats.wins ?? 0,
    liveSample: widest?.stats.liveSample ?? 0,
    expectedR: null,
    required: min,
  };
}
