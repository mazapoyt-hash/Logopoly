/**
 * Validation: is the measured edge real, or an artefact?
 *
 * A single backtest number proves very little. Two things are checked here,
 * and both can fail — that is the point.
 *
 * 1. CONSISTENCY OVER TIME. Trades are bucketed into equal time segments. A
 *    strategy whose whole result comes from one lucky stretch is not an edge,
 *    it is a story. Reported per segment so a concentrated result is visible
 *    instead of averaged away.
 *
 * 2. PARAMETER ROBUSTNESS. The same logic is re-run across a grid of
 *    thresholds. If profit survives only at one exact setting, the setting was
 *    fitted to this history and will not survive contact with new data. A
 *    broad plateau of profitable settings is the sign worth trusting — the
 *    single best cell in the grid never is.
 *
 * Neither test can prove a strategy works. Both can show that it does not.
 */
import { config } from './config.js';
import { backtestSymbol, summarize } from './backtest.js';
import { getCandles } from './sources/index.js';

/* ------------------------- 1. Consistency over time ------------------- */
export function segmentTrades(trades, segments = 4) {
  if (!trades.length) return [];
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const first = sorted[0].entryTime;
  const last = sorted[sorted.length - 1].entryTime;
  const span = Math.max(1, last - first);
  const width = span / segments;

  const buckets = Array.from({ length: segments }, (_, i) => ({
    index: i + 1,
    from: first + i * width,
    to: first + (i + 1) * width,
    trades: [],
  }));
  for (const t of sorted) {
    const idx = Math.min(segments - 1, Math.floor((t.entryTime - first) / width));
    buckets[idx].trades.push(t);
  }
  return buckets.map((b) => ({
    index: b.index, from: b.from, to: b.to, stats: summarize(b.trades),
  }));
}

/* -------------------------- 2. Parameter grid ------------------------- */
export const GRID = {
  minScore: [50, 55, 60, 65, 70, 75],
  atrStopMult: [1.0, 1.25, 1.5, 2.0],
  /*
   * The low end (1 and 1.25) is here because the excursion measurement asked
   * for it, not because the sweep needed more cells: on real data only 28% of
   * trades ever traded through +2R, while 48% reached +1R. A grid whose
   * cheapest target was 1.5R could never test the one thing the data actually
   * suggested. Widening it does not make the sweep more likely to find a
   * winner — every cell still has to survive the out-of-sample half.
   */
  rewardRisk: [1, 1.25, 1.5, 2, 2.5, 3],
};

function* gridCombos() {
  for (const minScore of GRID.minScore) {
    for (const atrStopMult of GRID.atrStopMult) {
      for (const rewardRisk of GRID.rewardRisk) {
        yield { minScore, atrStopMult, rewardRisk };
      }
    }
  }
}

/**
 * Run the whole symbol set under one parameter set.
 * Data is passed in so the grid does not refetch it hundreds of times.
 */
export function runWithParams(dataBySymbol, params) {
  const all = [];
  for (const [symbol, { candles, htf }] of Object.entries(dataBySymbol)) {
    const { trades } = backtestSymbol({
      symbol, timeframe: config.timeframe, candles, htfCandles: htf, params,
    });
    all.push(...trades);
  }
  return summarize(all);
}

/**
 * Verdict on a grid: how much of the parameter space works, and whether the
 * configured defaults sit in the good part of it.
 */
export function judgeRobustness(cells, current) {
  const usable = cells.filter((c) => c.stats.trades >= 10);
  if (!usable.length) {
    return { verdict: 'unknown', profitableShare: null,
      text: 'Слишком мало сделок в сетке — судить не о чем.' };
  }
  const profitable = usable.filter((c) => c.stats.totalR > 0);
  const share = profitable.length / usable.length;
  const currentOk = current && current.stats.totalR > 0;

  let verdict;
  let text;
  if (share >= 0.7 && currentOk) {
    verdict = 'robust';
    text = `Прибыльны ${profitable.length} из ${usable.length} наборов параметров. ` +
      'Результат держится на широком плато, а не на одной точке — это признак того, ' +
      'что дело не в подгонке.';
  } else if (share >= 0.4) {
    verdict = 'mixed';
    text = `Прибыльны ${profitable.length} из ${usable.length} наборов. ` +
      'Плато узкое: результат заметно зависит от настроек, поэтому относиться к нему ' +
      'нужно осторожно.';
  } else {
    verdict = 'fragile';
    text = `Прибыльны лишь ${profitable.length} из ${usable.length} наборов. ` +
      'Большая часть пространства параметров убыточна — скорее всего, текущие пороги ' +
      'подогнаны под эту историю.';
  }
  if (!currentOk) {
    text += ' Текущие настройки в этой выборке убыточны.';
  }
  return { verdict, profitableShare: share, usableCells: usable.length, text };
}

