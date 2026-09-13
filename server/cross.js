/**
 * Cross-sectional momentum: rank the coins against EACH OTHER.
 *
 * WHY THIS AND NOT ANOTHER THRESHOLD TWEAK
 *
 * Every measurement in this project says the same thing about the signal
 * strategy: the entries carry no information. The random-entry benchmark puts
 * them at the 71st percentile on hourly bars and the 31st on daily — "the same
 * as a coin flip" either way. Moving to daily bars removed six sevenths of the
 * toll exactly as the arithmetic predicted, and what surfaced underneath was
 * a raw edge of +0.026R that is indistinguishable from zero on 327 trades.
 *
 * The diagnosis that follows is specific: whatever positive result appeared
 * before costs was mostly the market's own drift, captured by being long in a
 * rising market. That is not an edge. It is beta with extra steps, and it
 * cannot be improved by tuning the thing that selects when to take it.
 *
 * A cross-sectional bet is structurally different, and the difference is the
 * whole point:
 *
 *   - it is RELATIVE. Holding the strongest coins and (optionally) shorting the
 *     weakest cancels the market-wide move, so drift cannot masquerade as skill;
 *   - it asks a question the per-coin strategy never asked: not "is this coin
 *     going up" but "is this coin going up MORE than its peers";
 *   - it has a documented mechanism rather than a pattern — flows concentrate
 *     into what is already moving, and that concentration is slow.
 *
 * None of which makes it work. This module exists to find out, with the same
 * discipline as everything else here: a benchmark that is hard to beat, a
 * random control, costs charged on every rebalance, and a reserved slice.
 *
 * THE BENCHMARK THAT MATTERS
 *
 * Not zero — the equal-weight universe. A strategy that returns 40% while
 * simply holding all the coins returned 60% has found nothing, and comparing it
 * to zero would hide that completely. Drift is the null hypothesis here, so
 * drift is what it has to beat.
 */
import { COSTS } from './backtest.js';
import { makeRng, quantile, percentileOf } from './nulls.js';

const YEAR_MS = 365 * 24 * 3600 * 1000;

const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
};

/* --------------------------- aligning the panel ----------------------- */

/**
 * One timeline shared by every coin.
 *
 * Coins list at different dates and occasionally miss a bar, so their arrays
 * are not interchangeable by index. Ranking coin A's bar 300 against coin B's
 * bar 300 when those are different days is a silent way to invent a result, so
 * everything below indexes by TIME and a missing bar stays missing.
 *
 * Only timestamps present in at least `minCoverage` of the symbols survive:
 * a date where three coins out of forty have data cannot be ranked
 * meaningfully, and including it would let thin early history dominate.
 */
export function alignCloses(dataBySymbol, { minCoverage = 0.8 } = {}) {
  const symbols = Object.keys(dataBySymbol).filter((s) => dataBySymbol[s]?.candles?.length);
  if (symbols.length < 3) return null;

  const byTime = new Map();
  for (const symbol of symbols) {
    for (const c of dataBySymbol[symbol].candles) {
      if (!Number.isFinite(c.close) || c.close <= 0) continue;
      if (!byTime.has(c.time)) byTime.set(c.time, {});
      byTime.get(c.time)[symbol] = c.close;
    }
  }

  const need = Math.ceil(symbols.length * minCoverage);
  const times = [...byTime.keys()].sort((a, b) => a - b)
    .filter((t) => Object.keys(byTime.get(t)).length >= need);
  if (times.length < 30) return null;

  return { symbols, times, closes: times.map((t) => byTime.get(t)) };
}

/* ------------------------------ the strategy -------------------------- */

/**
 * One rebalance decision, made only from data available at that moment.
 *
 * The ranking at bar `i` uses the return from `i - lookback` to `i`, both of
 * which have closed. The result it earns is the move from `i` to `i + hold`,
 * which has not. Mixing those two up is the classic way to produce a beautiful
 * backtest that cannot be traded, so the split is kept explicit here rather
 * than buried in an index arithmetic somewhere.
 */
