/**
 * What a trade costs on a coin that is not deeply liquid.
 *
 * WHY THIS EXISTS
 *
 * The project charged every coin a flat 0.05% slippage and refused anything
 * turning over less than $50M a day. That pair of numbers was one decision
 * pretending to be two: the floor existed precisely BECAUSE the slippage
 * assumption was only defensible on deep pairs, and the flat rate was only
 * defensible because the floor kept thin coins out.
 *
 * Then the floor stopped admitting anyone. Measured on 2026-09-14, across
 * 3701 pairs from data-api.binance.vision:
 *
 *     ≥ $1M    195 pairs
 *     ≥ $10M    32
 *     ≥ $50M     7      ← the floor
 *     ≥ $100M    5
 *
 * Seven coins is not a universe, and a cross-section of seven is not a
 * cross-section. The first instinct — drop the floor to $10M and carry on — is
 * exactly the move this module exists to prevent, because it would let thin
 * coins into every statistic while still charging them a deep coin's costs.
 * Every result would improve, and none of the improvement would be real.
 *
 * WHY WE KNOW THE MARKET IS THIS THIN AND THE DATA IS NOT BROKEN
 *
 * Checked against a second exchange rather than assumed. OKX, queried directly,
 * agreed on every pair — and agreed with ITSELF across two differently-derived
 * fields (`vol24h × last` vs `volCcy24h`), which is what makes the reading
 * trustworthy rather than merely convenient:
 *
 *     BTCUSDT   Binance $699M   OKX $257M / $254M
 *     ETHUSDT   Binance $597M   OKX $268M / $266M
 *     SOLUSDT   Binance $147M   OKX  $54M /  $53M
 *
 * Median ratio 0.4 — the ordinary size difference between two venues, not the
 * factor of ten that a truncated feed or a misread unit would produce. The
 * mirror is not under-reporting. The market really is this size.
 *
 * THE MODEL
 *
 * Market-impact literature puts impact at roughly the square root of size over
 * daily volume, so for a fixed position size the cost scales as 1/√turnover.
 * The same shape describes the term that actually dominates at retail size:
 * the bid-ask spread, which widens as a book thins.
 *
 * That gives one anchor and one exponent, both stated rather than buried:
 *
 *     slippage(V) = 0.05% × √($100M / V)
 *
 * At $100M a day it reproduces the old assumption exactly, which is the one
 * point where that assumption was defensible. Below it the cost rises the way
 * a thinning book does.
 *
 * WHAT THIS MODEL IS NOT
 *
 * It is not calibrated. Calibrating it would need order-book depth, which this
 * project does not collect, so the exponent is a shape borrowed from the
 * literature and the anchor is an assumption inherited from before. Any
 * conclusion that depends on the exact number is a conclusion about a guess.
 *
 * Which is why `costGrid` exists below: a result is worth something only if it
 * survives the whole plausible range, and a result that flips between 0.05%
 * and 0.30% has to be reported as undecided rather than as whichever end was
 * run last.
 */

/** Turnover at which the inherited 0.05% assumption was defensible. */
export const REFERENCE_VOLUME = Number(process.env.COINSCOPE_SLIP_REF_VOLUME || 100e6);
/** Slippage per side at the reference turnover. */
export const REFERENCE_SLIPPAGE = Number(process.env.COINSCOPE_SLIPPAGE || 0.0005);

/*
 * Both ends are clamped, for opposite reasons.
 *
 * The floor: no amount of turnover gets you inside the spread, so the curve
 * must not keep improving forever on the most liquid pairs.
 *
 * The ceiling: below some depth the model stops describing a cost and starts
 * describing an impossibility. Capping it would understate that, so the
 * universe floor excludes those coins outright instead — a cap that quietly
 * made untradeable coins look merely expensive is the failure mode here.
 */
export const MIN_SLIPPAGE = Number(process.env.COINSCOPE_SLIP_MIN || 0.0003);
export const MAX_SLIPPAGE = Number(process.env.COINSCOPE_SLIP_MAX || 0.01);

/**
 * Hard floor on turnover.
 *
 * Not a quality filter and not a cost decision — a modelling one. At $10M a day
 * the model charges 0.158% per side, and below that the square-root shape is
 * extrapolating well past anything it was fitted to describe. A coin that thin
 * is excluded rather than priced, because a number produced by an extrapolation
 * reads exactly like a number produced by a measurement.
 */
export const MIN_VOLUME = Number(process.env.COINSCOPE_MIN_VOLUME || 10e6);

