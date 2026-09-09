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
         bar_time, expiry_bars, status, created_at)
      VALUES (@symbol, @timeframe, @direction, @entry, @stop, @target, @atr, @score, @reasons,
              @context, @bar_time, @expiry_bars, 'open', @created_at)`);
    const info = stmt.run({
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
      created_at: now(),
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
  record({ symbol = null } = {}) {
    const rows = symbol
      ? db.prepare(`SELECT * FROM signals WHERE status != 'open' AND symbol = ?`).all(symbol)
      : db.prepare(`SELECT * FROM signals WHERE status != 'open'`).all();
    return rows.map(hydrate);
  },

  countAll() {
    return db.prepare(`SELECT COUNT(*) AS n FROM signals`).get().n;
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
