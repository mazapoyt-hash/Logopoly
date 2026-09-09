import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = config.dataDir || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'coinscope.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  timeframe     TEXT NOT NULL,
  direction     TEXT NOT NULL,             -- LONG | SHORT
  entry         REAL NOT NULL,
  stop          REAL NOT NULL,
  target        REAL NOT NULL,
  atr           REAL,
  score         INTEGER NOT NULL,
  reasons       TEXT,                      -- json array
  context       TEXT,                      -- json object
  bar_time      INTEGER NOT NULL,          -- open time of the signal candle
  expiry_bars   INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',  -- open | win | loss | expired
  exit_price    REAL,
  exit_time     INTEGER,
  bars_held     INTEGER,
  r             REAL,                      -- net R multiple once resolved
  created_at    INTEGER NOT NULL,
  UNIQUE(symbol, timeframe, bar_time)      -- one signal per closed candle
);

CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol, created_at DESC);

-- Individual backtest trades. Kept (not just the summary) because the success
-- probability shown on a signal is derived from comparable past outcomes.
CREATE TABLE IF NOT EXISTS backtest_trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  direction   TEXT NOT NULL,
  score       INTEGER NOT NULL,
  outcome     TEXT NOT NULL,             -- win | loss | expired
  r           REAL NOT NULL,
  entry_time  INTEGER NOT NULL,
  source      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bt_trades ON backtest_trades(timeframe, score, symbol);

CREATE TABLE IF NOT EXISTS backtests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  source      TEXT NOT NULL,
  stats       TEXT NOT NULL,               -- json
  bars        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backtests_symbol ON backtests(symbol, created_at DESC);
`);

/** Add a column to an existing table if an older database lacks it. */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
// The success estimate is stored as it was at publication time — recomputing it
// later from today's data would quietly rewrite what the signal claimed.
ensureColumn('signals', 'win_prob', 'win_prob REAL');
ensureColumn('signals', 'prob_low', 'prob_low REAL');
ensureColumn('signals', 'prob_high', 'prob_high REAL');
ensureColumn('signals', 'prob_sample', 'prob_sample INTEGER');
ensureColumn('signals', 'prob_basis', 'prob_basis TEXT');
ensureColumn('signals', 'expected_r', 'expected_r REAL');
// 'live'   — published by the running scanner against the exchange
// 'replay' — the same logic walked over past candles to seed a history.
// They are kept apart so replayed trades can never inflate the live record.
ensureColumn('signals', 'origin', `origin TEXT NOT NULL DEFAULT 'live'`);

const now = () => Date.now();
const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    reasons: parse(row.reasons, []),
    context: parse(row.context, {}),
  };
}

export const Signals = {
  /**
   * Insert a signal. Returns null when one already exists for that candle,
   * which keeps repeated scans of the same bar from duplicating it.
   */
  add(sig) {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO signals
        (symbol, timeframe, direction, entry, stop, target, atr, score, reasons, context,
         bar_time, expiry_bars, status, created_at,
         win_prob, prob_low, prob_high, prob_sample, prob_basis, expected_r, origin)
      VALUES (@symbol, @timeframe, @direction, @entry, @stop, @target, @atr, @score, @reasons,
              @context, @bar_time, @expiry_bars, 'open', @created_at,
              @win_prob, @prob_low, @prob_high, @prob_sample, @prob_basis, @expected_r, @origin)`);
    const p = sig.probability || {};
    const info = stmt.run({
      win_prob: p.probability ?? null,
      prob_low: p.low ?? null,
      prob_high: p.high ?? null,
      prob_sample: p.sample ?? null,
      prob_basis: p.basis ?? null,
      expected_r: p.expectedR ?? null,
      origin: sig.origin || 'live',
      symbol: sig.symbol,
      timeframe: sig.timeframe,
      direction: sig.direction,
      entry: sig.entry,
      stop: sig.stop,
      target: sig.target,
      atr: sig.atr ?? null,
      score: Math.round(sig.score),
      reasons: JSON.stringify(sig.reasons || []),
      context: JSON.stringify(sig.context || {}),
      bar_time: sig.barTime,
      expiry_bars: sig.expiryBars,
      created_at: sig.createdAt ?? now(),
    });
    return info.changes ? this.get(info.lastInsertRowid) : null;
  },

  get(id) {
    return hydrate(db.prepare(`SELECT * FROM signals WHERE id = ?`).get(id));
  },

  open(symbol) {
    const sql = symbol
      ? `SELECT * FROM signals WHERE status = 'open' AND symbol = ? ORDER BY created_at DESC`
      : `SELECT * FROM signals WHERE status = 'open' ORDER BY created_at DESC`;
    const rows = symbol ? db.prepare(sql).all(symbol) : db.prepare(sql).all();
    return rows.map(hydrate);
  },

  hasOpen(symbol, timeframe) {
    const row = db.prepare(
      `SELECT 1 FROM signals WHERE status = 'open' AND symbol = ? AND timeframe = ? LIMIT 1`
    ).get(symbol, timeframe);
    return !!row;
  },

  history({ limit = 100, symbol = null, status = null } = {}) {
    const where = [];
    const params = [];
    if (symbol) { where.push('symbol = ?'); params.push(symbol); }
    if (status) { where.push('status = ?'); params.push(status); }
    else where.push(`status != 'open'`);
    const rows = db.prepare(
      `SELECT * FROM signals ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY COALESCE(exit_time, created_at) DESC LIMIT ?`
    ).all(...params, limit);
    return rows.map(hydrate);
  },

  resolve(id, { status, exitPrice, exitTime, barsHeld, r }) {
    db.prepare(
      `UPDATE signals SET status = ?, exit_price = ?, exit_time = ?, bars_held = ?, r = ?
       WHERE id = ? AND status = 'open'`
    ).run(status, exitPrice, exitTime, barsHeld, r, id);
    return this.get(id);
  },

  /** Live track record — only resolved signals count. */
  record({ symbol = null, origin = 'live' } = {}) {
    const where = [`status != 'open'`];
    const params = [];
    if (origin) { where.push('origin = ?'); params.push(origin); }
    if (symbol) { where.push('symbol = ?'); params.push(symbol); }
    return db.prepare(`SELECT * FROM signals WHERE ${where.join(' AND ')}`).all(...params).map(hydrate);
  },

  countAll() {
    return db.prepare(`SELECT COUNT(*) AS n FROM signals`).get().n;
  },

  /**
   * Resolved live signals matching a score bucket — the forward-tested half of
   * the evidence behind a success estimate.
   */
  resolvedFor({ timeframe, symbol = null, direction = null, scoreMin = 0, scoreMax = 100 }) {
    const where = [`status != 'open'`, 'timeframe = ?', 'score >= ?', 'score <= ?'];
    const params = [timeframe, scoreMin, scoreMax];
    if (symbol) { where.push('symbol = ?'); params.push(symbol); }
    if (direction) { where.push('direction = ?'); params.push(direction); }
    return db.prepare(`SELECT * FROM signals WHERE ${where.join(' AND ')}`).all(...params).map(hydrate);
  },
};

