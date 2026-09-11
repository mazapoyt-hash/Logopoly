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
   * 'synthetic' — deterministic generated candles for tests and for networks
   *               where exchange APIs are blocked.
   * Live is the default: the point of the product is the real market.
   */
  source: env.COINSCOPE_SOURCE || 'binance',

  binance: {
    // api.binance.com is geo-restricted in some countries; these mirrors serve
    // the same public market-data endpoints.
    baseUrl: env.BINANCE_BASE_URL || 'https://api.binance.com',
    timeoutMs: Number(env.BINANCE_TIMEOUT_MS || 15000),
  },

  /**
   * Coins to scan when the universe is not being chosen automatically.
   * Order matters only for display.
   */
  symbols: (env.COINSCOPE_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,AVAXUSDT,LINKUSDT')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),

  universe: {
    /**
     * How many coins to take, ranked by 24h turnover. 0 keeps the hand-written
     * list above. A wider universe multiplies the sample and is what makes a
     * cross-sectional idea possible at all.
     */
    size: Number(env.COINSCOPE_UNIVERSE || 0),
    /**
     * Turnover floor, in quote currency per 24h. This is not a quality filter,
     * it is a HONESTY filter: the cost model charges a flat 0.05% slippage,
     * which is defensible on a pair trading hundreds of millions a day and
     * fiction on a thin one. Including thin coins at a liquid coin's costs
     * would inflate every result for free.
     */
    minQuoteVolume: Number(env.COINSCOPE_MIN_VOLUME || 50e6),
  },

  /** Signal timeframe and the higher timeframe used as a trend filter. */
  timeframe: env.COINSCOPE_TIMEFRAME || '1h',
  higherTimeframe: env.COINSCOPE_HTF || '4h',

  /** How many candles to keep/scan per symbol. */
  candleLimit: Number(env.COINSCOPE_CANDLES || 500),

  /** Seconds between full scan cycles (new signals on closed candles). */
  scanIntervalSec: Number(env.COINSCOPE_SCAN_SEC || 60),

  /**
   * Seconds between live price ticks. Open signals are checked against the
   * current exchange price on every tick, so a stop or target is registered
   * when it is actually hit — not once the candle finally closes.
   */
  priceIntervalSec: Number(env.COINSCOPE_PRICE_SEC || 10),

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

  /**
   * A published signal shows an estimated success probability only when it can
   * be backed by at least this many comparable historical outcomes. Below it
   * the site says "недостаточно данных" instead of printing a number nobody
   * can stand behind.
   */
  minSampleForProbability: Number(env.COINSCOPE_MIN_PROB_SAMPLE || 15),
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
