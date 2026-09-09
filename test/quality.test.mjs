/**
 * Data-integrity checks and strategy validation — the two things standing
 * between "a number" and "a number you can rely on".
 */
import { auditCandles, describeAudit, LIMITS } from '../server/dataQuality.js';
import { segmentTrades, judgeConsistency, judgeRobustness } from '../server/validate.js';
import { makeChecker, close } from './helpers.mjs';

const results = [];
const check = makeChecker(results);

const HOUR = 3600_000;
const START = 1_700_000_000_000;

/** A clean, contiguous hourly series. */
function series(n, { start = START, step = HOUR } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    time: start + i * step,
    open: 100, high: 101, low: 99, close: 100.5, volume: 10,
  }));
}
const NOW = START + 100 * HOUR; // just after a 100-bar series closes

/* ------------------------------ clean data --------------------------- */
const clean = auditCandles(series(100), '1h', { now: NOW });
check('a clean series passes', clean.ok === true);
check('a clean series reports no defects',
  clean.gaps === 0 && clean.duplicates === 0 && clean.malformed === 0 && clean.outOfOrder === 0);
check('describeAudit summarises a clean series', describeAudit(clean) === 'в порядке');

/* -------------------------------- gaps ------------------------------- */
const gapped = series(100);
gapped.splice(50, 5); // five candles never arrived
const gapReport = auditCandles(gapped, '1h', { now: NOW });
check('a gap is detected', gapReport.gaps === 1 && gapReport.missingBars === 5);
check('a gap beyond tolerance blocks trading', gapReport.ok === false);
check('the gap is described in words', /пропущено свечей/.test(describeAudit(gapReport)));

// One missing bar in 100 sits on the tolerance line and is recorded, not fatal.
const tiny = series(200);
tiny.splice(100, 1);
const tinyReport = auditCandles(tiny, '1h', { now: START + 200 * HOUR });
check('a single gap within tolerance does not block trading',
  LIMITS.maxGapRatio >= 1 / 200 ? tinyReport.ok === true : true);
check('a tolerated gap is still recorded', tinyReport.missingBars === 1);

/* ----------------------------- duplicates ---------------------------- */
const dupes = series(50);
dupes.splice(20, 0, { ...dupes[20] });
check('duplicate timestamps are caught', auditCandles(dupes, '1h', { now: NOW }).duplicates === 1);
check('duplicates block trading', auditCandles(dupes, '1h', { now: NOW }).ok === false);

/* ---------------------------- out of order --------------------------- */
const shuffled = series(50);
[shuffled[10], shuffled[11]] = [shuffled[11], shuffled[10]];
check('out-of-order candles are caught', auditCandles(shuffled, '1h', { now: NOW }).outOfOrder > 0);

/* ------------------------------ malformed ---------------------------- */
const broken = series(50);
broken[30] = { ...broken[30], high: 90 }; // high below the low
check('an impossible candle is caught', auditCandles(broken, '1h', { now: NOW }).malformed === 1);

const nan = series(50);
nan[10] = { ...nan[10], close: Number.NaN };
check('a non-numeric price is caught', auditCandles(nan, '1h', { now: NOW }).malformed === 1);

const negative = series(50);
negative[5] = { ...negative[5], low: -1, open: 100, close: 100, high: 101 };
check('a negative price is caught', auditCandles(negative, '1h', { now: NOW }).malformed === 1);

/* ------------------------------- stale ------------------------------- */
const staleNow = START + 100 * HOUR + 10 * HOUR; // ten hours after the last close
const stale = auditCandles(series(100), '1h', { now: staleNow });
check('a stale feed is detected', stale.ok === false && stale.staleBars > LIMITS.maxStaleBars);
check('staleness is described in words', /устарели/.test(describeAudit(stale)));
check('a feed one bar behind is still acceptable',
  auditCandles(series(100), '1h', { now: START + 101 * HOUR }).ok === true);

/* ------------------------------- empty ------------------------------- */
check('an empty series never passes', auditCandles([], '1h', { now: NOW }).ok === false);
check('too little history is reported',
  /мало истории/.test(describeAudit(auditCandles(series(10), '1h', { now: START + 10 * HOUR, minBars: 205 }))));

/* --------------------- validation: time segments --------------------- */
const mkTrade = (t, r) => ({ entryTime: t, r, barsHeld: 1 });
const spread = [
  mkTrade(START + 1 * HOUR, 1), mkTrade(START + 2 * HOUR, -1),
  mkTrade(START + 40 * HOUR, 2), mkTrade(START + 45 * HOUR, 1),
  mkTrade(START + 80 * HOUR, -1), mkTrade(START + 85 * HOUR, 2),
  mkTrade(START + 120 * HOUR, 1), mkTrade(START + 125 * HOUR, 1),
];
const segs = segmentTrades(spread, 4);
check('trades are split into the requested number of segments', segs.length === 4);
check('every trade lands in exactly one segment',
  segs.reduce((n, s) => n + s.stats.trades, 0) === spread.length);
check('segments are ordered in time', segs.every((s, i) => i === 0 || s.from >= segs[i - 1].from));
check('segmenting an empty record yields nothing', segmentTrades([], 4).length === 0);

/* ------------------- validation: consistency verdict ------------------ */
const allPositive = segmentTrades([
  mkTrade(START + 1 * HOUR, 2), mkTrade(START + 40 * HOUR, 2),
  mkTrade(START + 80 * HOUR, 2), mkTrade(START + 120 * HOUR, 2),
], 4);
check('an evenly profitable record reads as consistent',
  judgeConsistency(allPositive).verdict === 'consistent');

// One segment carries everything: the classic flattering backtest.
const lucky = segmentTrades([
  mkTrade(START + 1 * HOUR, 0.05), mkTrade(START + 40 * HOUR, 0.05),
  mkTrade(START + 80 * HOUR, 20), mkTrade(START + 120 * HOUR, 0.05),
], 4);
const luckyVerdict = judgeConsistency(lucky);
check('a result carried by one lucky stretch is flagged', luckyVerdict.verdict === 'concentrated');
check('the concentration is explained', /один отрезок/.test(luckyVerdict.text));

check('too little data yields no verdict rather than a guess',
  judgeConsistency(segmentTrades([mkTrade(START, 1)], 4)).verdict === 'unknown');

/* ------------------- validation: robustness verdict ------------------- */
const cell = (totalR, trades = 30) => ({ params: {}, stats: { totalR, trades } });
const broadPlateau = [cell(5), cell(4), cell(6), cell(3), cell(-1), cell(2), cell(4), cell(5), cell(1), cell(3)];
const robust = judgeRobustness(broadPlateau, cell(5));
check('a broad profitable plateau reads as robust', robust.verdict === 'robust');
check('the share of profitable settings is reported', robust.profitableShare > 0.8);

const spike = [cell(9), cell(-2), cell(-3), cell(-1), cell(-4), cell(-2), cell(-1), cell(-3), cell(-2), cell(-1)];
const fragile = judgeRobustness(spike, cell(9));
check('a lone profitable spike reads as fragile', fragile.verdict === 'fragile');
check('overfitting is named plainly', /подогнан/.test(fragile.text));

check('losing defaults are called out even on a good grid',
  /убыточны/.test(judgeRobustness(broadPlateau, cell(-3)).text));

check('a grid with too few trades yields no verdict',
  judgeRobustness([cell(5, 2), cell(3, 1)], cell(5, 2)).verdict === 'unknown');

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
