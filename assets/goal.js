/**
 * The goal, as arithmetic.
 *
 * WHY THIS EXISTS
 *
 * The goal of this project was finally stated as a number: put in $100 a month,
 * reinvest everything, earn $50,000 a year. That is a good way to state a goal,
 * because a number can be checked — and checking it turns out to answer
 * questions that months of strategy work could not.
 *
 * The central identity is unglamorous:
 *
 *     annual income = capital × rate
 *
 * $50,000 a year is not a property of a strategy. It is a property of a capital
 * stack. At 10% it needs half a million dollars; at 50% it needs a hundred
 * thousand. Contributions of $1,200 a year have to become that, and the only
 * things that turn a small flow into a large stock are time and rate.
 *
 * WHAT THE ARITHMETIC KEEPS SAYING
 *
 * Two facts fall out immediately, and both are worth more than any backtest in
 * this repository:
 *
 *  1. The target income is 42× the annual contribution. No arrangement of a
 *     small flow reaches that quickly at any rate anyone can actually earn.
 *  2. A NEGATIVE rate has a ceiling that time cannot pass. Contributing $100 a
 *     month into something that loses 10% a year converges on $11,440 and stops
 *     — forever, not eventually. The strategy this project started with was
 *     measured at roughly that, which makes the ceiling the single most
 *     important number the project has produced.
 *
 * This module computes, it does not advise. Every function here is a closed
 * form or a bisection, and the results are as good or as bad as the rate handed
 * in — which is exactly the point: the rate is the assumption, and it is the
 * one thing that has to survive measurement rather than optimism.
 */

/** Effective monthly rate from an annual percentage. */
export function monthlyRate(annualPct) {
  const r = annualPct / 100;
  if (!Number.isFinite(r) || r <= -1) return null;
  return (1 + r) ** (1 / 12) - 1;
}

/**
 * Capital after `months` of contributing `monthly`, everything reinvested.
 *
 * Contributions are treated as arriving at the END of each month, which is the
 * conservative reading: assuming they arrive at the start credits a month of
 * growth that has not happened yet, and over forty years that flatters the
 * result by a whole contribution's worth of compounding.
 */
export function futureValue({ monthly, annualPct, months }) {
  const m = monthlyRate(annualPct);
  if (m == null || !(monthly >= 0) || !(months >= 0)) return null;
  if (Math.abs(m) < 1e-12) return monthly * months;
  return monthly * (((1 + m) ** months - 1) / m);
}

/**
 * The ceiling a losing rate imposes.
 *
 * At a negative rate the pot converges: each month the loss on the existing
 * balance grows until it exactly eats the new contribution, and after that
 * nothing accumulates however long you wait. `monthly / |m|` is where that
 * happens.
 *
 * This is the number that decides whether a plan is slow or impossible, and
 * they are not the same kind of problem. A slow plan is fixed with time or a
 * bigger contribution; an impossible one is not fixed at all.
 */
export function ceilingAt(annualPct, monthly) {
  const m = monthlyRate(annualPct);
  if (m == null || !(m < 0)) return null;      // no ceiling at zero or above
  return monthly / -m;
}

/** Capital required to throw off `incomePerYear` at `annualPct`. */
export function capitalForIncome({ incomePerYear, annualPct }) {
  const r = annualPct / 100;
  if (!(r > 0) || !(incomePerYear > 0)) return null;
  return incomePerYear / r;
}

/**
 * Months of contributing `monthly` before the pot reaches `target`.
 *
 * Returns null when the target is out of reach rather than a huge number: at a
 * losing rate "never" is the honest answer, and a figure like 9000 months
 * invites the reading "long" when the truth is "not at all".
 */
export function monthsToCapital({ monthly, annualPct, target }) {
  if (!(monthly > 0) || !(target > 0)) return null;
  const m = monthlyRate(annualPct);
  if (m == null) return null;
  if (Math.abs(m) < 1e-12) return target / monthly;
  if (m < 0) {
    const cap = monthly / -m;
    if (target >= cap) return null;            // converges below the target
  }
  return Math.log(1 + (target * m) / monthly) / Math.log(1 + m);
}

/** Months until the pot is large enough to earn `incomePerYear`. */
export function monthsToIncome({ monthly, annualPct, incomePerYear }) {
  const target = capitalForIncome({ incomePerYear, annualPct });
  if (target == null) return null;
  return monthsToCapital({ monthly, annualPct, target });
}

