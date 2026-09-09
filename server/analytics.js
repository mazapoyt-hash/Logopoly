/**
 * Detailed statistics — a diagnostic instrument, not a scoreboard.
 *
 * The point of slicing results finely is NOT to find a flattering number. It
 * is to answer questions a single aggregate cannot:
 *
 *   - Does the score actually rank trades? If a signal at 85 does no better
 *     than one at 60, the score is decoration and the probability shown next
 *     to it is meaningless.
 *   - Did losing trades go against us immediately, or run most of the way to
 *     the target and reverse? Those need opposite fixes.
 *   - Is the stated success probability honest? Of the signals we called 60%,
 *     did roughly 60% win?
 *   - Is any apparent edge real, or the arithmetic consequence of cutting the
 *     data forty ways until something looked good?
 *
 * That last question is the reason for most of the machinery here. Slice a
 * random series into 40 buckets at 5% significance and two will look
 * "significant" by construction. So every breakdown reports how many buckets
 * were tested and how many false positives to expect, every bucket carries a
 * confidence interval rather than a bare percentage, and any parameter choice
 * is made on one half of the history and graded on the other half, which the
 * choice never saw.
 *
 * A finding that survives that is worth acting on. One that does not is noise,
 * however good it looks in a table.
 */
import { config } from './config.js';
import { summarize, backtestSymbol } from './backtest.js';
import { wilsonInterval } from './probability.js';
import { GRID } from './validate.js';

/** Below this a bucket is reported but never called an edge. */
export const MIN_BUCKET = Number(process.env.COINSCOPE_MIN_BUCKET || 25);

/* ------------------------------ Statistics ---------------------------- */

/**
 * Confidence interval for a mean, from the sample itself.
 *
 * R-multiples are not normally distributed — they are a spike at −1 and a
 * spread of winners — but with a few dozen trades the mean is close enough to
 * normal for this to be honest as an interval on the MEAN, which is all it
 * claims to be.
 */
export function meanInterval(values, z = 1.96) {
  const n = values.length;
  if (n < 2) return { mean: n ? values[0] : null, low: null, high: null, stdErr: null, n };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const stdErr = Math.sqrt(variance / n);
  return { mean, low: mean - z * stdErr, high: mean + z * stdErr, stdErr, n };
}

/**
 * How many buckets would look significant by chance alone.
 *
 * Printed next to every breakdown on purpose. If a breakdown has 24 buckets
 * and one of them clears the bar, that is exactly what pure noise produces —
 * and knowing that is the difference between a finding and a story.
 */
export function expectedFalsePositives(bucketCount, alpha = 0.05) {
  return bucketCount * alpha;
}

/* ------------------------------ Dimensions ---------------------------- */

const band = (v, edges, labels) => {
  if (!Number.isFinite(v)) return null;
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
};

/**
 * The features a trade is grouped by. Each must be knowable at entry —
 * grouping by something only visible afterwards would be lookahead wearing a
 * different hat.
 */
export const DIMENSIONS = [
  {
    key: 'score', label: 'Score сигнала',
    question: 'Ранжирует ли score сделки? Если нет — вероятность рядом с сигналом ничего не значит.',
    of: (t) => band(t.score, [65, 70, 75, 80], ['60–64', '65–69', '70–74', '75–79', '80+']),
  },
  {
    key: 'direction', label: 'Направление',
    question: 'Работает ли стратегия в обе стороны или только по тренду рынка?',
    of: (t) => (t.direction === 'LONG' ? 'Лонг' : 'Шорт'),
  },
  {
    key: 'symbol', label: 'Монета',
    question: 'Есть ли монеты, на которых логика систематически не работает?',
    of: (t) => t.symbol,
  },
  {
    key: 'adx', label: 'Сила тренда (ADX)',
    question: 'Трендследящая логика должна работать лучше в сильном тренде. Проверяем.',
    of: (t) => band(t.context?.adx, [25, 30, 40], ['20–25', '25–30', '30–40', '40+']),
  },
  {
    key: 'rsi', label: 'RSI на входе',
    question: 'Входим ли мы в перегретый рынок и платим ли за это?',
    of: (t) => band(t.context?.rsi, [40, 50, 60, 70], ['<40', '40–50', '50–60', '60–70', '70+']),
  },
  {
    key: 'relVol', label: 'Объём к среднему',
    question: 'Подтверждает ли объём движение или это шум?',
    of: (t) => band(t.context?.relVol, [0.9, 1.1, 1.5], ['<0.9', '0.9–1.1', '1.1–1.5', '1.5+']),
  },
  {
    key: 'atrPct', label: 'Волатильность (ATR к цене)',
    question: 'Стоп масштабируется по ATR. Одинаково ли это работает в тихом и в бурном рынке?',
    of: (t) => band(t.context?.atrPct, [0.5, 1, 2], ['<0.5%', '0.5–1%', '1–2%', '2%+']),
  },
  {
    key: 'emaGap', label: 'Удалённость от EMA200',
    question: 'Не входим ли мы слишком поздно, когда движение уже произошло?',
    of: (t) => band(Math.abs(t.context?.emaGapPct ?? NaN), [2, 5, 10], ['<2%', '2–5%', '5–10%', '10%+']),
  },
  {
    key: 'session', label: 'Торговая сессия (UTC)',
    question: 'Крипта торгуется круглосуточно, но ликвидность — нет.',
    of: (t) => band(t.context?.hourUtc, [8, 13, 21], ['Азия 00–08', 'Европа 08–13', 'США 13–21', 'Вечер 21–24']),
  },
  {
    key: 'weekday', label: 'День недели',
    question: 'Контрольная нарезка: осмысленной связи тут быть не должно. Если она «найдётся» — это калибровка того, сколько врёт случайность.',
    of: (t) => ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][t.context?.weekday ?? 0],
  },
];

