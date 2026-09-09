/**
 * Data sources: the synthetic generator's guarantees, and the Binance response
 * parsing (which cannot be exercised over the network from a sandbox, so it is
 * tested against recorded payload shapes).
 */
import { fetchCandles, fetchPrice } from '../server/sources/synthetic.js';
import { parseKlines, dropUnclosed, parseTickers } from '../server/sources/binance.js';
import { makeChecker, close } from './helpers.mjs';

const results = [];
const check = makeChecker(results);

/* ---------------------------- synthetic ------------------------------ */
const one = fetchCandles('BTCUSDT', '1h', 1);
const many = fetchCandles('BTCUSDT', '1h', 500);

// Regression: the generator once accumulated a walk from the start of the
// requested window, so a 1-candle request disagreed with the chart's last
// candle and the dashboard showed nonsense open-trade P&L.
check('the last candle does not depend on how many were requested',
  close(one[0].close, many[many.length - 1].close, 1e-9) && one[0].time === many[many.length - 1].time);

check('a longer window is a superset of a shorter one', (() => {
  const short = fetchCandles('ETHUSDT', '1h', 50);
  const long = fetchCandles('ETHUSDT', '1h', 300);
  const tail = long.slice(-50);
  return short.every((c, i) => c.time === tail[i].time && close(c.close, tail[i].close, 1e-9));
})());

check('candles are strictly ordered in time',
  many.every((c, i) => i === 0 || c.time > many[i - 1].time));

check('OHLC is internally consistent', many.every((c) =>
  c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && c.low > 0));

check('each candle opens where the previous one closed',
  many.every((c, i) => i === 0 || close(c.open, many[i - 1].close, 1e-9)));

check('volume is always positive', many.every((c) => c.volume > 0));

check('different coins produce different series', (() => {
  const eth = fetchCandles('ETHUSDT', '1h', 100);
  const sol = fetchCandles('SOLUSDT', '1h', 100);
  return eth.some((c, i) => Math.abs(c.close / eth[0].close - sol[i].close / sol[0].close) > 1e-6);
})());

check('the series is reproducible across calls', (() => {
  const a = fetchCandles('ADAUSDT', '1h', 120);
  const b = fetchCandles('ADAUSDT', '1h', 120);
  return a.every((c, i) => c.time === b[i].time && close(c.close, b[i].close, 1e-12));
})());

check('spot price matches the latest candle close',
  close(await fetchPrice('BTCUSDT', '1h'), many[many.length - 1].close, 1e-9));

// Movement has to be big enough for indicators to mean anything, and small
// enough to resemble a market rather than a lottery.
const moves = many.slice(1).map((c, i) => Math.abs(c.close - many[i].close) / many[i].close);
const avgMove = moves.reduce((s, m) => s + m, 0) / moves.length;
check(`average bar move is plausible (${(avgMove * 100).toFixed(2)}%)`, avgMove > 0.0005 && avgMove < 0.05);

/* ----------------------------- binance ------------------------------- */
// Shape of a real /api/v3/klines row.
const row = (openTime, o, h, l, c, v, closeTime) =>
  [openTime, o, h, l, c, v, closeTime, '0', 100, '0', '0', '0'];

const parsed = parseKlines([
  row(1700000000000, '42000.10', '42500.00', '41800.00', '42300.50', '1234.5', 1700003599999),
  row(1700003600000, '42300.50', '42900.00', '42200.00', '42800.00', '2345.6', 1700007199999),
]);
check('binance klines are parsed into numbers',
  parsed.length === 2 && close(parsed[0].open, 42000.10) && close(parsed[1].close, 42800));
check('kline open time is kept', parsed[0].time === 1700000000000);
check('kline close time is kept', parsed[0].closeTime === 1700003599999);

check('a malformed kline row is rejected', (() => {
  try { parseKlines([row(1700000000000, 'not-a-number', '1', '1', '1', '1', 2)]); return false; }
  catch { return true; }
})());
check('a non-array payload is rejected', (() => {
  try { parseKlines({ code: -1121, msg: 'Invalid symbol.' }); return false; } catch { return true; }
})());

// The in-progress candle must be dropped, or signals fire on incomplete data.
const withOpen = parseKlines([
  row(1700000000000, '1', '2', '0.5', '1.5', '10', 1700003599999),
  row(1700003600000, '1.5', '2.5', '1.4', '2.0', '11', 1700007199999),
]);
check('the still-forming candle is dropped',
  dropUnclosed(withOpen, 1700005000000).length === 1);
check('fully closed candles are all kept',
  dropUnclosed(withOpen, 1700009999999).length === 2);
check('dropUnclosed copes with an empty series', dropUnclosed([], Date.now()).length === 0);

// Batch ticker payload, used by the live price loop.
const tickers = parseTickers([
  { symbol: 'BTCUSDT', price: '64123.45000000' },
  { symbol: 'ETHUSDT', price: '3210.10000000' },
]);
check('batch tickers become a symbol -> price map',
  close(tickers.BTCUSDT, 64123.45) && close(tickers.ETHUSDT, 3210.1));
check('a ticker with a bad price is skipped, not fatal',
  Object.keys(parseTickers([{ symbol: 'X', price: 'oops' }, { symbol: 'Y', price: '1.5' }])).length === 1);
check('a non-array ticker payload is rejected', (() => {
  try { parseTickers({ code: -1121 }); return false; } catch { return true; }
})());

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
