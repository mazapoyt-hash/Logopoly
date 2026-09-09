/** Shared test helpers. */

export function makeChecker(results) {
  return (name, cond) => {
    results.push([name, !!cond]);
    console.log((cond ? '  ✅' : '  ❌') + ' ' + name);
  };
}

export function close(a, b, eps = 1e-9) {
  return typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= eps;
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build a candle series from a list of closes, with sane highs/lows. */
export function candlesFromCloses(closes, { start = 0, step = 3600_000, wick = 0.002 } = {}) {
  return closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1];
    return {
      time: start + i * step,
      open,
      high: Math.max(open, c) * (1 + wick),
      low: Math.min(open, c) * (1 - wick),
      close: c,
      volume: 1000,
    };
  });
}
