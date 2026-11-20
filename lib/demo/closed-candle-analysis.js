// Safe orchestration of completed OHLC candles into the DEMO strategy evaluator.
// No feed access, database writes, or trade execution occurs here.
import { evaluateDemoStrategy } from "./strategy-engine.js";

export function analyzeClosedCandles({
  candles,
  symbol,
  nowEpoch,
  timeframeSeconds = 900,
  maxAgeSeconds,
  fastPeriod = 5,
  slowPeriod = 20,
  ...risk
} = {}) {
  const effectiveMaxAge = maxAgeSeconds ?? timeframeSeconds * 2;
  if (!Array.isArray(candles) || typeof symbol !== "string" || !symbol.trim() ||
      !Number.isFinite(nowEpoch) || !Number.isInteger(timeframeSeconds) ||
      timeframeSeconds < 60 || timeframeSeconds > 86400 ||
      !Number.isInteger(effectiveMaxAge) || effectiveMaxAge < 1) {
    return { status: "REJECTED", reason: "INVALID_ANALYSIS_INPUT" };
  }

  const matching = candles.filter((c) => c && c.symbol === symbol && c.complete === true);
  if (matching.length < slowPeriod + 1) {
    return { status: "NO_SIGNAL", reason: "INSUFFICIENT_CLOSED_CANDLES", closedCandleCount: matching.length };
  }

  const ordered = matching.slice().sort((a, b) => Number(a.bucket_epoch) - Number(b.bucket_epoch));
  const seen = new Set();
  for (const candle of ordered) {
    const bucket = Number(candle.bucket_epoch);
    const values = [candle.open, candle.high, candle.low, candle.close].map(Number);
    if (!Number.isInteger(bucket) || bucket % timeframeSeconds !== 0 || seen.has(bucket) ||
        !values.every((v) => Number.isFinite(v) && v > 0) ||
        values[2] > Math.min(values[0], values[3]) ||
        values[1] < Math.max(values[0], values[3]) ||
        values[2] > values[1]) {
      return { status: "REJECTED", reason: "INVALID_CLOSED_CANDLE_HISTORY" };
    }
    if (bucket + timeframeSeconds > nowEpoch + 5) {
      return { status: "REJECTED", reason: "CANDLE_FROM_FUTURE" };
    }
    seen.add(bucket);
  }

  const latest = ordered.at(-1);
  const latestAge = nowEpoch - (Number(latest.bucket_epoch) + timeframeSeconds);
  if (latestAge > effectiveMaxAge) {
    return { status: "BLOCKED", reason: "CLOSED_CANDLE_DATA_STALE", latestCandleAgeSeconds: latestAge };
  }

  const analysis = evaluateDemoStrategy({
    candles: ordered.map((c) => ({ close: Number(c.close) })),
    fastPeriod,
    slowPeriod,
    ...risk
  });

  return {
    ...analysis,
    instrument: symbol,
    timeframeSeconds,
    dataStatus: "CLOSED_CANDLES_ONLY",
    latestCandleEpoch: Number(latest.bucket_epoch),
    latestCandleAgeSeconds: latestAge,
    note: analysis.note || "DEMO analysis only. Uses completed candles; no trade was opened."
  };
}
