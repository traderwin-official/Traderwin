// Young Tiger FX DEMO strategy evaluator.
// Pure deterministic analysis only: it creates suggestions, never broker orders.
const VALID_CANDLE = (c) => c && Number.isFinite(Number(c.close)) && Number(c.close) > 0;

function sma(values, period) {
  if (!Number.isInteger(period) || period < 1 || values.length < period) return null;
  const window = values.slice(-period);
  return window.reduce((sum, value) => sum + value, 0) / period;
}

export function evaluateDemoStrategy({
  candles,
  fastPeriod = 5,
  slowPeriod = 20,
  riskReward = 2,
  riskPerTradePct = 0.5,
  dailyLossPct = 0,
  maxDailyLossPct = 2,
  openPositions = 0,
  maxOpenPositions = 1
} = {}) {
  if (!Array.isArray(candles) || candles.length < slowPeriod + 1 ||
      !candles.every(VALID_CANDLE)) {
    return { status: "NO_SIGNAL", reason: "INSUFFICIENT_OR_INVALID_CANDLE_DATA" };
  }
  if (!Number.isInteger(fastPeriod) || !Number.isInteger(slowPeriod) ||
      fastPeriod < 2 || slowPeriod <= fastPeriod ||
      fastPeriod > 50 || slowPeriod > 200) {
    return { status: "REJECTED", reason: "INVALID_MA_PERIODS" };
  }
  if (!Number.isFinite(riskReward) || riskReward < 1 || riskReward > 5 ||
      !Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 2 ||
      !Number.isFinite(dailyLossPct) || dailyLossPct < 0 ||
      !Number.isFinite(maxDailyLossPct) || maxDailyLossPct <= 0 || maxDailyLossPct > 10 ||
      !Number.isInteger(openPositions) || openPositions < 0 ||
      !Number.isInteger(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > 10) {
    return { status: "REJECTED", reason: "INVALID_RISK_CONFIGURATION" };
  }
  if (dailyLossPct >= maxDailyLossPct) {
    return { status: "BLOCKED", reason: "DAILY_LOSS_LIMIT_REACHED" };
  }
  if (openPositions >= maxOpenPositions) {
    return { status: "BLOCKED", reason: "MAX_OPEN_POSITIONS_REACHED" };
  }

  const closes = candles.map((c) => Number(c.close));
  const previousFast = sma(closes.slice(0, -1), fastPeriod);
  const previousSlow = sma(closes.slice(0, -1), slowPeriod);
  const currentFast = sma(closes, fastPeriod);
  const currentSlow = sma(closes, slowPeriod);
  const price = closes.at(-1);
  const prevPrice = closes.at(-2);

  let side = null;
  if (previousFast <= previousSlow && currentFast > currentSlow && price > prevPrice) side = "BUY";
  if (previousFast >= previousSlow && currentFast < currentSlow && price < prevPrice) side = "SELL";
  if (!side) return { status: "NO_SIGNAL", reason: "NO_CONFIRMED_SMA_CROSS", indicators: { fast: currentFast, slow: currentSlow } };

  // Risk levels are a simple price-distance illustration, not instrument-specific sizing.
  const riskDistance = Math.abs(price * riskPerTradePct / 100);
  const stopLoss = side === "BUY" ? price - riskDistance : price + riskDistance;
  const takeProfit = side === "BUY" ? price + riskDistance * riskReward : price - riskDistance * riskReward;
  return {
    status: "SIGNAL",
    side,
    referencePrice: price,
    stopLoss,
    takeProfit,
    riskReward,
    indicators: { fast: currentFast, slow: currentSlow },
    note: "DEMO analysis only. No trade was opened. Risk-distance levels are illustrative and are not broker tick-size or contract-value adjusted."
  };
}
