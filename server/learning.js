/**
 * Does re-fitting as you go actually help? Measured, not assumed.
 *
 * "The system should learn from every signal and get better" is the most
 * natural request in the world and, in this particular problem, the most
 * reliably harmful one. The reason is a ratio, not an opinion.
 *
 * A single trade's result carries a standard deviation of roughly 1R. The edge
 * anyone is hunting for is on the order of 0.05R per trade. So one trade
 * contains about one twentieth of a signal buried in a full unit of noise, and
 * to separate an 0.05R edge from zero with any confidence needs thousands of
 * trades. A rule that updates itself after each outcome is therefore updating
 * almost entirely on noise: it chases whatever just happened, and what just
 * happened is mostly luck.
 *
 * That is the theory. This module tests it, because theory is not evidence.
 *
 * WALK-FORWARD is the honest version of learning. Split the history into
 * consecutive folds. For each fold, pick the best parameters using ONLY the
 * folds before it, then trade the fold with them and record the result.
 * Advance and repeat. Every result is out-of-sample by construction, and the
 * procedure mimics what an adaptive system actually does — re-fit on the past,
 * act on the future — only at an honest cadence, on thousands of trades per
 * update rather than one.
 *
 * The comparison that matters is against a strategy that never adapts at all:
 * fixed parameters, same folds. If adapting is worth anything, it beats the
 * fixed rules. If it does not, "learning" is a more expensive way of tracking
 * noise, and the measurement says so.
 */
import { config } from './config.js';
import { backtestSymbol, summarize } from './backtest.js';
import { GRID } from './validate.js';

/** Every parameter set the search may choose from. */
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
 * Cut the shared timeline into k consecutive windows.
 *
 * Time, not trade count: folds have to be comparable across symbols, and a
 * symbol with more trades must not silently get more folds than another.
 */
export function timeFolds(dataBySymbol, folds = 5) {
  const times = [];
  for (const { candles } of Object.values(dataBySymbol)) {
    if (candles.length) {
      times.push(candles[0].time, candles[candles.length - 1].time);
    }
  }
  if (!times.length) return [];
  const from = Math.min(...times);
  const to = Math.max(...times);
  const step = (to - from) / folds;
  return Array.from({ length: folds }, (_, i) => ({
    index: i, from: from + i * step, to: from + (i + 1) * step,
  }));
}

/**
 * Every parameter set run once over the whole history.
 *
 * The backtest is deterministic over the full series, so a fold's trades are
 * just a time slice of the same run — nothing about them depends on which
 * window is being looked at. Running the grid once and slicing afterwards is
 * therefore not an approximation, it is the identical result for a fraction of
 * the work: one pass per parameter set instead of one per set per fold.
 *
 * The full candle series is always used, never a slice, so indicators stay
 * warmed up. Cutting the candles per fold would leave EMA200 undefined at the
 * start of each one and silently suppress the trades the fold exists to measure.
 */
function runGridOnce(dataBySymbol, combos) {
  return combos.map((params) => {
    const trades = [];
    for (const [symbol, { candles, htf }] of Object.entries(dataBySymbol)) {
      const res = backtestSymbol({
        symbol, timeframe: config.timeframe, candles, htfCandles: htf, params,
      });
      trades.push(...res.trades);
    }
    trades.sort((a, b) => a.entryTime - b.entryTime);
    return { params, trades };
  });
}

const inWindow = (trades, { from, to }) =>
  trades.filter((t) => t.entryTime >= from && t.entryTime < to);

/**
 * Walk forward: choose on the past, be graded on the next window, repeat.
 *
 * `minTrades` guards the choice itself. Picking the best of ~150 parameter
 * sets on a handful of trades is not learning, it is sampling the maximum of
 * a noise distribution — so a fold with too little history behind it makes no
 * choice and falls back to the fixed settings.
 */
