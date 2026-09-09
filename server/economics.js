/**
 * The arithmetic that decides whether any strategy on this timeframe can work
 * — before a single indicator is considered.
 *
 * Costs are charged as a fraction of PRICE. Results are measured in R, a
 * fraction of the STOP DISTANCE. So the toll a trade pays, expressed in R, is:
 *
 *     costR  =  round-trip cost %  /  stop distance %
 *
 * That ratio is the whole story, and it is fixed by the timeframe and the stop
 * multiple, not by the signal. On 1h candles an ATR-scaled stop is on the order
 * of 1–2% of price, and a round trip costs about 0.2%, so every trade starts
 * roughly 0.13R in the hole. An edge has to exceed that before it earns
 * anything at all — and 0.13R per trade is a very large edge by any published
 * standard.
 *
 * This is the most useful thing measured in the whole project, because it
 * disqualifies a design before any work is spent on the signal logic. Widening
 * the stop or moving to a slower timeframe changes the denominator by a factor
 * of several; tuning thresholds does not change it at all.
 */
import { summarize, netR, COSTS } from './backtest.js';
import { atr } from './indicators.js';
import { config } from './config.js';

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* --------------------------- Cost sensitivity ------------------------- */

/**
 * How much of the result is fees and slippage?
 *
 * Exits do not move when costs change — a stop is hit at the same price
 * regardless — so every trade can simply be re-priced. The interesting number
 * is the frictionless one: if a strategy loses money at zero cost, execution
 * was never the problem and no cheaper venue will save it.
 */
export function costSensitivity(trades, levels = null) {
  if (!trades.length) return null;
  const priced = (costs) => summarize(trades.map((t) => ({
    ...t,
    r: netR({ direction: t.direction, entry: t.entry, stop: t.stop, exit: t.exit }, costs),
  })));

  const rows = (levels || [
    { label: 'Без издержек', feeRate: 0, slippageRate: 0 },
    { label: 'Половина текущих', feeRate: COSTS.feeRate / 2, slippageRate: COSTS.slippageRate / 2 },
    { label: 'Текущие', feeRate: COSTS.feeRate, slippageRate: COSTS.slippageRate },
    { label: 'Вдвое выше', feeRate: COSTS.feeRate * 2, slippageRate: COSTS.slippageRate * 2 },
  ]).map((l) => {
    const s = priced(l);
    return {
      label: l.label, feeRate: l.feeRate, slippageRate: l.slippageRate,
      avgR: s.avgR, totalR: s.totalR, winRate: s.winRate, profitFactor: s.profitFactor,
    };
  });

  const free = rows.find((r) => r.feeRate === 0 && r.slippageRate === 0);
  const current = rows.find((r) => r.label === 'Текущие');

  let text = null;
  if (free && current) {
    const eaten = free.totalR - current.totalR;
    if (free.totalR <= 0) {
      text = `Даже при нулевых издержках стратегия теряет ${Math.abs(free.totalR).toFixed(1)}R. ` +
        'Комиссия и проскальзывание тут ни при чём — дешёвая биржа не спасёт то, ' +
        'у чего нет преимущества до всяких издержек.';
    } else if (current.totalR > 0) {
      text = `Преимущество переживает издержки: ${free.totalR.toFixed(1)}R без них и ` +
        `${current.totalR.toFixed(1)}R с ними. Комиссия и проскальзывание съедают ` +
        `${eaten.toFixed(1)}R — это ${((eaten / free.totalR) * 100).toFixed(0)}% сырого результата, ` +
        'и настолько же чувствителен итог к качеству исполнения.';
    } else {
      text = `Преимущество есть до издержек (${free.totalR.toFixed(1)}R), но они его съедают ` +
        `целиком: с текущими выходит ${current.totalR.toFixed(1)}R. Это вопрос исполнения — ` +
        'более дешёвая площадка или менее частые входы могут изменить исход, ' +
        'в отличие от случая, когда минус есть и без издержек.';
    }
  }

  return { rows, text, frictionlessTotalR: free?.totalR ?? null };
}

/* ------------------------------- The toll ----------------------------- */

/** Round-trip cost as a fraction of price: two fees and two slippages. */
export function roundTripCost(costs = COSTS) {
  return costs.feeRate * 2 + costs.slippageRate * 2;
}

/**
 * The toll actually paid, measured from the trades themselves rather than
 * assumed: the median stop distance decides it.
 */
export function tollFromTrades(trades, costs = COSTS) {
  const risks = trades
    .map((t) => Math.abs(t.entry - t.stop) / t.entry)
    .filter((v) => Number.isFinite(v) && v > 0);
  if (!risks.length) return null;

  const riskPct = median(risks);
  const trip = roundTripCost(costs);
  const costR = trip / riskPct;
  return {
    medianRiskPct: riskPct * 100,
    roundTripPct: trip * 100,
    costR,
    /*
     * What a strategy has to produce, per trade, before costs, merely to end
     * at zero. Quoting it in R makes it directly comparable to any published
     * edge — and shows how demanding this design is.
     */
    breakEvenEdgeR: costR,
  };
}

