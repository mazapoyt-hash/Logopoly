/**
 * CoinScope configuration. Everything here is overridable through the
 * environment so the same build runs offline (synthetic data) or against a
 * live exchange.
 */

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  dataDir: env.COINSCOPE_DATA_DIR || null, // null -> <repo>/data

  /**
   * 'binance'   — live public market data (no API key needed, read-only)
   * 'synthetic' — deterministic generated candles, works with no network.
   * Live exchange access is blocked in some environments; synthetic keeps the
   * whole pipeline runnable and testable there.
   */
  source: env.COINSCOPE_SOURCE || 'synthetic',

  binance: {
    // api.binance.com is geo-restricted in some countries; these mirrors serve
    // the same public market-data endpoints.
    baseUrl: env.BINANCE_BASE_URL || 'https://api.binance.com',
    timeoutMs: Number(env.BINANCE_TIMEOUT_MS || 15000),
  },

  /** Coins to scan. Order matters only for display. */
  symbols: (env.COINSCOPE_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,AVAXUSDT,LINKUSDT')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),

  /** Signal timeframe and the higher timeframe used as a trend filter. */
  timeframe: env.COINSCOPE_TIMEFRAME || '1h',
  higherTimeframe: env.COINSCOPE_HTF || '4h',

  /** How many candles to keep/scan per symbol. */
  candleLimit: Number(env.COINSCOPE_CANDLES || 500),

  /** Seconds between scan cycles. */
  scanIntervalSec: Number(env.COINSCOPE_SCAN_SEC || 60),

  strategy: {
    /** Minimum confluence score (0-100) required to publish a signal. */
    minScore: Number(env.COINSCOPE_MIN_SCORE || 60),
    /** Below this ADX the market is treated as chop and skipped entirely. */
    minAdx: Number(env.COINSCOPE_MIN_ADX || 20),
    /** Stop distance = atr * this. */
    atrStopMult: Number(env.COINSCOPE_ATR_STOP || 1.5),
    /** Take-profit distance = stop distance * this (reward:risk). */
    rewardRisk: Number(env.COINSCOPE_RR || 2),
    /** A signal that hits neither side within this many bars is void. */
    expiryBars: Number(env.COINSCOPE_EXPIRY_BARS || 24),
    /** Require the higher timeframe to agree with the direction. */
    requireHtfAlignment: env.COINSCOPE_REQUIRE_HTF !== '0',
  },

  /**
   * Below this many resolved trades, a win rate is not shown as a headline
   * number — small samples say nothing and presenting them is how signal
   * services mislead people.
   */
  minSampleForStats: Number(env.COINSCOPE_MIN_SAMPLE || 20),
};

/** Milliseconds per candle for the timeframes we support. */
export const TIMEFRAME_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

export function timeframeMs(tf) {
  const ms = TIMEFRAME_MS[tf];
  if (!ms) throw new Error(`Unsupported timeframe: ${tf}`);
  return ms;
}