/** The contribution that reaches `target` in exactly `months`. */
export function requiredMonthly({ annualPct, months, target }) {
  const m = monthlyRate(annualPct);
  if (m == null || !(months > 0) || !(target > 0)) return null;
  if (Math.abs(m) < 1e-12) return target / months;
  return target / (((1 + m) ** months - 1) / m);
}

/**
 * The annual return that would hit the income target in the time allowed.
 *
 * Solved by bisection because the equation — capital(r) × r = income — has no
 * closed form. Capped at 1000%/yr, and a target needing more than that comes
 * back as null: past a certain point the answer is not a number but "no".
 */
export function requiredReturn({ monthly, months, incomePerYear, maxPct = 1000 }) {
  if (!(monthly > 0) || !(months > 0) || !(incomePerYear > 0)) return null;
  const incomeAt = (pct) => {
    const cap = futureValue({ monthly, annualPct: pct, months });
    return cap == null ? -Infinity : cap * (pct / 100);
  };
  if (incomeAt(maxPct) < incomePerYear) return null;

  let lo = 0;
  let hi = maxPct;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (incomeAt(mid) < incomePerYear) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * What volatility costs a compounding pot.
 *
 * This is where chasing a big number stops being free. Compounding grows the
 * GEOMETRIC mean, not the arithmetic one, and the gap between them is roughly
 * half the variance. A strategy averaging +25% a year with a 60% swing
 * compounds at about +7%; the same average with a 100% swing compounds at
 * negative. Nothing is wrong with the average — it is just not the thing that
 * multiplies.
 *
 * Which is why "we need 50% a year" is not a target you can simply aim at. The
 * volatility that comes with reaching for it is subtracted from the very
 * compounding it was meant to feed.
 */
export function volatilityDrag({ arithmeticPct, sdPct }) {
  const a = arithmeticPct / 100;
  const s = sdPct / 100;
  if (!Number.isFinite(a) || !Number.isFinite(s) || s < 0) return null;
  const geometric = a - (s * s) / 2;
  return {
    arithmeticPct,
    sdPct,
    geometricPct: geometric * 100,
    dragPct: ((s * s) / 2) * 100,
    // Below zero the pot shrinks in the long run no matter how good the average
    // looks in any single year.
    compoundsNegative: geometric < 0,
  };
}

/**
 * One row of the table the question deserves: at this rate, how long.
 *
 * `reachable` is separated from the duration deliberately. A plan that takes
 * forty years and a plan that never arrives both return "not soon", and
 * collapsing them into one big number is how an impossible plan gets mistaken
 * for a patient one.
 */
export function horizonAt({ monthly, annualPct, incomePerYear }) {
  const target = capitalForIncome({ incomePerYear, annualPct });
  const months = monthsToIncome({ monthly, annualPct, incomePerYear });
  const ceiling = ceilingAt(annualPct, monthly);
  return {
    annualPct,
    targetCapital: target,
    months,
    years: months == null ? null : months / 12,
    reachable: months != null,
    ceiling,
    // The capital milestone is a far easier question than the income one, and
    // showing both stops the harder number from reading as the only number.
    monthsToSameSizedPot: monthsToCapital({ monthly, annualPct, target: incomePerYear }),
  };
}

/**
 * The whole picture for one plan.
 *
 * Deliberately returns the contribution sensitivity alongside the rate
 * sensitivity. The rate is a claim that has to survive measurement; the
 * contribution is a decision that is certain the moment it is made. A report
 * showing only rates invites the reader to solve the problem with the one lever
 * they cannot actually pull.
 */
export function plan({
  monthly = 100, incomePerYear = 50000,
  rates = [-10, 0, 5, 10, 15, 20, 30, 50, 100],
  contributions = [100, 250, 500, 1000, 2500],
  horizonYears = 20,
  measuredPct = null,
} = {}) {
  const byRate = rates.map((annualPct) => horizonAt({ monthly, annualPct, incomePerYear }));

  const byContribution = contributions.map((amount) => ({
    monthly: amount,
    years: (() => {
      const m = monthsToIncome({ monthly: amount, annualPct: 10, incomePerYear });
      return m == null ? null : m / 12;
    })(),
    capitalAtHorizon: futureValue({ monthly: amount, annualPct: 10, months: horizonYears * 12 }),
  }));

  return {
    monthly,
    incomePerYear,
    horizonYears,
    // The ratio that explains the whole difficulty in one number.
    incomeToContribution: incomePerYear / (monthly * 12),
    byRate,
    byContribution,
    neededForHorizon: requiredReturn({
      monthly, months: horizonYears * 12, incomePerYear,
    }),
    measured: measuredPct == null ? null : horizonAt({
      monthly, annualPct: measuredPct, incomePerYear,
    }),
  };
}