/* --------------------------- Win rate vs money ------------------------ */

/**
 * What a demanded win rate actually costs.
 *
 * "We need 80–90% of signals to be successful" is a request that can always be
 * granted and is almost always worthless, and this is the calculation that
 * shows why. Move the target close enough to the entry and nearly every trade
 * reaches it: with a stop at 1R and a target at 0.2R, price only has to move a
 * fifth as far in your favour as against you, so most trades win. What you
 * collect on each win shrinks in exact proportion.
 *
 * The break-even win rate for a target T, once the toll is paid, is
 *
 *     p =  (1 + toll)  /  (1 + T)
 *
 * and the trap is that this required rate rises FASTER than the achievable one
 * as the target comes in. At T=2 you need 38%; at T=0.5 you need 77%; at T=0.25
 * you need 92%. So a strategy proudly winning 85% of the time at a 0.25R target
 * is losing money, and losing it while looking excellent.
 *
 * The achievable side is measured, not modelled: a trade would have hit target
 * T exactly when its favourable excursion reached T before the stop bar, which
 * is what mfeR records. Every trade is then re-priced at that target and the
 * real expectancy computed.
 *
 * One honest limit: changing the target changes when trades end, and with one
 * position per symbol that shifts which later trades exist at all. This curve
 * holds the trade set fixed, so it is an estimate. The exact answer comes from
 * re-running the whole strategy at each target — which the parameter grid does.
 */
export function winRateCurve(trades, {
  /*
   * The near end of this range exists to answer the question people actually
   * ask — "make 80–90% of signals win" — instead of stopping short of it and
   * reporting "not achievable". At those targets the required break-even rate
   * passes 100%, which is the clearest possible statement: the demand is not
   * demanding, it is arithmetically impossible at this toll.
   */
  targets = [0.1, 0.15, 0.2, 0.25, 0.5, 0.75, 1, 1.5, 2], costs = COSTS,
} = {}) {
  const usable = trades.filter((t) => Number.isFinite(t.mfeR) && Number.isFinite(t.entry));
  if (usable.length < 50) return null;

  const toll = tollFromTrades(usable, costs);
  const tollR = toll?.costR ?? 0;

  // MFE is censored at the target a winner actually used, so a target beyond
  // it cannot be evaluated from this data — say so rather than extrapolate.
  const ceiling = Math.max(...usable.map((t) => t.mfeR));

  const rows = targets.filter((T) => T <= ceiling + 1e-9).map((T) => {
    let wins = 0;
    let totalR = 0;
    for (const t of usable) {
      const risk = Math.abs(t.entry - t.stop);
      const long = t.direction === 'LONG';
      const hit = t.mfeR >= T;
      if (hit) wins++;
      const exit = hit ? (long ? t.entry + risk * T : t.entry - risk * T) : t.exit;
      if (!Number.isFinite(exit)) continue;
      totalR += netR({ direction: t.direction, entry: t.entry, stop: t.stop, exit }, costs);
    }
    const winRate = wins / usable.length;
    const required = (1 + tollR) / (1 + T);
    return {
      target: T,
      winRate,
      requiredWinRate: required,
      gap: winRate - required,
      avgR: totalR / usable.length,
      totalR,
      profitable: totalR > 0,
      /*
       * Once the target is close enough, break-even needs to win more often
       * than always. No strategy, no filter and no amount of accuracy reaches
       * it — the target itself has made the trade unwinnable.
       */
      impossible: required > 1,
    };
  });

  if (!rows.length) return null;

  // Where a demanded win rate lands, and what it is worth there.
  const forRate = (want) => {
    const reachable = rows.filter((r) => r.winRate >= want);
    return reachable.length ? reachable[reachable.length - 1] : null;
  };

  const high = forRate(0.8);
  const best = rows.reduce((a, b) => (a.avgR >= b.avgR ? a : b));
  const impossibleFrom = rows.filter((r) => r.impossible).sort((a, b) => b.target - a.target)[0];

  const text = high
    ? `Цель ${high.target}R даёт ${(high.winRate * 100).toFixed(0)}% успешных сигналов — ` +
      `и ${high.avgR >= 0 ? '+' : ''}${high.avgR.toFixed(3)}R на сделку. ` +
      `Чтобы при такой цели выйти в ноль, побеждать надо в ` +
      `${(high.requiredWinRate * 100).toFixed(0)}% случаев. ` +
      (high.avgR > 0
        ? 'Здесь высокий винрейт действительно окупается.'
        : '**Высокий винрейт достигнут и убыточен.** Чем ближе цель, тем чаще выигрыш и тем ' +
          'выше требуемый порог — требование растёт быстрее достижимого.') +
      (impossibleFrom
        ? ` А начиная с цели ${impossibleFrom.target}R безубыток требует ` +
          `${(impossibleFrom.requiredWinRate * 100).toFixed(0)}% побед — больше, чем всегда. ` +
          'Такую цель не спасёт никакая точность сигнала: она сделана невыигрышной ' +
          'самой геометрией.'
        : '')
    : 'Даже самая близкая из проверенных целей не даёт 80% успешных сигналов на этих данных.';

  return {
    rows, best, tollR,
    demanded80: high,
    text,
    note: 'Винрейт и прибыльность — почти независимые величины. Один сигнал с 90% успеха и ' +
      'целью 0.2R теряет деньги; один с 35% успеха и целью 3R зарабатывает. Значение имеет ' +
      'только средний R на сделку.',
  };
}

