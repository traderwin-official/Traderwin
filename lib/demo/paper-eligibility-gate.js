// Fail-closed eligibility checks before a future server-side DEMO paper simulation.
// This module has no side effects: it never writes trades, starts sessions, or calls a broker.
export function evaluateDemoPaperEligibility({
  accountMode,
  sessionStatus,
  botEnabled,
  emergencyStopped = false,
  instrument,
  instrumentActive,
  feedTrust,
  feedStatus,
  feedTimestamp,
  nowEpoch,
  maxFeedAgeSeconds = 30,
  signal,
  riskPerTradePct,
  maxDailyLossPct,
  dailyLossPct = 0,
  openPositions = 0,
  maxOpenPositions = 1
} = {}) {
  const reject = (reason) => ({ status: "BLOCKED", eligible: false, reason, paperOnly: true });

  if (accountMode !== "DEMO") return reject("DEMO_MODE_REQUIRED");
  if (sessionStatus !== "RUNNING") return reject("SESSION_NOT_RUNNING");
  if (botEnabled !== true) return reject("BOT_NOT_ENABLED");
  if (emergencyStopped === true) return reject("EMERGENCY_STOP_ACTIVE");
  if (typeof instrument !== "string" || !instrument.trim() || instrumentActive !== true) {
    return reject("INSTRUMENT_NOT_ACTIVE");
  }
  if (feedTrust !== "SERVER_VERIFIED" || feedStatus !== "LIVE") {
    return reject("SERVER_VERIFIED_LIVE_FEED_REQUIRED");
  }
  if (!Number.isFinite(feedTimestamp) || !Number.isFinite(nowEpoch) ||
      !Number.isInteger(maxFeedAgeSeconds) || maxFeedAgeSeconds < 1) {
    return reject("INVALID_FEED_TIMESTAMP");
  }
  const feedAge = nowEpoch - feedTimestamp;
  if (feedAge < -5) return reject("FEED_TIMESTAMP_FROM_FUTURE");
  if (feedAge > maxFeedAgeSeconds) return reject("MARKET_DATA_STALE");

  if (!signal || signal.status !== "SIGNAL" ||
      !["BUY", "SELL"].includes(signal.side) ||
      ![signal.referencePrice, signal.stopLoss, signal.takeProfit].every(
        (value) => Number.isFinite(value) && value > 0
      )) {
    return reject("VALID_TRADE_SIGNAL_REQUIRED");
  }
  if ((signal.side === "BUY" &&
       !(signal.stopLoss < signal.referencePrice && signal.takeProfit > signal.referencePrice)) ||
      (signal.side === "SELL" &&
       !(signal.takeProfit < signal.referencePrice && signal.stopLoss > signal.referencePrice))) {
    return reject("INVALID_SIGNAL_PROTECTIVE_LEVELS");
  }

  if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 2 ||
      !Number.isFinite(maxDailyLossPct) || maxDailyLossPct <= 0 || maxDailyLossPct > 10 ||
      !Number.isFinite(dailyLossPct) || dailyLossPct < 0 ||
      !Number.isInteger(openPositions) || openPositions < 0 ||
      !Number.isInteger(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > 10) {
    return reject("INVALID_RISK_CONFIGURATION");
  }
  if (dailyLossPct >= maxDailyLossPct) return reject("DAILY_LOSS_LIMIT_REACHED");
  if (openPositions >= maxOpenPositions) return reject("MAX_OPEN_POSITIONS_REACHED");

  return {
    status: "ELIGIBLE_FOR_PAPER_SIMULATION",
    eligible: true,
    paperOnly: true,
    instrument,
    side: signal.side,
    referencePrice: signal.referencePrice,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    feedAgeSeconds: feedAge,
    note: "Eligibility only. No trade was created, no session was changed, and no broker was contacted."
  };
}