/** Slippage per side for a coin turning over `quoteVolume` per day. */
export function slippageFor(quoteVolume) {
  if (!Number.isFinite(quoteVolume) || quoteVolume <= 0) return MAX_SLIPPAGE;
  const raw = REFERENCE_SLIPPAGE * Math.sqrt(REFERENCE_VOLUME / quoteVolume);
  return Math.min(MAX_SLIPPAGE, Math.max(MIN_SLIPPAGE, raw));
}

/**
 * The full cost pair for one coin.
 *
 * The fee does not vary with liquidity — an exchange charges the same taker
 * rate on a thin pair as on a deep one — so only slippage moves. Keeping the
 * two separate matters because they behave differently under every question
 * asked downstream.
 */
export function costsFor(quoteVolume, { feeRate = Number(process.env.COINSCOPE_FEE ?? 0.0005) } = {}) {
  return { feeRate, slippageRate: slippageFor(quoteVolume) };
}

/**
 * Per-symbol costs from a universe listing.
 *
 * Returns a plain object rather than a Map so it serialises into the report:
 * a run that charged different coins different costs has to be able to show
 * what it charged each one, or the totals are unauditable.
 */
export function costsBySymbol(universe, opts = {}) {
  const out = {};
  for (const row of universe || []) {
    if (row?.symbol) out[row.symbol] = costsFor(row.quoteVolume, opts);
  }
  return out;
}

/**
 * A lookup that always answers, falling back to the most pessimistic cost.
 *
 * A missing symbol must never quietly get the cheapest rate. Open signals
 * outlive the universe that admitted them, so this is reached in normal
 * operation, not only in error — and the safe direction is to overcharge.
 */
export function lookupCosts(map, symbol, fallback = null) {
  return map?.[symbol] || fallback || { feeRate: Number(process.env.COINSCOPE_FEE ?? 0.0005), slippageRate: MAX_SLIPPAGE };
}

/**
 * The same question at several slippage assumptions.
 *
 * The exponent above is borrowed and the anchor is inherited, so a single run
 * reports a number whose precision it has not earned. This turns that into
 * something honest: run the measurement across the plausible range and see
 * whether the answer holds.
 *
 * `verdict` is deliberately blunt. `robust` means the sign never changed;
 * `fragile` means it did, and a fragile result is a statement about the
 * assumption rather than about the market.
 */
export function costGrid(measure, {
  slippages = [0.0003, 0.0005, 0.001, 0.002, 0.003],
  feeRate = Number(process.env.COINSCOPE_FEE ?? 0.0005),
} = {}) {
  const cells = slippages.map((slippageRate) => ({
    slippageRate,
    roundTripPct: (feeRate + slippageRate) * 2 * 100,
    result: measure({ feeRate, slippageRate }),
  })).filter((c) => Number.isFinite(c.result));

  if (!cells.length) return null;

  const positive = cells.filter((c) => c.result > 0).length;
  const verdict = positive === cells.length ? 'robust'
    : positive === 0 ? 'negative-throughout' : 'fragile';

  return {
    cells,
    positive,
    total: cells.length,
    verdict,
    text: verdict === 'robust'
      ? `Результат положителен при всех ${cells.length} предположениях об издержках — ` +
        'от самого мягкого до самого сурового. Вывод не зависит от того, какое число мы угадали.'
      : verdict === 'negative-throughout'
        ? `Результат отрицателен при всех ${cells.length} предположениях об издержках. ` +
          'Смягчение модели издержек это не спасёт.'
        : `Знак меняется внутри диапазона: положителен в ${positive} случаях из ${cells.length}. ` +
          'Значит это утверждение не о рынке, а о том, какое проскальзывание мы предположили — ' +
          'а его мы не измеряли.',
  };
}

/**
 * How the universe looks at a given floor, for the report.
 *
 * Printed next to any result computed on it, because "40 coins" and "7 coins"
 * are different experiments and the difference is invisible in an average.
 */
export function describeUniverse(universe, minVolume = MIN_VOLUME) {
  const rows = (universe || []).filter((r) => Number.isFinite(r?.quoteVolume));
  const kept = rows.filter((r) => r.quoteVolume >= minVolume);
  const slips = kept.map((r) => slippageFor(r.quoteVolume)).sort((a, b) => a - b);

  return {
    minVolume,
    offered: rows.length,
    kept: kept.length,
    thinnest: kept.length ? Math.min(...kept.map((r) => r.quoteVolume)) : null,
    deepest: kept.length ? Math.max(...kept.map((r) => r.quoteVolume)) : null,
    medianSlippage: slips.length ? slips[Math.floor(slips.length / 2)] : null,
    worstSlippage: slips.length ? slips[slips.length - 1] : null,
  };
}