export function walkForward(dataBySymbol, { folds = 5, minTrades = 100 } = {}) {
  const windows = timeFolds(dataBySymbol, folds);
  if (windows.length < 3) return null;

  const runs = runGridOnce(dataBySymbol, [...gridCombos()]);
  const same = (a, b) => a.minScore === b.minScore &&
    a.atrStopMult === b.atrStopMult && a.rewardRisk === b.rewardRisk;
  const fixedRun = runs.find((r) => same(r.params, config.strategy))
    || runGridOnce(dataBySymbol, [{ ...config.strategy }])[0];
  const steps = [];

  // Fold 0 is training material only; grading starts once there is a past.
  for (let i = 1; i < windows.length; i++) {
    const past = { from: windows[0].from, to: windows[i].from };
    const now = windows[i];

    let chosen = null;
    let bestAvg = -Infinity;
    let consideredOn = 0;
    let chosenRun = null;
    for (const run of runs) {
      const hist = inWindow(run.trades, past);
      if (hist.length < minTrades) continue;
      const s = summarize(hist);
      if (s.avgR > bestAvg) {
        bestAvg = s.avgR; chosen = run.params; consideredOn = hist.length; chosenRun = run;
      }
    }

    const adaptive = summarize(inWindow((chosenRun || fixedRun).trades, now));
    const fixed = summarize(inWindow(fixedRun.trades, now));

    steps.push({
      fold: i, from: now.from, to: now.to,
      chose: chosen ? { ...chosen } : null,
      chosenOnTrades: consideredOn,
      expectedAvgR: chosen ? bestAvg : null,   // what the choice promised
      adaptive: pick(adaptive),
      fixed: pick(fixed),
      /** Promise minus delivery: the per-fold size of the self-deception. */
      shortfall: chosen && Number.isFinite(adaptive.avgR) ? bestAvg - adaptive.avgR : null,
    });
  }

  const usable = steps.filter((s) => s.adaptive.trades > 0 && s.fixed.trades > 0);
  if (!usable.length) return null;

  const wSum = (rows, key) => rows.reduce((acc, s) => acc + (s[key].avgR * s[key].trades), 0);
  const tSum = (rows, key) => rows.reduce((acc, s) => acc + s[key].trades, 0);
  const adaptiveAvg = wSum(usable, 'adaptive') / tSum(usable, 'adaptive');
  const fixedAvg = wSum(usable, 'fixed') / tSum(usable, 'fixed');
  const wins = usable.filter((s) => s.adaptive.avgR > s.fixed.avgR).length;

  const shortfalls = usable.map((s) => s.shortfall).filter(Number.isFinite);
  const avgShortfall = shortfalls.length
    ? shortfalls.reduce((a, b) => a + b, 0) / shortfalls.length : null;

  let verdict;
  let text;
  const delta = adaptiveAvg - fixedAvg;
  if (delta > 0.02 && wins > usable.length / 2) {
    verdict = 'helps';
    text = `Переобучение по ходу дало ${adaptiveAvg.toFixed(3)}R на сделку против ` +
      `${fixedAvg.toFixed(3)}R у неизменных настроек, и выиграло в ${wins} окнах из ` +
      `${usable.length}. На этих данных адаптация окупается — но окон всего ${usable.length}, ` +
      'и это не тот запас, на котором строят уверенность.';
  } else if (delta < -0.02) {
    verdict = 'hurts';
    text = `Переобучение по ходу дало ${adaptiveAvg.toFixed(3)}R на сделку против ` +
      `${fixedAvg.toFixed(3)}R у неизменных настроек — то есть **хуже**, чем если бы система ` +
      'не училась вовсе. Каждое окно она выбирала лучшее из прошлого, и каждый раз ' +
      'выбранное не переносилось вперёд.';
  } else {
    verdict = 'noise';
    text = `Переобучение по ходу дало ${adaptiveAvg.toFixed(3)}R против ${fixedAvg.toFixed(3)}R ` +
      'у неизменных настроек — разница в пределах шума. Адаптация не помогает и не вредит, ' +
      'она просто ничего не добавляет: единственное, что она надёжно делает, это создаёт ' +
      'ощущение работы.';
  }

  if (avgShortfall != null) {
    text += ` Выбранный набор обещал в среднем ${(avgShortfall > 0 ? '+' : '')}` +
      `${avgShortfall.toFixed(3)}R сверх того, что потом дал. Этот разрыв и есть цена ` +
      'подгонки, измеренная на каждом шаге.';
  }

  return {
    verdict, text, folds: usable.length,
    adaptiveAvgR: adaptiveAvg, fixedAvgR: fixedAvg, delta,
    foldsWonByAdaptive: wins,
    avgShortfall,
    steps,
  };
}

const pick = (s) => ({
  trades: s.trades, winRate: s.winRate, avgR: s.avgR, totalR: s.totalR,
});

/**
 * How many trades it takes to see an edge of a given size at all.
 *
 * This is the number that makes per-signal learning obviously hopeless, and it
 * needs no data: with a per-trade standard deviation of about 1R, separating
 * an edge of `edge` from zero at two standard errors needs
 *
 *     n  =  (2 * sd / edge)^2
 *
 * At 0.05R that is 1600 trades. A system that "learns from every signal" is
 * reacting to one sixteen-hundredth of the evidence required to know whether
 * there was anything to learn.
 */
export function tradesNeeded(edge, { sd = 1, z = 2 } = {}) {
  if (!(edge > 0)) return null;
  return Math.ceil((z * sd / edge) ** 2);
}

/** A small table of that, for the report. */
export function evidenceScale(edges = [0.02, 0.05, 0.1, 0.2, 0.5]) {
  return edges.map((edge) => ({ edge, trades: tradesNeeded(edge) }));
}