export function judgeConsistency(segments) {
  const withTrades = segments.filter((s) => s.stats.trades > 0);
  if (withTrades.length < 2) {
    return { verdict: 'unknown', text: 'Сделок слишком мало, чтобы смотреть на распределение во времени.' };
  }
  const positive = withTrades.filter((s) => s.stats.totalR > 0).length;
  const total = withTrades.reduce((acc, s) => acc + s.stats.totalR, 0);
  const best = Math.max(...withTrades.map((s) => s.stats.totalR));

  // Concentration is checked BEFORE "everything is positive", because the
  // dangerous case looks fine by that test: three segments at +0.05R and one
  // at +20R are all positive, yet the result is one lucky stretch.
  if (total > 0 && best / total > 0.8) {
    return { verdict: 'concentrated', positive, segments: withTrades.length,
      text: `Больше 80% результата приходится на один отрезок из ${withTrades.length}. ` +
        'Это не устойчивый заработок, а один удачный период.' };
  }
  if (positive === withTrades.length) {
    return { verdict: 'consistent', positive, segments: withTrades.length,
      text: `Все ${withTrades.length} отрезка прибыльны — результат распределён во времени.` };
  }
  return { verdict: positive * 2 >= withTrades.length ? 'mixed' : 'weak', positive, segments: withTrades.length,
    text: `Прибыльны ${positive} отрезка из ${withTrades.length}.` };
}

/* ------------------------------- Runner ------------------------------- */
export async function runValidation({ segments = 4, onProgress = null } = {}) {
  const dataBySymbol = {};
  for (const symbol of config.symbols) {
    dataBySymbol[symbol] = {
      candles: await getCandles(symbol, config.timeframe, config.candleLimit),
      htf: await getCandles(symbol, config.higherTimeframe, config.candleLimit),
    };
  }

  // Baseline run with the configured thresholds.
  const baselineTrades = [];
  for (const [symbol, { candles, htf }] of Object.entries(dataBySymbol)) {
    const { trades } = backtestSymbol({ symbol, timeframe: config.timeframe, candles, htfCandles: htf });
    baselineTrades.push(...trades);
  }
  const baseline = summarize(baselineTrades);
  const timeline = segmentTrades(baselineTrades, segments);

  // Parameter sweep.
  const cells = [];
  const combos = [...gridCombos()];
  for (let i = 0; i < combos.length; i++) {
    const params = combos[i];
    cells.push({ params, stats: runWithParams(dataBySymbol, params) });
    onProgress?.(i + 1, combos.length);
  }

  const currentCell = cells.find((c) =>
    c.params.minScore === config.strategy.minScore &&
    c.params.atrStopMult === config.strategy.atrStopMult &&
    c.params.rewardRisk === config.strategy.rewardRisk) || { params: null, stats: baseline };

  return {
    createdAt: Date.now(),
    source: config.source,
    timeframe: config.timeframe,
    symbols: config.symbols,
    bars: Object.values(dataBySymbol)[0]?.candles.length ?? 0,
    baseline,
    timeline,
    consistency: judgeConsistency(timeline),
    grid: cells.map((c) => ({ ...c.params, ...pickStats(c.stats) })),
    robustness: judgeRobustness(cells, currentCell),
    current: { ...config.strategy },
  };
}

function pickStats(s) {
  return {
    trades: s.trades, winRate: s.winRate, avgR: s.avgR,
    totalR: s.totalR, profitFactor: s.profitFactor === Infinity ? null : s.profitFactor,
    maxDrawdownR: s.maxDrawdownR,
  };
}
