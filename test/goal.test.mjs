/**
 * The goal, as arithmetic.
 *
 * This suite matters more than its size suggests. Every other number in this
 * project is an estimate about markets and could be wrong for interesting
 * reasons; these are closed forms, and if one of them is wrong it is wrong
 * silently, in the direction of whoever wrote it.
 *
 * So the central test is not a hand-checked constant — it is a month-by-month
 * loop. A dumb simulation cannot share an algebra error with the formula it
 * checks, which is the entire reason to keep one around.
 */
import { makeChecker, close } from './helpers.mjs';
import {
  monthlyRate, futureValue, ceilingAt, capitalForIncome, monthsToCapital,
  monthsToIncome, requiredMonthly, requiredReturn, volatilityDrag, horizonAt, plan,
} from '../assets/goal.js';

const results = [];
const check = makeChecker(results);

/** The formula's opponent: contributions added one month at a time. */
function simulate({ monthly, annualPct, months }) {
  const m = monthlyRate(annualPct);
  let pot = 0;
  for (let i = 0; i < months; i++) pot = pot * (1 + m) + monthly;
  return pot;
}

/* ------------------------------ the rate ------------------------------ */

check('a monthly rate compounds back to its annual one',
  close((1 + monthlyRate(10)) ** 12 - 1, 0.10, 1e-12));
check('zero stays zero', monthlyRate(0) === 0);
check('a losing year gives a losing month', monthlyRate(-10) < 0);
check('losing everything and more is refused rather than returned as NaN',
  monthlyRate(-100) === null && monthlyRate(-150) === null);

/* --------------------------- the closed form -------------------------- */

{
  /*
   * The check that earns its keep. If the closed form and the loop disagree,
   * one of them is wrong — and a table of years built on a wrong formula would
   * look exactly as authoritative as a right one.
   */
  let worst = 0;
  for (const annualPct of [-20, -5, 0, 5, 10, 30, 100]) {
    for (const months of [1, 12, 120, 480]) {
      const formula = futureValue({ monthly: 100, annualPct, months });
      const looped = simulate({ monthly: 100, annualPct, months });
      worst = Math.max(worst, Math.abs(formula - looped) / Math.max(1, looped));
    }
  }
  check('the closed form matches a month-by-month simulation everywhere tested',
    worst < 1e-9);
}

check('at zero return the pot is just the money put in',
  close(futureValue({ monthly: 100, annualPct: 0, months: 120 }), 12000, 1e-9));
check('no months means no money',
  futureValue({ monthly: 100, annualPct: 10, months: 0 }) === 0);

/* ------------------------- the ceiling that bites --------------------- */

{
  /*
   * The single most important number this module computes, and the one most
   * likely to be dismissed as pessimism rather than arithmetic. At a losing
   * rate the pot converges: eventually the loss on the balance eats the whole
   * contribution and nothing accumulates, however long you wait.
   *
   * Verified against the loop rather than asserted, because "it converges" is
   * exactly the kind of claim that deserves a demonstration.
   */
  const ceiling = ceilingAt(-10, 100);
  const far = simulate({ monthly: 100, annualPct: -10, months: 12000 });
  check('a losing rate converges on the ceiling the formula predicts',
    close(far / ceiling, 1, 1e-6));
  check('and a thousand years does not get past it',
    simulate({ monthly: 100, annualPct: -10, months: 12000 }) < ceiling * 1.000001);
  check('the ceiling is where the loss exactly eats the contribution',
    close(ceiling * -monthlyRate(-10), 100, 1e-9));

  check('a winning rate has no ceiling at all',
    ceilingAt(10, 100) === null && ceilingAt(0, 100) === null);

  check('a target above the ceiling is reported as unreachable, not as slow',
    monthsToCapital({ monthly: 100, annualPct: -10, target: 50000 }) === null);
  check('a target below it is still reached',
    monthsToCapital({ monthly: 100, annualPct: -10, target: 5000 }) > 0);
}