/**
 * The same toll at other timeframes, computed from real volatility.
 *
 * The point is the denominator: a stop scaled to a 1d ATR is several times
 * wider than one scaled to a 1h ATR, so the identical fee becomes a far
 * smaller share of the risk. This is the one lever in the design that moves
 * the arithmetic by a factor rather than a few percent.
 */
export function tollByTimeframe(candlesByTimeframe, {
  atrMult = config.strategy.atrStopMult, costs = COSTS, period = 14,
} = {}) {
  const trip = roundTripCost(costs);
  const rows = [];

  for (const [timeframe, bySymbol] of Object.entries(candlesByTimeframe)) {
    const pcts = [];
    for (const candles of Object.values(bySymbol)) {
      if (!candles || candles.length < period + 5) continue;
      const a = atr(candles.map((c) => c.high), candles.map((c) => c.low),
        candles.map((c) => c.close), period);
      for (let i = 0; i < candles.length; i++) {
        const v = a[i];
        if (Number.isFinite(v) && candles[i].close > 0) pcts.push(v / candles[i].close);
      }
    }
    if (!pcts.length) continue;

    const atrPct = median(pcts);
    const stopPct = atrPct * atrMult;
    rows.push({
      timeframe,
      medianAtrPct: atrPct * 100,
      stopPct: stopPct * 100,
      costR: trip / stopPct,
    });
  }

  if (!rows.length) return null;

  const base = rows.find((r) => r.timeframe === config.timeframe) || rows[0];
  const best = rows.reduce((a, b) => (a.costR <= b.costR ? a : b));

  /*
   * Real markets are not scale-invariant: a daily range is several times a
   * hourly one, so the tolls should differ by a factor. When they come out
   * nearly equal, the data is not telling us the timeframes are equivalent —
   * it is telling us the source cannot distinguish them. The synthetic
   * generator is exactly such a source, and crowning a "cheapest timeframe"
   * separated by rounding would be inventing a finding.
   */
  const spread = Math.max(...rows.map((r) => r.costR)) / Math.min(...rows.map((r) => r.costR));
  const indistinguishable = spread < 1.2;

  const text = indistinguishable
    ? `Пошлина на всех проверенных таймфреймах вышла почти одинаковой ` +
      `(${rows.map((r) => `${r.timeframe} — −${r.costR.toFixed(2)}R`).join(', ')}). ` +
      'На реальном рынке так не бывает: дневной диапазон в разы шире часового. ' +
      'Значит, эти числа получены на источнике, который не различает таймфреймы ' +
      '(генератор для тестов), и делать по ним вывод нельзя.'
    : `На ${base.timeframe} стоп в ${atrMult}×ATR — это примерно ${base.stopPct.toFixed(2)}% от цены, ` +
      `а круговые издержки ${(trip * 100).toFixed(2)}%. Значит, каждая сделка стартует с ` +
      `**−${base.costR.toFixed(2)}R**, и преимущество должно превышать это число, чтобы вообще ` +
      'выйти в ноль. Для сравнения: ' +
      rows.map((r) => `${r.timeframe} — −${r.costR.toFixed(2)}R`).join(', ') + '. ' +
      (best.timeframe === base.timeframe
        ? 'Текущий таймфрейм здесь самый дешёвый из проверенных.'
        : `Переход на ${best.timeframe} снижает пошлину в ` +
          `${(base.costR / best.costR).toFixed(1)} раза — это единственный рычаг в конструкции, ` +
          'который двигает арифметику в разы, а не на проценты. Пороги её не двигают вовсе.');

  return { rows, base, best: indistinguishable ? null : best, text, indistinguishable,
    atrMult, roundTripPct: trip * 100 };
}
