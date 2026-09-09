/**
 * Candle integrity checks.
 *
 * Bad data is the quietest way for a signal service to be wrong: a missing
 * candle shifts every indicator, a duplicated timestamp double-counts a bar,
 * and a stale feed makes the scanner confidently trade a price that no longer
 * exists. None of that raises an error on its own — it just produces
 * plausible, wrong signals.
 *
 * So every series is audited before it is allowed to produce a signal, and a
 * series that fails is skipped rather than traded.
 */
import { timeframeMs } from './config.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const LIMITS = {
  /** Missing candles tolerated, as a share of the series. */
  maxGapRatio: Number(process.env.COINSCOPE_MAX_GAP_RATIO ?? 0.01),
  /** How many timeframes the newest closed candle may lag before it is stale. */
  maxStaleBars: Number(process.env.COINSCOPE_MAX_STALE_BARS ?? 3),
};

/**
 * Audit a candle series. Returns a report; `ok === false` means do not trade
 * on it.
 */
export function auditCandles(candles, timeframe, { now = Date.now(), minBars = 0 } = {}) {
  const step = timeframeMs(timeframe);
  const issues = [];
  const report = {
    ok: false, bars: candles?.length || 0,
    gaps: 0, missingBars: 0, duplicates: 0, outOfOrder: 0, malformed: 0,
    staleBars: 0, lastCloseAgeMs: null, issues,
  };

  if (!Array.isArray(candles) || candles.length === 0) {
    issues.push('нет свечей');
    return report;
  }
  if (minBars && candles.length < minBars) {
    issues.push(`мало истории: ${candles.length} свечей, нужно ${minBars}`);
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // Shape and internal consistency of a single candle.
    const nums = [c.time, c.open, c.high, c.low, c.close, c.volume];
    if (!nums.every(isNum) || c.open <= 0 || c.close <= 0 || c.high <= 0 || c.low <= 0 ||
        c.high < c.low || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) ||
        c.volume < 0) {
      report.malformed++;
      continue;
    }

    if (i === 0) continue;
    const prev = candles[i - 1];
    if (!isNum(prev.time)) continue;

    const delta = c.time - prev.time;
    if (delta === 0) { report.duplicates++; continue; }
    if (delta < 0) { report.outOfOrder++; continue; }
    if (delta > step) {
      // A hole in the series: (delta/step - 1) candles never arrived.
      report.gaps++;
      report.missingBars += Math.round(delta / step) - 1;
    } else if (delta < step) {
      // Spacing narrower than the timeframe means the series is not what we asked for.
      report.outOfOrder++;
    }
  }

  const last = candles[candles.length - 1];
  if (isNum(last?.time)) {
    const closedAt = last.time + step;
    report.lastCloseAgeMs = Math.max(0, now - closedAt);
    report.staleBars = report.lastCloseAgeMs / step;
  }

  if (report.malformed) issues.push(`некорректных свечей: ${report.malformed}`);
  if (report.duplicates) issues.push(`дублей по времени: ${report.duplicates}`);
  if (report.outOfOrder) issues.push(`нарушений порядка: ${report.outOfOrder}`);

  const gapRatio = report.missingBars / candles.length;
  if (report.missingBars) {
    const msg = `пропущено свечей: ${report.missingBars} (${(gapRatio * 100).toFixed(2)}%)`;
    if (gapRatio > LIMITS.maxGapRatio) issues.push(msg);
    else report.note = msg; // within tolerance: recorded, not blocking
  }
  if (report.staleBars > LIMITS.maxStaleBars) {
    issues.push(`данные устарели на ${report.staleBars.toFixed(1)} свечей`);
  }

  report.ok = issues.length === 0;
  return report;
}

/** One-line summary for logs and the status endpoint. */
export function describeAudit(report) {
  if (!report) return 'нет данных';
  if (report.ok) return report.note ? `в порядке (${report.note})` : 'в порядке';
  return report.issues.join('; ');
}