/* ------------------------- income needs capital ----------------------- */

check('income is capital times rate, so the capital is income over rate',
  close(capitalForIncome({ incomePerYear: 50000, annualPct: 10 }), 500000, 1e-9));
check('at a higher rate the same income needs less capital',
  capitalForIncome({ incomePerYear: 50000, annualPct: 50 })
    < capitalForIncome({ incomePerYear: 50000, annualPct: 10 }));
check('a zero or losing rate never throws off an income',
  capitalForIncome({ incomePerYear: 50000, annualPct: 0 }) === null
    && capitalForIncome({ incomePerYear: 50000, annualPct: -5 }) === null);

/* ------------------------------ round trips --------------------------- */

{
  /*
   * Each solver is checked by feeding its answer back into the thing it
   * inverts. A solver that is confidently wrong passes every test written in
   * its own terms, and fails this one.
   */
  for (const annualPct of [5, 10, 30]) {
    const months = monthsToCapital({ monthly: 100, annualPct, target: 250000 });
    check(`at ${annualPct}% the horizon it returns really does reach the target`,
      close(futureValue({ monthly: 100, annualPct, months }) / 250000, 1, 1e-9));
  }

  const need = requiredMonthly({ annualPct: 10, months: 360, target: 500000 });
  check('the contribution it demands really does arrive on time',
    close(futureValue({ monthly: need, annualPct: 10, months: 360 }) / 500000, 1, 1e-9));

  const rate = requiredReturn({ monthly: 100, months: 240, incomePerYear: 50000 });
  const pot = futureValue({ monthly: 100, annualPct: rate, months: 240 });
  check('the return it demands really does throw off the income',
    close((pot * (rate / 100)) / 50000, 1, 1e-6));

  const months = monthsToIncome({ monthly: 100, annualPct: 10, incomePerYear: 50000 });
  check('and the income horizon lands on capital × rate = income',
    close(futureValue({ monthly: 100, annualPct: 10, months }) * 0.10 / 50000, 1, 1e-9));
}

check('an income no rate under 1000% can deliver in the time given says so',
  requiredReturn({ monthly: 100, months: 12, incomePerYear: 50000 }) === null);

/* ----------------------- what the answer actually is ------------------ */

{
  /*
   * The result the whole module exists to produce, pinned so it cannot drift
   * quietly: $100 a month, everything reinvested, $50,000 a year of income.
   */
  const at10 = horizonAt({ monthly: 100, annualPct: 10, incomePerYear: 50000 });
  check('at a realistic 10% a year the answer is about four decades',
    at10.years > 38 && at10.years < 40);

  const at100 = horizonAt({ monthly: 100, annualPct: 100, incomePerYear: 50000 });
  check('even doubling every single year takes about five',
    at100.years > 4.5 && at100.years < 5.5);

  /*
   * The asymmetry that reframes the question: reaching a $50,000 POT is a far
   * smaller task than reaching a $50,000 INCOME, and showing only the second
   * makes the goal look hopeless when half of it is merely long.
   */
  check('a pot the size of the target income arrives in well under half the time',
    at10.monthsToSameSizedPot < at10.months / 2);
}

/* -------------------- volatility is subtracted, not free -------------- */

{
  /*
   * Why "we need 50% a year" is not a target one can simply aim at. Compounding
   * grows the geometric mean, and the gap to the arithmetic one is roughly half
   * the variance — so the swing that comes with reaching for a big number is
   * taken back out of the compounding it was meant to feed.
   */
  const calm = volatilityDrag({ arithmeticPct: 25, sdPct: 60 });
  const wild = volatilityDrag({ arithmeticPct: 25, sdPct: 100 });
  check('the same average return compounds worse when it swings more',
    wild.geometricPct < calm.geometricPct);
  check('and past a point it compounds negative despite a positive average',
    calm.compoundsNegative === false && wild.compoundsNegative === true);
  check('with no swing at all the two means coincide',
    close(volatilityDrag({ arithmeticPct: 25, sdPct: 0 }).geometricPct, 25, 1e-9));
  check('the drag is exactly half the variance',
    close(wild.dragPct, 50, 1e-9));
}

