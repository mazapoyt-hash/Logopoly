/** HTTP surface: the endpoints the dashboard depends on. */
import { makeChecker, wait } from './helpers.mjs';

const BASE = process.env.BASE || 'http://localhost:3000';
const results = [];
const check = makeChecker(results);
const get = (p) => fetch(BASE + p).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/* ------------------------------- status ------------------------------ */
const status = await get('/api/status');
check('status responds', status.status === 200);
check('status reports the data source', !!status.body?.source);
check('status lists tracked symbols', Array.isArray(status.body?.symbols) && status.body.symbols.length > 0);
check('status exposes strategy thresholds', Number.isFinite(status.body?.strategy?.minScore));
check('source health is checked', status.body?.sourceHealth?.ok === true);

/* -------------------------------- scan ------------------------------- */
const scan = await fetch(BASE + '/api/scan', { method: 'POST' }).then((r) => r.json());
check('a scan cycle completes', Number.isFinite(scan.lastScanAt));
check('the scan reports no per-symbol errors', (scan.errors || []).length === 0);

/* ------------------------------ signals ------------------------------ */
const open = await get('/api/signals/open');
check('open signals endpoint responds', open.status === 200 && Array.isArray(open.body.signals));

const sig = open.body.signals[0];
check('the scan produced at least one signal', !!sig);
if (sig) {
  check('signal has a direction', sig.direction === 'LONG' || sig.direction === 'SHORT');
  check('signal has entry, stop and target', [sig.entry, sig.stop, sig.target].every(Number.isFinite));
  check('signal carries human-readable reasons', Array.isArray(sig.reasons) && sig.reasons.length > 0);
  check('stop and target straddle the entry',
    sig.direction === 'LONG'
      ? sig.stop < sig.entry && sig.target > sig.entry
      : sig.stop > sig.entry && sig.target < sig.entry);

  const one = await get(`/api/signals/${sig.id}`);
  check('a single signal can be fetched', one.status === 200 && one.body.signal.id === sig.id);
}

// Re-scanning the same closed candle must not duplicate signals.
const before = (await get('/api/signals/open')).body.signals.length;
await fetch(BASE + '/api/scan', { method: 'POST' });
const after = (await get('/api/signals/open')).body.signals.length;
check('re-scanning the same candle does not duplicate signals', before === after);

/* ------------------------------- market ------------------------------ */
const market = await get('/api/market');
check('market snapshot responds', market.status === 200);
check('market covers every tracked symbol', market.body.market.length === status.body.symbols.length);
check('market rows carry price and indicators', market.body.market.every((m) =>
  m.error || (Number.isFinite(m.price) && Number.isFinite(m.rsi))));

/* ------------------------------ candles ------------------------------ */
const candles = await get(`/api/candles/${status.body.symbols[0]}?limit=50`);
check('candles endpoint responds', candles.status === 200 && candles.body.candles.length === 50);
check('candles are ordered and well-formed', candles.body.candles.every((c, i, arr) =>
  Number.isFinite(c.open) && c.high >= c.low &&
  c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) &&
  (i === 0 || c.time > arr[i - 1].time)));
const unknown = await get('/api/candles/NOTACOIN');
check('unknown symbols are rejected', unknown.status === 404);

/* ------------------------------ backtest ----------------------------- */
const bt = await fetch(BASE + '/api/backtest/run', { method: 'POST' }).then((r) => r.json());
check('backtest runs over every symbol', bt.perSymbol.length === status.body.symbols.length);
check('backtest returns portfolio statistics', Number.isFinite(bt.portfolio.trades));
check('backtest results are stored', (await get('/api/backtest')).body.results.length > 0);

/* ------------------------------- record ------------------------------ */
const rec = await get('/api/record');
check('track record responds', rec.status === 200);
check('track record reports its minimum sample size', Number.isFinite(rec.body.minSample));
check('track record never invents a win rate with no trades',
  rec.body.portfolio.trades > 0 || rec.body.portfolio.winRate === null);

/* --------------------------------- SSE ------------------------------- */
const sse = await fetch(BASE + '/api/events', { headers: { Accept: 'text/event-stream' } });
check('event stream opens', sse.status === 200 && /text\/event-stream/.test(sse.headers.get('content-type') || ''));
sse.body?.cancel?.();

/* ------------------------------ frontend ----------------------------- */
const page = await fetch(BASE + '/');
const html = await page.text();
check('dashboard is served', page.status === 200 && html.includes('CoinScope'));
check('dashboard carries the not-financial-advice notice', html.includes('не финансовая рекомендация'));

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
