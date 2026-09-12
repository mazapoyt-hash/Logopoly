/**
 * R translated into money, because R is not what anyone actually asks about.
 *
 * "I want to put $100 on each signal and end up in profit" is the real
 * question, and answering it in risk multiples is a way of not answering it.
 * This module does the conversion and, more importantly, answers the part of
 * the question people do not think to ask: what is the probability of being in
 * profit after N signals?
 *
 * That probability is where a losing edge stops being an abstraction. With a
 * positive expectancy, trading more makes profit MORE certain; with a negative
 * one, it makes loss more certain. The same arithmetic runs both ways:
 *
 *     после N сделок сумма ~ Normal(N·μ, σ·√N)
 *     P(в плюсе)  =  Φ( μ·√N / σ )
 *
 * The √N is the whole story. At μ = −0.08R and σ ≈ 1.1R, a hundred signals
 * leave a 23% chance of being ahead and a thousand leave 1%. Patience does not
 * rescue a negative edge — it is what converts it from bad luck into certainty.
 *
 * The same formula inverted gives the target: what per-trade edge would make
 * the stated goal true. That turns "I want to earn on this" from a wish into a
 * number the system can be measured against.
 */

/** Normal CDF, Abramowitz–Stegun 26.2.17. Accurate to ~7.5e-8. */
export function normalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Inverse normal CDF (Acklam's approximation), for "what edge is needed". */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return null;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687,
    138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866,
    66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996,
    3.754408661907416];
  const pLow = 0.02425;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Spread of a single trade's result, measured rather than assumed. */
export function tradeSpread(trades) {
  const rs = trades.map((t) => t.r).filter(Number.isFinite);
  if (rs.length < 2) return null;
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const variance = rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (rs.length - 1);
  return Math.sqrt(variance);
}

/** Probability of being ahead after n trades. */
export function probabilityOfProfit(avgR, sdR, n) {
  if (!(sdR > 0) || !(n > 0)) return null;
  return normalCdf((avgR * Math.sqrt(n)) / sdR);
}

/** The per-trade edge that would make the goal true at a given confidence. */
export function requiredEdge(sdR, n, confidence = 0.9) {
  const z = normalQuantile(confidence);
  if (z == null || !(n > 0)) return null;
  return (z * sdR) / Math.sqrt(n);
}

/**
 * The whole picture in money, for a stake the reader actually recognises.
 *
 * `stake` is deliberately interpreted two ways, because "I put $100 on a
 * signal" means different things to different people and the two differ by a
 * factor of fifty:
 *
 *   position — $100 is the size of the position. What is at risk is the stop
 *              distance, so on a 1.8% stop only $1.80 is on the line.
 *   risk     — $100 is what is lost if the stop hits. The position behind it
 *              is then about $5500, which is usually a surprise.
 *
 * Showing both prevents a reader from quietly assuming the smaller number
 * while acting on the larger one.
 */
export function moneyView({ stats, trades, stopPct, stake = 100, horizons = [10, 50, 100, 500] }) {
  if (!stats?.trades || stats.avgR == null) return null;
  const sdR = tradeSpread(trades || []) ?? 1;
  const avgR = stats.avgR;

  const riskPerTrade = {
    position: stake * (stopPct / 100),   // stake is the position
    risk: stake,                          // stake is what is risked
  };

  const rows = horizons.map((n) => ({
    trades: n,
    probability: probabilityOfProfit(avgR, sdR, n),
    expectedR: avgR * n,
    expected: {
      position: avgR * n * riskPerTrade.position,
      risk: avgR * n * riskPerTrade.risk,
    },
  }));

  const positive = avgR > 0;
  const goal = requiredEdge(sdR, 100, 0.9);

  return {
    stake, stopPct, sdR, avgR,
    perSignal: {
      position: avgR * riskPerTrade.position,
      risk: avgR * riskPerTrade.risk,
    },
    riskPerTrade,
    rows,
    requiredEdgeR: goal,
    gap: goal != null ? goal - avgR : null,
    positive,
    /*
     * Stated in the direction that matters. With a negative edge, more trades
     * is not more chances to get lucky — it is the law of large numbers doing
     * its job against you.
     */
    text: positive
      ? `При ставке $${stake} на сигнал каждый сигнал в среднем приносит ` +
        `$${(avgR * riskPerTrade.position).toFixed(2)} (если $${stake} — размер позиции). ` +
        'Чем больше сделок, тем надёжнее плюс.'
      : `При ставке $${stake} на сигнал каждый сигнал в среднем **теряет** ` +
        `$${Math.abs(avgR * riskPerTrade.position).toFixed(2)} (если $${stake} — размер позиции) ` +
        `или $${Math.abs(avgR * riskPerTrade.risk).toFixed(2)} (если $${stake} — сумма под риском). ` +
        'И главное: чем больше сделок, тем **меньше** шанс оказаться в плюсе. ' +
        'Терпение не спасает отрицательное преимущество — оно превращает его из ' +
        'невезения в закономерность.',
    goalText: goal == null ? null
      : `Чтобы после 100 сигналов быть в плюсе с уверенностью 90%, нужен край ` +
        `**+${goal.toFixed(3)}R** на сделку. Сейчас ${avgR.toFixed(3)}R — ` +
        `разрыв ${(goal - avgR).toFixed(3)}R. Для сравнения: одна только пошлина ` +
        'на этом таймфрейме около 0.11R, а вся геометрия стопа и цели даёт около 0.07R.',
  };
}