export function rankAt(panel, i, lookback) {
  const now = panel.closes[i];
  const past = panel.closes[i - lookback];
  if (!now || !past) return [];

  const rows = [];
  for (const symbol of panel.symbols) {
    const a = past[symbol];
    const b = now[symbol];
    if (!(a > 0) || !(b > 0)) continue;          // missing bar: not rankable
    rows.push({ symbol, momentum: b / a - 1 });
  }
  return rows.sort((a, b) => b.momentum - a.momentum);
}

/** Return of one symbol between two bars, or null when either is missing. */
const legReturn = (panel, from, to, symbol) => {
  const a = panel.closes[from]?.[symbol];
  const b = panel.closes[to]?.[symbol];
  return (a > 0 && b > 0) ? b / a - 1 : null;
};

/**
 * Walk the panel, rebalancing every `hold` bars.
 *
 * `pick` chooses the basket from the ranking; passing a different `pick` is how
 * the random control below reuses this exact loop, costs and all. Anything the
 * strategy pays, the control pays too — otherwise the comparison flatters the
 * strategy by construction.
 */
export function simulate(panel, { lookback, hold, topK, mode, costs, pick, startAt = 0 }) {
  const trip = (costs.feeRate + costs.slippageRate) * 2;  // in and out, one leg
  const periods = [];
  let held = new Set();

  for (let i = lookback; i + hold < panel.times.length; i += hold) {
    /*
     * `startAt` is what makes a holdout real. The reserved slice is handed in
     * with a warm-up tail so the first ranking is computable at all, and those
     * warm-up bars must not be scored — otherwise the "unseen" result quietly
     * contains the data the grid was fitted on.
     */
    if (panel.times[i] < startAt) continue;
    const ranking = rankAt(panel, i, lookback);
    if (ranking.length < topK * (mode === 'longShort' ? 2 : 1)) continue;

    const { longs, shorts } = pick(ranking, i);
    if (!longs.length) continue;

    const legs = [];
    for (const s of longs) {
      const r = legReturn(panel, i, i + hold, s);
      if (r != null) legs.push(r);
    }
    for (const s of shorts) {
      const r = legReturn(panel, i, i + hold, s);
      if (r != null) legs.push(-r);
    }
    if (!legs.length) continue;

    /*
     * Costs are charged on TURNOVER, not on the whole book: a coin that stays
     * in the basket is not sold and re-bought. Charging the full round trip
     * every period would make any frequent rebalance look impossible, and
     * charging nothing would make it look free. Both are wrong.
     */
    const wanted = new Set([...longs, ...shorts]);
    let changed = 0;
    for (const s of wanted) if (!held.has(s)) changed++;
    for (const s of held) if (!wanted.has(s)) changed++;
    const turnover = wanted.size ? changed / (wanted.size * 2) : 1;
    held = wanted;

    periods.push({
      at: panel.times[i],
      until: panel.times[i + hold],
      gross: mean(legs),
      cost: turnover * trip,
      net: mean(legs) - turnover * trip,
      turnover,
      basket: [...wanted],
    });
  }

  return periods;
}

/** Compound a list of period returns into one multiple. */
const compound = (rs) => rs.reduce((acc, r) => acc * (1 + r), 1);

export function describe(periods, hold) {
  if (!periods.length) return null;
  const nets = periods.map((p) => p.net);
  /*
   * Annualise over the time the money was actually at work, not over the span
   * of the panel. The lookback warm-up and the reserved slice both sit inside
   * the panel without being traded, and dividing by them would understate every
   * figure here by the same sleight of hand that inflates a short backtest.
   */
  const span = periods[periods.length - 1].until - periods[0].at;
  const years = span / YEAR_MS;
  const multiple = compound(nets);

  return {
    periods: periods.length,
    from: periods[0].at,
    to: periods[periods.length - 1].until,
    years,
    multiple,
    annualPct: years > 0 ? ((multiple ** (1 / years)) - 1) * 100 : null,
    meanPeriodPct: mean(nets) * 100,
    sdPeriodPct: sd(nets) * 100,
    winRate: nets.filter((r) => r > 0).length / nets.length,
    grossPct: (compound(periods.map((p) => p.gross)) - 1) * 100,
    costPct: periods.reduce((s, p) => s + p.cost, 0) * 100,
    avgTurnover: mean(periods.map((p) => p.turnover)),
    barsHeld: hold,
  };
}

