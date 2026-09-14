/**
 * What a trade costs on a coin that is not deeply liquid.
 *
 * The danger in this module is not that it computes a wrong number — it is that
 * every wrong number it could compute makes results look BETTER. Undercharging
 * a thin coin inflates every statistic downstream, silently and in the
 * direction anyone would prefer. So the tests here lean on the safety
 * properties: the curve must never improve where it should worsen, and an
 * unknown coin must never get the cheapest rate.
 */
import { makeChecker, close } from './helpers.mjs';
import {
  slippageFor, costsFor, costsBySymbol, lookupCosts, costGrid, describeUniverse,
  REFERENCE_VOLUME, REFERENCE_SLIPPAGE, MIN_SLIPPAGE, MAX_SLIPPAGE, MIN_VOLUME,
} from '../server/liquidity.js';

const results = [];
const check = makeChecker(results);

/* ------------------------------- the curve ---------------------------- */

check('at the reference turnover it reproduces the inherited assumption exactly',
  close(slippageFor(REFERENCE_VOLUME), REFERENCE_SLIPPAGE, 1e-12));

{
  /*
   * Monotonicity is the property that makes the model honest. If cost ever
   * fell as a coin got thinner, the universe floor could be lowered for free —
   * which is precisely the move this module exists to prevent.
   */
  const volumes = [1e6, 5e6, 10e6, 25e6, 50e6, 100e6, 200e6, 500e6, 2e9];
  const slips = volumes.map(slippageFor);
  check('cost never rises as a coin gets deeper',
    slips.every((s, i) => i === 0 || s <= slips[i - 1] + 1e-15));
  check('and it strictly falls across the unclamped middle',
    slippageFor(10e6) > slippageFor(25e6)
      && slippageFor(25e6) > slippageFor(50e6)
      && slippageFor(50e6) > slippageFor(100e6));
}

{
  /*
   * The square-root shape, stated as a checkable consequence rather than left
   * implicit in the formula: quadrupling turnover halves the cost. If someone
   * later changes the exponent, this is the test that notices.
   */
  const v = 25e6;             // comfortably inside both clamps
  check('four times the turnover is half the slippage',
    close(slippageFor(4 * v) / slippageFor(v), 0.5, 1e-9));
  check('a hundredth of the turnover is ten times the slippage',
    close(slippageFor(1e6) / slippageFor(100e6), 10, 1e-9));
}

check('the deepest pairs stop improving at the spread floor',
  slippageFor(1e12) === MIN_SLIPPAGE && slippageFor(5e9) === MIN_SLIPPAGE);
check('and the thinnest are capped rather than sent to infinity',
  slippageFor(1) === MAX_SLIPPAGE);

/* --------------------- an unknown coin is never cheap ----------------- */

{
  /*
   * The safety property. Missing turnover happens in normal operation — an
   * open signal outlives the universe that admitted it — so this path is
   * reached routinely, not only on error. Defaulting it to the cheapest rate
   * would flatter exactly the trades that are hardest to exit.
   */
  for (const bad of [undefined, null, NaN, 0, -1, 'много']) {
    check(`turnover of ${JSON.stringify(bad)} is charged the worst rate, not the best`,
      slippageFor(bad) === MAX_SLIPPAGE);
  }

  const map = costsBySymbol([{ symbol: 'BTCUSDT', quoteVolume: 699e6 }]);
  check('a symbol in the map gets its own cost',
    close(lookupCosts(map, 'BTCUSDT').slippageRate, slippageFor(699e6), 1e-12));
  check('a symbol missing from the map gets the pessimistic cost',
    lookupCosts(map, 'НЕИЗВЕСТНАЯUSDT').slippageRate === MAX_SLIPPAGE);
  check('and an absent map does not crash into the cheapest rate',
    lookupCosts(null, 'BTCUSDT').slippageRate === MAX_SLIPPAGE
      && lookupCosts(undefined, 'X').slippageRate === MAX_SLIPPAGE);
  check('an explicit fallback is honoured when one is given',
    close(lookupCosts(map, 'X', { feeRate: 0, slippageRate: 0.007 }).slippageRate, 0.007, 1e-12));
}

/* ------------------------------ the fee part -------------------------- */

{
  const deep = costsFor(699e6);
  const thin = costsFor(12e6);
  check('the exchange fee does not vary with liquidity',
    close(deep.feeRate, thin.feeRate, 1e-12));
  check('only slippage does', thin.slippageRate > deep.slippageRate);

  /*
   * The number that matters downstream is the round trip, and the whole point
   * of the change is that it is no longer one number for everyone.
   */
  const trip = (c) => (c.feeRate + c.slippageRate) * 2;
  check('a thin coin costs meaningfully more per round trip than a deep one',
    trip(thin) > trip(deep) * 1.5);
}

/* ---------------------- per-symbol costs from a universe -------------- */

