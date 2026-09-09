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

/* --------------------------- all signals ----------------------------- */
const all = await get('/api/signals/all');
check('the combined signal list responds', all.status === 200);
check('it separates open from closed',
  Array.isArray(all.body.open) && Array.isArray(all.body.closed));
check('every closed signal is marked win, loss or expired',
  all.body.closed.every((s) => ['win', 'loss', 'expired'].includes(s.status)));
check('open signals carry no outcome yet', all.body.open.every((s) => s.status === 'open'));

/* ------------------------- probability fields ------------------------ */
if (sig) {
  const hasProbFields = 'win_prob' in sig && 'prob_sample' in sig;
  check('signals expose the success-estimate fields', hasProbFields);
  // With an empty history the honest answer is "no estimate", not a number.
  check('no probability is invented without evidence',
    sig.win_prob === null || (sig.prob_sample >= 15 && sig.win_prob >= 0 && sig.win_prob <= 1));
}

// After a backtest there is evidence, so later signals can carry an estimate.
await fetch(BASE + '/api/backtest/run', { method: 'POST' });
const afterBt = await get('/api/signals/open');
check('probabilities stay within [0,1] when present',
  afterBt.body.signals.every((s) => s.win_prob === null || (s.win_prob >= 0 && s.win_prob <= 1)));
check('a stated probability always comes with its sample size',
  afterBt.body.signals.every((s) => s.win_prob === null || Number.isFinite(s.prob_sample)));

/* ------------------------------- prices ------------------------------ */
const prices = await get('/api/prices');
check('prices endpoint responds', prices.status === 200 && typeof prices.body.values === 'object');

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