/**
 * Holding everything, equally weighted — the benchmark the strategy must beat.
 *
 * This is drift, and drift is the null hypothesis. Reported through the same
 * rebalance loop so it pays the same kind of cost, though its turnover is near
 * zero because the basket never changes.
 */
function universeBenchmark(panel, { hold, lookback, costs, startAt }) {
  return simulate(panel, {
    lookback, hold, topK: 1, mode: 'longOnly', costs, startAt,
    pick: (ranking) => ({ longs: ranking.map((r) => r.symbol), shorts: [] }),
  });
}

/* ------------------------------ the control --------------------------- */

/**
 * The null: the same ranking, wearing the wrong names.
 *
 * The obvious control — draw a fresh random basket every rebalance — is wrong
 * here, and wrong in the direction that manufactures discoveries. A momentum
 * basket PERSISTS: the leaders of the last forty bars are largely the leaders
 * of the next forty, so it turns over about a third of itself per period. A
 * freshly drawn basket turns over three quarters of itself, and that difference
 * is not cosmetic — re-drawing every period averages across coins over time and
 * narrows the spread of outcomes. Measured on this project's own synthetic
 * data: sd 4.4 for the fresh control against 5.5 for a persistent one.
 *
 * A strategy compared against a null narrower than itself lands in that null's
 * tail far more often than the tail's own probability, in BOTH directions. On
 * information-free universes the fresh control called two seeds out of five an
 * edge — at a 95th-percentile threshold, on data where by construction no edge
 * exists. That is a detector that finds things that are not there, which is the
 * one failure mode this project cannot afford.
 *
 * So the control permutes the symbol LABELS instead. Coin A's momentum is used
 * to buy coin B. The ranking keeps its exact shape and persistence — the
 * relabelled basket turns over precisely as often as the real one, because it
 * IS the real one under a different name — while the link between a coin's past
 * and that coin's future is destroyed. That link is the only thing under test,
 * and now it is the only thing the control removes.
 */
export function shuffleLabels(symbols, rng) {
  const shuffled = [...symbols];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return new Map(symbols.map((s, i) => [s, shuffled[i]]));
}

/* --------------------------------- report ----------------------------- */

/**
 * Does ranking coins against each other beat simply holding them all?
 *
 * Three numbers decide it, and the order matters. First the benchmark: what did
 * the whole universe do over the same dates. Then the strategy. Then a random
 * basket of the same size, rebalanced on the same dates and paying the same
 * costs — because with a handful of coins and a rising market, almost any
 * basket looks good, and only the random control says whether the RANKING did
 * anything.
 */
export function crossSectional(dataBySymbol, {
  lookback = 20, hold = 5, topK = 3, mode = 'longOnly',
  costs = COSTS, replicates = 400, seed = 90210, startAt = 0,
} = {}) {
  const panel = alignCloses(dataBySymbol);
  if (!panel) return null;
  if (panel.symbols.length < topK * (mode === 'longShort' ? 2 : 1) + 2) return null;

  const strategyPeriods = simulate(panel, {
    lookback, hold, topK, mode, costs, startAt,
    pick: (ranking) => ({
      longs: ranking.slice(0, topK).map((r) => r.symbol),
      shorts: mode === 'longShort' ? ranking.slice(-topK).map((r) => r.symbol) : [],
    }),
  });
  const strategy = describe(strategyPeriods, hold);
  if (!strategy) return null;

  const benchmark = describe(universeBenchmark(panel, { hold, lookback, costs, startAt }), hold);

  const rnd = makeRng(seed);
  const nullAnnuals = [];
  for (let r = 0; r < replicates; r++) {
    const swap = shuffleLabels(panel.symbols, rnd);
    const periods = simulate(panel, {
      lookback, hold, topK, mode, costs, startAt,
      pick: (ranking) => {
        const relabelled = ranking.map((row) => swap.get(row.symbol));
        return {
          longs: relabelled.slice(0, topK),
          shorts: mode === 'longShort' ? relabelled.slice(-topK) : [],
        };
      },
    });
    const d = describe(periods, hold);
    if (d && Number.isFinite(d.annualPct)) nullAnnuals.push(d.annualPct);
  }
  nullAnnuals.sort((a, b) => a - b);

  const percentile = nullAnnuals.length
    ? percentileOf(nullAnnuals, strategy.annualPct) * 100 : null;
  const excess = benchmark ? strategy.annualPct - benchmark.annualPct : null;

  /*
   * A verdict that can say "nothing here", and says it by default. Beating the
   * benchmark is not enough on its own: with a small basket and a rising market
   * a lucky draw does that regularly, which is exactly what the random control
   * measures.
   */
  let verdict = 'none';
  if (percentile != null && percentile >= 95 && excess > 0) verdict = 'edge';
  else if (percentile != null && percentile >= 80 && excess > 0) verdict = 'weak';
  else if (excess != null && excess <= 0) verdict = 'worse-than-holding';

  return {
    params: { lookback, hold, topK, mode, replicates, startAt },
    symbols: panel.symbols.length,
    bars: panel.times.length,
    strategy,
    benchmark,
    excessAnnualPct: excess,
    nullPercentile: percentile,
    nullMedianAnnualPct: nullAnnuals.length ? quantile(nullAnnuals, 0.5) : null,
    nullP95AnnualPct: nullAnnuals.length ? quantile(nullAnnuals, 0.95) : null,
    verdict,
    text: verdictText({ verdict, strategy, benchmark, excess, percentile }),
  };
}

