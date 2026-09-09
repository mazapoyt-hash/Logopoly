/**
 * Live tracking: a published signal must be carried to its stop or target and
 * recorded — that forward record is what "verified" actually means here.
 * Runs against a throwaway database.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.COINSCOPE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coinscope-tracker-'));
process.env.COINSCOPE_SOURCE = 'synthetic';

const { Signals } = await import('../server/db.js');
const { resolveSignal, liveRecord } = await import('../server/tracker.js');
const { makeChecker, close } = await import('./helpers.mjs');

const results = [];
const check = makeChecker(results);

const HOUR = 3600_000;
const base = { symbol: 'BTCUSDT', timeframe: '1h', atr: 2, score: 75, reasons: [], context: {}, expiryBars: 5 };

/** Candles after the signal bar, so the tracker has something to resolve on. */
const bars = (specs, startTime) => specs.map((s, i) => ({
  time: startTime + (i + 1) * HOUR,
  open: s.open ?? s.close, high: s.high, low: s.low, close: s.close, volume: 100,
}));

/* ------------------------------ a winner ----------------------------- */
{
  const barTime = 1_000_000 * HOUR;
  const sig = Signals.add({ ...base, direction: 'LONG', entry: 100, stop: 98, target: 104, barTime });
  check('a signal can be published', !!sig && sig.status === 'open');

  const candles = [{ time: barTime, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    ...bars([{ close: 101, high: 102, low: 100 }, { close: 105, high: 106, low: 101 }], barTime)];
  const resolved = resolveSignal(sig, candles);
  check('a signal that reaches its target is recorded as a win', resolved?.status === 'win');
  check('the winner is booked just under +2R after costs', resolved.r > 1.8 && resolved.r < 2);
  check('exit price is the target', close(resolved.exit_price, 104));
  check('it no longer counts as open', Signals.open('BTCUSDT').length === 0);
}

/* ------------------------------- a loser ----------------------------- */
{
  const barTime = 2_000_000 * HOUR;
  const sig = Signals.add({ ...base, direction: 'SHORT', entry: 100, stop: 102, target: 96, barTime });
  const candles = [{ time: barTime, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    ...bars([{ close: 103, high: 103.5, low: 99 }], barTime)];
  const resolved = resolveSignal(sig, candles);
  check('a short stopped out is recorded as a loss', resolved?.status === 'loss');
  check('the loser costs slightly more than 1R', resolved.r < -1 && resolved.r > -1.15);
}

/* ------------------------------- expiry ------------------------------ */
{
  const barTime = 3_000_000 * HOUR;
  const sig = Signals.add({ ...base, direction: 'LONG', entry: 100, stop: 98, target: 104, barTime, expiryBars: 3 });
  const flat = Array.from({ length: 4 }, (_, i) => ({ close: 100.2, high: 100.5, low: 99.8 }));
  const candles = [{ time: barTime, open: 100, high: 100, low: 100, close: 100, volume: 1 }, ...bars(flat, barTime)];
  const resolved = resolveSignal(sig, candles);
  check('a signal that goes nowhere expires', resolved?.status === 'expired');
  check('an expired signal still lands in the record — not quietly dropped',
    Signals.history({ limit: 50 }).some((s) => s.id === sig.id));
}

/* ---------------------------- still running -------------------------- */
{
  const barTime = 4_000_000 * HOUR;
  const sig = Signals.add({ ...base, direction: 'LONG', entry: 100, stop: 98, target: 104, barTime });
  const candles = [{ time: barTime, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    ...bars([{ close: 101, high: 101.5, low: 99.5 }], barTime)];
  check('an unresolved signal stays open', resolveSignal(sig, candles) === null);
  check('it is still listed as open', Signals.open('BTCUSDT').some((s) => s.id === sig.id));
}

/* -------------------------- duplicate guard -------------------------- */
{
  const barTime = 5_000_000 * HOUR;
  const first = Signals.add({ ...base, direction: 'LONG', entry: 100, stop: 98, target: 104, barTime });
  const second = Signals.add({ ...base, direction: 'LONG', entry: 100, stop: 98, target: 104, barTime });
  check('the same candle cannot produce two signals', !!first && second === null);
}

/* ------------------------------- record ------------------------------ */
{
  const rec = liveRecord('BTCUSDT');
  check('the live record counts every resolved signal', rec.trades === 3); // win + loss + expired
  check('the live record counts the win', rec.wins === 1);
  check('the live record is honest about a tiny sample', rec.reliable === false);
  check('open signals are excluded from the record',
    rec.trades === Signals.record({ symbol: 'BTCUSDT' }).length);
}

fs.rmSync(process.env.COINSCOPE_DATA_DIR, { recursive: true, force: true });

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