/**
 * Group trades by one dimension and describe every bucket with an interval,
 * never a bare number.
 */
export function breakdown(trades, dim) {
  const groups = new Map();
  for (const t of trades) {
    const key = dim.of(t);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const buckets = [...groups.entries()].map(([key, list]) => {
    const stats = summarize(list);
    const wins = list.filter((t) => t.r > 0).length;
    const win = wilsonInterval(wins, list.length);
    const avg = meanInterval(list.map((t) => t.r));
    return {
      key,
      trades: list.length,
      winRate: stats.winRate,
      winLow: win.low, winHigh: win.high,
      avgR: stats.avgR,
      avgLow: avg.low, avgHigh: avg.high,
      totalR: stats.totalR,
      profitFactor: stats.profitFactor,
      enough: list.length >= MIN_BUCKET,
      /*
       * "Significant" here means only: with this many trades, the interval for
       * the average result does not straddle zero. It is a floor, not a proof
       * — see falsePositives below.
       */
      significant: list.length >= MIN_BUCKET && avg.low != null &&
        (avg.low > 0 || avg.high < 0),
    };
  });

  buckets.sort((a, b) => String(a.key).localeCompare(String(b.key), 'ru', { numeric: true }));

  const tested = buckets.filter((b) => b.enough).length;
  return {
    key: dim.key, label: dim.label, question: dim.question,
    buckets,
    tested,
    flagged: buckets.filter((b) => b.significant).length,
    expectedByChance: expectedFalsePositives(tested),
  };
}

/* ------------------------------ Excursions ---------------------------- */

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/**
 * How far price travelled our way and against us before the trade ended.
 *
 * This is what tells you whether the target is in the wrong place. If losing
 * trades routinely reach +1.5R before turning, the entries are fine and the
 * exit is wrong. If they never reach +0.3R, the entries are wrong and no exit
 * rule will save them.
 *
 * One limit, stated rather than hidden: for a WINNING trade the measurement is
 * censored at the target, because the trade ends there and how much further
 * price would have run is unknowable from this data. So the loser figures are
 * the informative ones, and the "all trades" column understates how often
 * price reached the far levels. The uncensored version of the question — what
 * a different target would actually have produced — is answered properly by
 * re-running the strategy in outOfSampleTuning, not by extrapolating here.
 */
export function excursions(trades) {
  const withData = trades.filter((t) => Number.isFinite(t.mfeR));
  if (!withData.length) return null;

  const losers = withData.filter((t) => t.r <= 0);
  const mfe = withData.map((t) => t.mfeR).sort((a, b) => a - b);
  const loserMfe = losers.map((t) => t.mfeR).sort((a, b) => a - b);
  const mae = withData.filter((t) => t.r > 0).map((t) => t.maeR).sort((a, b) => a - b);

  // Share of trades that ever traded through each level.
  const levels = [0.5, 1, 1.5, 2, 2.5, 3];
  const reach = levels.map((level) => ({
    level,
    all: withData.filter((t) => t.mfeR >= level).length / withData.length,
    losers: losers.length ? losers.filter((t) => t.mfeR >= level).length / losers.length : null,
  }));

  return {
    trades: withData.length,
    losers: losers.length,
    medianMfeR: quantile(mfe, 0.5),
    p75MfeR: quantile(mfe, 0.75),
    medianLoserMfeR: quantile(loserMfe, 0.5),
    p75LoserMfeR: quantile(loserMfe, 0.75),
    /** Heat taken by trades that eventually won — how tight a stop could be. */
    medianWinnerMaeR: quantile(mae, 0.5),
    p90WinnerMaeR: quantile(mae, 0.9),
    reach,
    currentTargetR: config.strategy.rewardRisk,
  };
}

/* ----------------------------- Calibration ---------------------------- */

/**
 * Stated probability against what actually happened.
 *
 * A signal service that says 70% and wins 40% of the time is not slightly
 * off — it is selling a number it has not earned. This is the check for that,
 * and it runs on the site's own published signals, not on the backtest.
 */
export function calibration(closedSignals) {
  const usable = closedSignals.filter(
    (s) => Number.isFinite(s.winProb) && s.status && s.status !== 'open'
  );
  const bands = [
    { key: '<40%', min: 0, max: 0.4 },
    { key: '40–55%', min: 0.4, max: 0.55 },
    { key: '55–70%', min: 0.55, max: 0.7 },
    { key: '70%+', min: 0.7, max: 1.01 },
  ];

  const rows = bands.map((b) => {
    const list = usable.filter((s) => s.winProb >= b.min && s.winProb < b.max);
    const wins = list.filter((s) => (s.r ?? 0) > 0).length;
    const ci = wilsonInterval(wins, list.length);
    const stated = list.length
      ? list.reduce((sum, s) => sum + s.winProb, 0) / list.length : null;
    return {
      key: b.key, trades: list.length, stated,
      actual: list.length ? wins / list.length : null,
      low: ci.low, high: ci.high,
      /** Honest only if the stated number falls inside the observed interval. */
      consistent: list.length >= MIN_BUCKET && ci.low != null
        ? stated >= ci.low && stated <= ci.high : null,
    };
  });

  const judged = rows.filter((r) => r.consistent !== null);
  let verdict = 'unknown';
  if (judged.length) {
    verdict = judged.every((r) => r.consistent) ? 'calibrated'
      : judged.some((r) => r.consistent) ? 'mixed' : 'off';
  }
  return { rows, verdict, sample: usable.length, minBucket: MIN_BUCKET };
}

/* ---------------------- In-sample / out-of-sample ---------------------- */

/**
 * Split each symbol's candles into a tuning half and a verification half.
 *
 * Two details decide whether this is a real holdout or theatre:
 *
 *  - The verification slice carries a warm-up tail of earlier bars, because
 *    EMA200 says nothing for its first 200 bars. Those bars only prime the
 *    indicators — `scoreFrom` makes sure no trade opened before the cut is
 *    counted in the verification result.
 *  - The higher-timeframe series is passed whole. That is not a leak:
 *    `htfTrendAt` selects the HTF bar by close time and every indicator here
 *    is causal, so a bar from the future can never be read. Truncating it
 *    instead would leave the 4h EMA200 undefined and silently suppress every
 *    signal in the verification half — a much worse failure, and a quiet one.
 */
export function splitCandles(dataBySymbol, ratio = 0.7) {
  const inSample = {};
  const outSample = {};
  for (const [symbol, { candles, htf }] of Object.entries(dataBySymbol)) {
    const cut = Math.floor(candles.length * ratio);
    const cutTime = candles[cut]?.time ?? Infinity;
    inSample[symbol] = { candles: candles.slice(0, cut), htf, scoreFrom: 0 };

    const warm = Math.max(0, cut - 260);
    outSample[symbol] = { candles: candles.slice(warm), htf, scoreFrom: cutTime };
  }
  return { inSample, outSample };
}

function runGrid(dataBySymbol) {
  const cells = [];
  for (const minScore of GRID.minScore) {
    for (const atrStopMult of GRID.atrStopMult) {
      for (const rewardRisk of GRID.rewardRisk) {
        const params = { minScore, atrStopMult, rewardRisk };
        const all = [];
        for (const [symbol, { candles, htf, scoreFrom = 0 }] of Object.entries(dataBySymbol)) {
          const { trades } = backtestSymbol({
            symbol, timeframe: config.timeframe, candles, htfCandles: htf, params,
          });
          for (const t of trades) if (t.entryTime >= scoreFrom) all.push(t);
        }
        cells.push({ params, stats: summarize(all), trades: all });
      }
    }
  }
  return cells;
}

/**
 * The only honest way to ask "can these settings be improved".
 *
 * Pick the best parameter set on the first part of the history, then grade it
 * on the part it has never seen. Picking on everything and reporting the same
 * everything is not an experiment — it is a lookup of the maximum, and it
 * always looks good.
 *
 * The result usually disappoints, and that is the useful part: a large gap
 * between the tuned in-sample number and the out-of-sample one is the size of
 * the self-deception, measured.
 */
export function outOfSampleTuning(dataBySymbol, { ratio = 0.7 } = {}) {
  const { inSample, outSample } = splitCandles(dataBySymbol, ratio);

  const inCells = runGrid(inSample).filter((c) => c.stats.trades >= MIN_BUCKET);
  if (!inCells.length) {
    return { verdict: 'unknown', text: 'В обучающей половине слишком мало сделок, чтобы что-то выбирать.' };
  }

  inCells.sort((a, b) => b.stats.avgR - a.stats.avgR);
  const best = inCells[0];

  const matches = (a, b) => a.minScore === b.minScore &&
    a.atrStopMult === b.atrStopMult && a.rewardRisk === b.rewardRisk;

  const outCells = runGrid(outSample);
  const bestOut = outCells.find((c) => matches(c.params, best.params));
  const baselineOut = outCells.find((c) => matches(c.params, config.strategy));

  const inAvg = best.stats.avgR;
  const outAvg = bestOut?.stats.avgR ?? null;
  const decay = inAvg != null && outAvg != null ? inAvg - outAvg : null;

  let verdict;
  let text;
  if (outAvg == null || (bestOut?.stats.trades ?? 0) < MIN_BUCKET) {
    verdict = 'unknown';
    text = 'На проверочной половине набралось слишком мало сделок, чтобы судить о подобранных настройках.';
  } else if (outAvg > 0) {
    verdict = 'holds';
    text = `Настройки, подобранные на первых ${Math.round(ratio * 100)}% истории, на оставшихся ` +
      `${Math.round((1 - ratio) * 100)}% дали ${outAvg.toFixed(2)}R на сделку — плюс сохранился. ` +
      'Это самый сильный из доступных здесь аргументов, но и он не доказательство: ' +
      'проверочная половина всего одна.';
  } else {
    verdict = 'decays';
    text = `Лучший набор на обучающей половине давал ${inAvg.toFixed(2)}R на сделку, ` +
      `а на невиданных данных — ${outAvg.toFixed(2)}R. Разница ${decay?.toFixed(2)}R и есть ` +
      'цена подгонки: улучшение существовало только на тех данных, по которым выбирали.';
  }

  return {
    verdict, text, ratio,
    best: { params: best.params, inSample: pick(best.stats), outOfSample: pick(bestOut?.stats) },
    baseline: { params: { ...config.strategy }, outOfSample: pick(baselineOut?.stats) },
    decay,
    cellsConsidered: inCells.length,
  };
}

const pick = (s) => (s ? {
  trades: s.trades, winRate: s.winRate, avgR: s.avgR,
  totalR: s.totalR, profitFactor: s.profitFactor, maxDrawdownR: s.maxDrawdownR,
} : null);

/* -------------------------------- Report ------------------------------ */

/**
 * Everything above, assembled. `trades` must carry the entry context that
 * backtestSymbol records; `signals` are the site's own published, resolved
 * signals for the calibration section.
 */
export function analyse({ trades, signals = [], dataBySymbol = null, ratio = 0.7 }) {
  const breakdowns = DIMENSIONS.map((d) => breakdown(trades, d));

  // Across every dimension at once: this is the number that decides whether a
  // single good-looking bucket means anything.
  const tested = breakdowns.reduce((s, b) => s + b.tested, 0);
  const flagged = breakdowns.reduce((s, b) => s + b.flagged, 0);

  return {
    generatedAt: Date.now(),
    overall: summarize(trades),
    sample: {
      trades: trades.length,
      from: trades.length ? Math.min(...trades.map((t) => t.entryTime)) : null,
      to: trades.length ? Math.max(...trades.map((t) => t.entryTime)) : null,
    },
    breakdowns,
    multipleComparisons: {
      tested, flagged,
      expected: expectedFalsePositives(tested),
      /*
       * The honest reading: if you slice the same data enough ways, some slice
       * clears any bar. Only a surplus over the expected count is evidence,
       * and even then it says "look here", not "trade this".
       */
      surplus: flagged - expectedFalsePositives(tested),
    },
    excursions: excursions(trades),
    calibration: calibration(signals),
    tuning: dataBySymbol ? outOfSampleTuning(dataBySymbol, { ratio }) : null,
    minBucket: MIN_BUCKET,
  };
}