function verdictText({ verdict, strategy, benchmark, excess, percentile }) {
  const s = strategy.annualPct?.toFixed(1);
  const b = benchmark?.annualPct?.toFixed(1) ?? '—';
  const p = percentile?.toFixed(0) ?? '—';

  if (verdict === 'edge') {
    return `Ранжирование работает: ${s}% годовых против ${b}% у простого удержания всех монет, ` +
      `и это ${p}-й процентиль против контроля со случайно переставленными названиями монет. ` +
      'То есть обыграны и дрейф, и та же самая перекладка, лишённая связи с прошлым монеты.';
  }
  if (verdict === 'weak') {
    return `Ранжирование даёт ${s}% годовых против ${b}% у удержания всех, но против контроля ` +
      `со случайно переставленными названиями это лишь ${p}-й процентиль — граница шума. ` +
      'На такой разнице строить нельзя: нужен либо более длинный период, либо более широкая ' +
      'вселенная.';
  }
  if (verdict === 'worse-than-holding') {
    return `Ранжирование даёт ${s}% годовых, а простое удержание всех монет — ${b}%. ` +
      'Отбор не добавляет ничего, он отнимает: та же экспозиция к рынку, но с издержками ' +
      'на перекладывание. Держать всё было бы лучше.';
  }
  return `Ранжирование даёт ${s}% годовых против ${b}% у удержания всех, и это ${p}-й процентиль ` +
    'против контроля со случайно переставленными названиями монет. То есть тот же набор, ' +
    'выбранный без всякой связи с прошлым монеты, справляется не хуже: заработал рынок, ' +
    'а не правило.';
}

/* --------------------------------- holdout ---------------------------- */

/**
 * Cut the history in two at one shared moment in time.
 *
 * Per-symbol index splits are wrong here. Coins have different listing dates,
 * so "the last 30% of each array" is a different date for every coin, and a
 * cross-sectional test would then be ranking one coin's 2025 against another's
 * 2024. The cut is therefore a timestamp, applied identically to everyone.
 *
 * The reserved slice carries `warmupBars` of earlier bars so the first ranking
 * is computable, and `from` marks where scoring may begin — those warm-up bars
 * exist to be looked back at, never to be traded.
 */
export function splitByTime(dataBySymbol, { ratio = 0.3, warmupBars = 60 } = {}) {
  const times = new Set();
  for (const { candles } of Object.values(dataBySymbol)) {
    for (const c of candles || []) times.add(c.time);
  }
  const all = [...times].sort((a, b) => a - b);
  if (all.length < 60) return null;

  const cutIndex = Math.floor(all.length * (1 - ratio));
  const cut = all[cutIndex];
  const warmFrom = all[Math.max(0, cutIndex - warmupBars)];

  const working = {};
  const reserved = {};
  for (const [symbol, entry] of Object.entries(dataBySymbol)) {
    const candles = entry.candles || [];
    working[symbol] = { ...entry, candles: candles.filter((c) => c.time < cut) };
    reserved[symbol] = { ...entry, candles: candles.filter((c) => c.time >= warmFrom) };
  }
  return { working, reserved, cut, from: cut };
}