{
  const universe = [
    { symbol: 'BTCUSDT', quoteVolume: 699e6 },
    { symbol: 'SOLUSDT', quoteVolume: 147e6 },
    { symbol: 'SUIUSDT', quoteVolume: 40e6 },
  ];
  const map = costsBySymbol(universe);
  check('every coin in the universe gets a cost', Object.keys(map).length === 3);
  check('and they differ, which is the entire point',
    map.SUIUSDT.slippageRate > map.SOLUSDT.slippageRate
      && map.SOLUSDT.slippageRate > map.BTCUSDT.slippageRate);
  check('a malformed row is skipped rather than poisoning the map',
    Object.keys(costsBySymbol([...universe, null, {}, { quoteVolume: 5 }])).length === 3);

  /*
   * Serialisable on purpose: a run that charged different coins different costs
   * must be able to show what it charged each one, or its totals are
   * unauditable.
   */
  check('the map survives a round trip through JSON',
    JSON.parse(JSON.stringify(map)).SUIUSDT.slippageRate === map.SUIUSDT.slippageRate);
}

/* ------------------------- sensitivity, not a number ------------------ */

{
  /*
   * The exponent is borrowed and the anchor is inherited, so a single run
   * reports a precision it has not earned. These three cases are the whole
   * reason the grid exists: a result that flips inside the plausible range is
   * a statement about the assumption, not about the market.
   */
  const alwaysGood = costGrid(() => 5);
  check('a result that holds everywhere is called robust',
    alwaysGood.verdict === 'robust' && alwaysGood.positive === alwaysGood.total);

  const alwaysBad = costGrid(() => -5);
  check('a result that fails everywhere says so instead of hedging',
    alwaysBad.verdict === 'negative-throughout' && alwaysBad.positive === 0);
  check('and notes that softening the cost model will not save it',
    /не спасёт/.test(alwaysBad.text));

  /*
   * A gross edge of +0.25%, which sits deliberately INSIDE the grid: the
   * cheapest round trip here is 0.16% and the dearest 0.70%, so this survives
   * the optimistic end and dies at the pessimistic one. Picking a value below
   * the whole range (my first attempt) tests nothing — it is negative
   * everywhere and the grid correctly says so.
   */
  const borderline = costGrid(({ feeRate, slippageRate }) =>
    0.0025 - (feeRate + slippageRate) * 2);
  check('a result that flips inside the range is called fragile',
    borderline.verdict === 'fragile'
      && borderline.positive > 0 && borderline.positive < borderline.total);
  check('and is reported as being about the assumption, not about the market',
    /не о рынке/.test(borderline.text));

  check('the grid shows the round trip it charged in each cell',
    borderline.cells.every((c) => c.roundTripPct > 0)
      && borderline.cells[0].roundTripPct < borderline.cells[borderline.cells.length - 1].roundTripPct);
  check('a measure that never returns a number yields no grid at all',
    costGrid(() => NaN) === null);
}

/* ------------------------------ the universe -------------------------- */

{
  /*
   * The real distribution, measured on 2026-09-14 across 3701 pairs. Kept as a
   * test because the floor was moved on the strength of these numbers, and if
   * the shape of the world changes the reason for the floor changes with it.
   */
  const universe = [
    { symbol: 'BTCUSDT', quoteVolume: 699e6 }, { symbol: 'ETHUSDT', quoteVolume: 597e6 },
    { symbol: 'ZECUSDT', quoteVolume: 363e6 }, { symbol: 'SOLUSDT', quoteVolume: 147e6 },
    { symbol: 'LSKUSDT', quoteVolume: 142e6 }, { symbol: 'XRPUSDT', quoteVolume: 98e6 },
    { symbol: 'BNBUSDT', quoteVolume: 68e6 }, { symbol: 'FILUSDT', quoteVolume: 47e6 },
    { symbol: 'HOLOUSDT', quoteVolume: 46e6 }, { symbol: 'SUIUSDT', quoteVolume: 40e6 },
    { symbol: 'THINUSDT', quoteVolume: 2e6 },
  ];

  const atOld = describeUniverse(universe, 50e6);
  const atNew = describeUniverse(universe, MIN_VOLUME);
  check('the old floor admitted seven of these and the new one admits more',
    atOld.kept === 7 && atNew.kept > atOld.kept);
  check('the new floor still excludes the genuinely untradeable',
    atNew.kept < universe.length);
  check('widening the universe makes the worst coin in it more expensive',
    atNew.worstSlippage > atOld.worstSlippage);

  /*
   * The pairing that makes the change honest: the floor came down AND the cost
   * went up. Either alone would have been a mistake in a different direction.
   */
  check('the default floor is no longer the one that admitted seven coins',
    MIN_VOLUME < 50e6);
  check('and the coin at the new floor is charged well over the flat old rate',
    slippageFor(MIN_VOLUME) > REFERENCE_SLIPPAGE * 2);

  check('the report can say how thin the thinnest admitted coin is',
    atNew.thinnest >= MIN_VOLUME && atNew.deepest === 699e6);
  check('an empty universe is described rather than crashed into',
    describeUniverse([], MIN_VOLUME).kept === 0
      && describeUniverse(null, MIN_VOLUME).offered === 0);
}

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