export const BacktestTrades = {
  /** Replace a symbol's stored trades with the newest run's. */
  replaceFor({ symbol, timeframe, source, trades }) {
    const del = db.prepare(`DELETE FROM backtest_trades WHERE symbol = ? AND timeframe = ?`);
    const ins = db.prepare(
      `INSERT INTO backtest_trades (symbol, timeframe, direction, score, outcome, r, entry_time, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
      del.run(symbol, timeframe);
      for (const t of trades) {
        ins.run(symbol, timeframe, t.direction, Math.round(t.score ?? 0),
          t.resolved || t.outcome, t.r, t.entryTime, source, now());
      }
    })();
  },

  /**
   * Comparable historical outcomes, narrowed as far as the data allows.
   * `scoreMin`/`scoreMax` bound the confluence-score bucket.
   */
  find({ timeframe, symbol = null, direction = null, scoreMin = 0, scoreMax = 100 }) {
    const where = ['timeframe = ?', 'score >= ?', 'score <= ?'];
    const params = [timeframe, scoreMin, scoreMax];
    if (symbol) { where.push('symbol = ?'); params.push(symbol); }
    if (direction) { where.push('direction = ?'); params.push(direction); }
    return db.prepare(`SELECT * FROM backtest_trades WHERE ${where.join(' AND ')}`).all(...params);
  },

  count() {
    return db.prepare(`SELECT COUNT(*) AS n FROM backtest_trades`).get().n;
  },
};

export const Backtests = {
  save({ symbol, timeframe, source, stats, bars }) {
    db.prepare(
      `INSERT INTO backtests (symbol, timeframe, source, stats, bars, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(symbol, timeframe, source, JSON.stringify(stats), bars, now());
  },
  latest(symbol, timeframe) {
    const row = db.prepare(
      `SELECT * FROM backtests WHERE symbol = ? AND timeframe = ? ORDER BY created_at DESC LIMIT 1`
    ).get(symbol, timeframe);
    return row ? { ...row, stats: parse(row.stats, null) } : null;
  },
  latestAll(timeframe) {
    const rows = db.prepare(
      `SELECT b.* FROM backtests b
       JOIN (SELECT symbol, MAX(created_at) AS mx FROM backtests WHERE timeframe = ? GROUP BY symbol) m
         ON m.symbol = b.symbol AND m.mx = b.created_at
       WHERE b.timeframe = ?`
    ).all(timeframe, timeframe);
    return rows.map((r) => ({ ...r, stats: parse(r.stats, null) }));
  },
};

export default db;