/**
 * The same question across a grid of settings, then once on data the grid
 * never saw.
 *
 * Reported as a grid, not as a winner. With enough cells one of them always
 * looks excellent, and quoting that one is how a backtest becomes fiction — so
 * the share of cells that beat the benchmark is printed next to the best cell,
 * because a real effect shows up broadly and a fitted one shows up once.
 *
 * And then the best cell is re-run on the reserved tail. That number is the
 * only one in this report that was not chosen after the fact, which makes it
 * the only one worth acting on — including when it disagrees with the grid.
 */
export function crossGrid(dataBySymbol, {
  lookbacks = [10, 20, 40, 60], holds = [5, 10, 20], topKs = [3, 5],
  mode = 'longOnly', costs = COSTS, replicates = 200, holdoutRatio = 0.3,
} = {}) {
  const split = holdoutRatio > 0 ? splitByTime(dataBySymbol, {
    ratio: holdoutRatio, warmupBars: Math.max(...lookbacks) + Math.max(...holds),
  }) : null;
  const tuning = split ? split.working : dataBySymbol;

  const cells = [];
  for (const lookback of lookbacks) {
    for (const hold of holds) {
      for (const topK of topKs) {
        const r = crossSectional(tuning, { lookback, hold, topK, mode, costs, replicates });
        if (r) cells.push(r);
      }
    }
  }
  if (!cells.length) return null;

  const beating = cells.filter((c) => c.excessAnnualPct > 0);
  const strong = cells.filter((c) => c.verdict === 'edge');
  const best = cells.reduce((a, b) => (a.excessAnnualPct >= b.excessAnnualPct ? a : b));

  // The grid picked these settings; the reserved slice had no say in it.
  const holdout = split ? crossSectional(split.reserved, {
    lookback: best.params.lookback, hold: best.params.hold, topK: best.params.topK,
    mode, costs, replicates, startAt: split.from,
  }) : null;

  return {
    cells: cells.map((c) => ({
      ...c.params,
      annualPct: c.strategy.annualPct,
      benchmarkPct: c.benchmark?.annualPct ?? null,
      excessAnnualPct: c.excessAnnualPct,
      nullPercentile: c.nullPercentile,
      verdict: c.verdict,
    })),
    total: cells.length,
    beatingBenchmark: beating.length,
    withEdge: strong.length,
    best,
    holdout,
    holdoutText: holdoutText(best, holdout),
    text: strong.length
      ? `Из ${cells.length} наборов настроек ${strong.length} обыгрывают и удержание всех монет, ` +
        'и перемешанный контроль. Настоящий эффект проявляется широко — единичная ячейка была ' +
        'бы подгонкой.'
      : `Ни один из ${cells.length} наборов настроек не обыграл одновременно удержание всех монет ` +
        `и перемешанный контроль (дрейф обогнали ${beating.length}). Это не вопрос настройки: ` +
        'ранжирование по импульсу здесь не несёт информации.',
  };
}

function holdoutText(best, holdout) {
  if (!holdout) return 'Отложенный кусок не проверялся.';
  const inSample = best.excessAnnualPct?.toFixed(1);
  const out = holdout.excessAnnualPct?.toFixed(1);
  const head = `Лучшая ячейка сетки (${best.params.lookback}/${best.params.hold}/${best.params.topK}) ` +
    `обыгрывала удержание всех монет на ${inSample} п.п. годовых на подгоночном куске ` +
    `и на ${out} п.п. на отложенном.`;

  if (!(holdout.excessAnnualPct > 0)) {
    return `${head} То есть на данных, которых сетка не видела, преимущество исчезло — ` +
      'ровно так выглядит подгонка, и именно поэтому кусок откладывался заранее.';
  }
  if (holdout.verdict === 'edge') {
    return `${head} Преимущество пережило отложенный кусок и там же обыграло случайный выбор. ` +
      'Это единственная проверка здесь, результат которой не выбирали задним числом.';
  }
  return `${head} Знак сохранился, но против случайных наборов на отложенном куске это лишь ` +
    `${holdout.nullPercentile?.toFixed(0) ?? '—'}-й процентиль — то есть отличить от везения пока нельзя.`;
}
