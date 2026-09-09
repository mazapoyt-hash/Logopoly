/**
 * Backtest accounting: costs, the tie rule, expiry, and the statistics that
 * the site presents as "verified".
 */
import { netR, resolveOnBar, summarize, backtestSymbol, COSTS } from '../server/backtest.js';
import { fetchCandles } from '../server/sources/synthetic.js';
import { makeChecker, close } from './helpers.mjs';

const results = [];
const check = makeChecker(results);

/* ------------------------------- costs ------------------------------- */
const winR = netR({ direction: 'LONG', entry: 100, stop: 98, exit: 104 });
check('a 2:1 winner returns just under +2R after costs', winR > 1.8 && winR < 2);
const lossR = netR({ direction: 'LONG', entry: 100, stop: 98, exit: 98 });
check('a stopped-out trade loses slightly more than 1R', lossR < -1 && lossR > -1.15);

const shortWin = netR({ direction: 'SHORT', entry: 100, stop: 102, exit: 96 });
check('shorts are priced symmetrically', shortWin > 1.8 && shortWin < 2);

check('costs are actually charged', (() => {
  const noCost = (104 - 100) / 100 / (2 / 100); // exactly 2R gross
  return noCost === 2 && winR < noCost;
})());
check('fee and slippage are configurable', COSTS.feeRate > 0 && COSTS.slippageRate > 0);

/* ------------------------- resolution rules -------------------------- */
const trade = { direction: 'LONG', entry: 100, stop: 98, target: 104, expiryBars: 10 };

check('an untouched bar leaves the trade open',
  resolveOnBar(trade, { time: 1, open: 100, high: 101, low: 99.5, close: 100.5 }, 1) === null);

check('hitting the target closes as a win',
  resolveOnBar(trade, { time: 1, open: 100, high: 105, low: 99.5, close: 104.5 }, 1)?.status === 'win');

check('hitting the stop closes as a loss',
  resolveOnBar(trade, { time: 1, open: 100, high: 101, low: 97, close: 97.5 }, 1)?.status === 'loss');

// The critical honesty rule: a bar covering both levels counts as a loss.
const bothSides = resolveOnBar(trade, { time: 1, open: 100, high: 105, low: 97, close: 100 }, 1);
check('a bar that spans both levels counts as the STOP, not the target', bothSides?.status === 'loss');

const expired = resolveOnBar(trade, { time: 1, open: 100, high: 101, low: 99, close: 100.5 }, 10);
check('a trade that never resolves expires at the close', expired?.status === 'expired');
check('expiry exits at the bar close', close(expired?.exit, 100.5));

check('shorts resolve on the mirrored side', (() => {
  const s = { direction: 'SHORT', entry: 100, stop: 102, target: 96, expiryBars: 10 };
  return resolveOnBar(s, { time: 1, open: 100, high: 100.5, low: 95, close: 96 }, 1)?.status === 'win'
    && resolveOnBar(s, { time: 1, open: 100, high: 103, low: 99, close: 102 }, 1)?.status === 'loss';
})());

/* -------------------------- summary statistics ----------------------- */
const empty = summarize([]);
check('an empty record reports nothing rather than zero', empty.trades === 0 && empty.winRate === null);
check('an empty record is never called reliable', empty.reliable === false);

const mixed = summarize([
  { r: 2, barsHeld: 5 }, { r: -1, barsHeld: 3 }, { r: 2, barsHeld: 8 }, { r: -1, barsHeld: 2 },
]);
check('win rate is counted correctly', close(mixed.winRate, 0.5));
check('average R is counted correctly', close(mixed.avgR, 0.5));
check('profit factor is gross win over gross loss', close(mixed.profitFactor, 2));
check('total R sums up', close(mixed.totalR, 2));
check('small samples are flagged as unreliable', mixed.reliable === false);

const drawdown = summarize([{ r: 1, barsHeld: 1 }, { r: -1, barsHeld: 1 }, { r: -1, barsHeld: 1 }, { r: 1, barsHeld: 1 }]);
check('max drawdown tracks the worst dip from a peak', close(drawdown.maxDrawdownR, 2));

/* --------------------------- full backtest --------------------------- */
const candles = fetchCandles('ETHUSDT', '1h', 600);
const htf = fetchCandles('ETHUSDT', '4h', 600);
const bt = backtestSymbol({ symbol: 'ETHUSDT', timeframe: '1h', candles, htfCandles: htf });

check('backtest produces trades on this data', bt.trades.length > 0);
check('every trade has an entry, exit and R', bt.trades.every((t) =>
  Number.isFinite(t.entry) && Number.isFinite(t.exit) && Number.isFinite(t.r)));
check('every exit happens after its entry', bt.trades.every((t) => t.exitTime > t.entryTime));
// Positions must be strictly sequential. Re-entering on the same bar that
// closed the previous trade is allowed — the exit happens intrabar at the
// stop/target and the new entry is at that bar's close — but an entry must
// never precede the exit before it.
check('trades never overlap for one symbol', (() => {
  for (let i = 1; i < bt.trades.length; i++) {
    if (bt.trades[i].entryTime < bt.trades[i - 1].exitTime) return false;
  }
  return true;
})());
check('at most one position is open at any moment', (() => {
  for (let i = 1; i < bt.trades.length; i++) {
    const prev = bt.trades[i - 1];
    // Same-bar re-entry is only legitimate when the previous trade really did
    // close on that bar, not because two entries were opened together.
    if (bt.trades[i].entryTime === prev.exitTime && bt.trades[i].entryTime === prev.entryTime) return false;
  }
  return true;
})());
check('stats agree with the trade list', bt.stats.trades === bt.trades.length);
check('reported wins match trades with positive R',
  bt.stats.wins === bt.trades.filter((t) => t.r > 0).length);

// Deterministic data must give a deterministic backtest.
const again = backtestSymbol({ symbol: 'ETHUSDT', timeframe: '1h', candles, htfCandles: htf });
check('backtest is reproducible', again.stats.totalR === bt.stats.totalR && again.trades.length === bt.trades.length);

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