/* -------------------------------- the plan ---------------------------- */

{
  const p = plan({ monthly: 100, incomePerYear: 50000, measuredPct: -10 });

  check('the plan states the ratio that explains the difficulty',
    close(p.incomeToContribution, 50000 / 1200, 1e-9));
  check('every rate asked about comes back with a verdict',
    p.byRate.length === 9 && p.byRate.every((r) => 'reachable' in r));
  check('the losing rate among them is marked unreachable',
    p.byRate.find((r) => r.annualPct === -10).reachable === false);

  /*
   * The contribution table exists because the rate is a claim that must survive
   * measurement while the contribution is certain the moment it is decided. A
   * report offering only rates invites solving the problem with the one lever
   * that cannot actually be pulled.
   */
  check('contributions are shown alongside rates, not instead of them',
    p.byContribution.length === 5
      && p.byContribution.every((c) => c.years > 0));
  check('and more per month always arrives sooner',
    p.byContribution.every((c, i) => i === 0 || c.years < p.byContribution[i - 1].years));

  check('the measured rate of this project is carried into the plan',
    p.measured.annualPct === -10 && p.measured.reachable === false);
  check('the rate needed to hit the horizon is reported as a number, not a hope',
    Number.isFinite(p.neededForHorizon) && p.neededForHorizon > 0);
}

/* ------------------------------- refusals ----------------------------- */

check('a contribution of nothing reaches nothing',
  monthsToCapital({ monthly: 0, annualPct: 10, target: 1000 }) === null);
check('a target of nothing is not a question',
  monthsToCapital({ monthly: 100, annualPct: 10, target: 0 }) === null);
check('nonsense in is refused rather than passed through',
  futureValue({ monthly: 100, annualPct: -200, months: 12 }) === null
    && requiredMonthly({ annualPct: 10, months: 0, target: 1000 }) === null);

/* ------------------------------- the page ----------------------------- */

{
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../assets/goal-view.js', import.meta.url), 'utf8');

  check('the site has a tab for it and a view to render into',
    /data-view="goal"/.test(html) && /id="view-goal"/.test(html));
  check('every box the view fills exists in the markup',
    ['goalVerdict', 'goalRateBox', 'goalHorizonBox', 'goalContributionBox',
      'goalDragBox', 'goalMeta', 'goalMonthly', 'goalIncome']
      .every((id) => html.includes(`id="${id}"`)));
  check('the page loads it as a module, so it can share the tested math',
    /type="module" src="assets\/goal-view\.js"/.test(html));

  /*
   * The point of the whole arrangement. If the page reimplemented the formulas
   * they would drift from the ones the suite above verifies, and the site would
   * show numbers this project has never checked.
   */
  check('the view imports the arithmetic rather than restating it',
    /from '\.\/goal\.js'/.test(view)
      && !/Math\.pow\(1 \+ r, 1 \/ 12\)/.test(view));

  check('rates are labelled with what claiming them would mean',
    /хедж-фонда/.test(view) && /измерено у сигнальной стратегии/.test(view));
  check('an unreachable horizon reads as never, not as a huge number',
    /'никогда'/.test(view) && /невозможно/.test(view));
  check('the contribution lever is shown next to the rate one',
    /contributionTable/.test(view) && /CONTRIBUTIONS/.test(view));
  check('the page needs no exchange data, no scan and no workflow',
    !/fetch\(/.test(view) && !/data\//.test(view));

  check('the suite is registered in the runner',
    readFileSync(new URL('./run.mjs', import.meta.url), 'utf8').includes('goal.test.mjs'));
}

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
