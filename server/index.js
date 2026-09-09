import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { getCandles, checkSource } from './sources/index.js';
import { computeIndicators, htfTrendAt } from './strategy.js';
import { Signals, Backtests } from './db.js';
import * as tracker from './tracker.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Charting library, served straight out of node_modules (no build step).
// The package's "exports" map does not expose ./dist, so resolve via its
// package.json — which it does expose — and build the path from there.
try {
  const pkgJson = require.resolve('lightweight-charts/package.json');
  const lwc = path.join(path.dirname(pkgJson), 'dist', 'lightweight-charts.standalone.production.js');
  if (!fs.existsSync(lwc)) throw new Error(`not found at ${lwc}`);
  app.get('/vendor/lightweight-charts.js', (_req, res) => res.sendFile(lwc));
} catch (err) {
  // Charts degrade to "unavailable" in the UI rather than breaking the server,
  // but say so — a silent 404 here is hard to diagnose from the browser.
  console.warn(`  ⚠ График недоступен: библиотека не найдена (${err.message})`);
}

/* ------------------------------- Status ------------------------------- */
app.get('/api/status', async (_req, res) => {
  res.json({
    source: config.source,
    symbols: config.symbols,
    timeframe: config.timeframe,
    higherTimeframe: config.higherTimeframe,
    strategy: config.strategy,
    minSampleForStats: config.minSampleForStats,
    scan: tracker.status,
    totalSignals: Signals.countAll(),
    sourceHealth: await checkSource(),
  });
});

/* ------------------------------ Signals ------------------------------- */
app.get('/api/signals/open', (_req, res) => {
  res.json({ signals: Signals.open() });
});

app.get('/api/signals/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ signals: Signals.history({ limit, symbol: req.query.symbol || null }) });
});

app.get('/api/signals/:id', (req, res) => {
  const sig = Signals.get(Number(req.params.id));
  if (!sig) return res.status(404).json({ error: 'not found' });
  res.json({ signal: sig });
});

/* --------------------------- Track record ----------------------------- */
app.get('/api/record', (req, res) => {
  const symbol = req.query.symbol || null;
  const portfolio = tracker.liveRecord(symbol);
  const perSymbol = config.symbols.map((s) => ({ symbol: s, stats: tracker.liveRecord(s) }));
  res.json({ portfolio, perSymbol, minSample: config.minSampleForStats });
});

/* ------------------------------ Backtest ------------------------------ */
app.get('/api/backtest', (_req, res) => {
  const rows = Backtests.latestAll(config.timeframe);
  res.json({ results: rows, minSample: config.minSampleForStats });
});

app.post('/api/backtest/run', async (_req, res) => {
  try {
    res.json(await tracker.runBacktests());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------- Market ------------------------------- */
/** Snapshot of every tracked coin for the scanner table. */
app.get('/api/market', async (_req, res) => {
  const out = [];
  for (const symbol of config.symbols) {
    try {
      const candles = await getCandles(symbol, config.timeframe);
      const htf = await getCandles(symbol, config.higherTimeframe);
      if (!candles.length) { out.push({ symbol, error: 'нет данных' }); continue; }

      const ind = computeIndicators(candles);
      const htfInd = computeIndicators(htf);
      const i = candles.length - 1;
      const last = candles[i];
      const back = candles[Math.max(0, i - 24)];
      const { trend } = htfTrendAt(htf, htfInd, last.time + 1);

      out.push({
        symbol,
        price: last.close,
        change24: back ? ((last.close - back.close) / back.close) * 100 : null,
        rsi: ind.rsi[i],
        adx: ind.adx[i],
        relVol: ind.relVol[i],
        ema200: ind.ema200[i],
        aboveEma200: ind.ema200[i] != null ? last.close > ind.ema200[i] : null,
        htfTrend: trend,
        updatedAt: last.time,
      });
    } catch (err) {
      out.push({ symbol, error: err.message });
    }
  }
  res.json({ market: out, timeframe: config.timeframe });
});

app.get('/api/candles/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol).toUpperCase();
  if (!config.symbols.includes(symbol)) return res.status(404).json({ error: 'symbol not tracked' });
  const tf = req.query.tf || config.timeframe;
  const limit = Math.min(Number(req.query.limit) || 300, 1000);
  try {
    res.json({ symbol, timeframe: tf, candles: await getCandles(symbol, tf, limit) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ------------------------------- Actions ------------------------------ */
app.post('/api/scan', async (_req, res) => {
  try {
    res.json(await tracker.scanOnce());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------- SSE live feed --------------------------- */
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onNew = (s) => send('signal:new', s);
  const onResolved = (s) => send('signal:resolved', s);
  const onScan = (s) => send('scan:done', s);

  tracker.events.on('signal:new', onNew);
  tracker.events.on('signal:resolved', onResolved);
  tracker.events.on('scan:done', onScan);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    tracker.events.off('signal:new', onNew);
    tracker.events.off('signal:resolved', onResolved);
    tracker.events.off('scan:done', onScan);
  });
});

/* -------------------------------- Boot -------------------------------- */
const server = app.listen(config.port, async () => {
  console.log(`\n  CoinScope — http://localhost:${config.port}`);
  console.log(`  источник данных: ${config.source}   таймфрейм: ${config.timeframe} (фильтр ${config.higherTimeframe})`);
  console.log(`  монеты: ${config.symbols.join(', ')}`);

  const health = await checkSource();
  if (!health.ok) {
    console.log(`\n  ⚠ Источник «${health.source}» недоступен: ${health.error}`);
    console.log(`     Запустите с COINSCOPE_SOURCE=synthetic, либо укажите BINANCE_BASE_URL.`);
  }
  if (process.env.COINSCOPE_NO_LOOP !== '1') {
    tracker.start();
    console.log(`  сканирование каждые ${config.scanIntervalSec} с\n`);
  }
});

export { app, server };
