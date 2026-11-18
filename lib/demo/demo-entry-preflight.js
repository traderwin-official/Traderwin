// Young Tiger FX final fail-closed DEMO entry preflight.
// This is a decision coordinator, not an execution endpoint. Call only from a
// trusted server process using server-fetched quotes, account data and positions.
import { evaluatePortfolioRisk } from "./portfolio-risk-guardian.js";
import { evaluatePortfolioExposure } from "./portfolio-exposure-guard.js";

const reject = (reason, details = {}) => ({
  status: "BLOCKED", allowed: false, paperOnly: true, reason, ...details
});

export function evaluateDemoEntryPreflight({
  accountMode,
  sessionStatus,
  botEnabled,
  emergencyStopped = false,
  instrument,
  quote,
  nowEpoch,
  maxQuoteAgeSeconds = 10,
  signal,
  sizing,
  brokerConstraintsPassed,
  marginCheckPassed,
  portfolioRisk,
  exposureRisk
} = {}) {
  if (accountMode !== "DEMO") return reject("DEMO_MODE_REQUIRED");
  if (sessionStatus !== "RUNNING") return reject("SESSION_NOT_RUNNING");
  if (botEnabled !== true) return reject("BOT_NOT_ENABLED");
  if (emergencyStopped === true) return reject("EMERGENCY_STOP_ACTIVE");

  if (typeof instrument !== "string" || !instrument.trim() ||
      !quote || quote.symbol !== instrument ||
      quote.provider !== "DERIV_SERVER_ADAPTER" ||
      quote.status !== "LIVE" ||
      !Number.isFinite(quote.timestamp) || !Number.isFinite(nowEpoch) ||
      !Number.isInteger(maxQuoteAgeSeconds) || maxQuoteAgeSeconds < 1 ||
      !Number.isFinite(quote.bid) || quote.bid <= 0 ||
      !Number.isFinite(quote.ask) || quote.ask < quote.bid) {
    return reject("INVALID_SERVER_MARKET_SNAPSHOT");
  }
  const quoteAgeSeconds = nowEpoch - quote.timestamp;
  if (quoteAgeSeconds < -2) return reject("MARKET_SNAPSHOT_FROM_FUTURE");
  if (quoteAgeSeconds > maxQuoteAgeSeconds) return reject("MARKET_SNAPSHOT_STALE");

  if (!signal || signal.status !== "SIGNAL" ||
      signal.instrument !== instrument ||
      !["BUY", "SELL"].includes(signal.side) ||
      ![signal.referencePrice, signal.stopLoss, signal.takeProfit].every(
        (v) => Number.isFinite(v) && v > 0
      )) return reject("VALID_INSTRUMENT_SIGNAL_REQUIRED");

  const mid = (quote.bid + quote.ask) / 2;
  if (Math.abs(signal.referencePrice - mid) > (quote.ask - quote.bid) * 2) {
    return reject("SIGNAL_PRICE_OUTSIDE_CURRENT_QUOTE");
  }
  if ((signal.side === "BUY" &&
       !(signal.stopLoss < mid && signal.takeProfit > mid)) ||
      (signal.side === "SELL" &&
       !(signal.takeProfit < mid && signal.stopLoss > mid))) {
    return reject("INVALID_SIGNAL_PROTECTIVE_LEVELS");
  }

  if (!sizing || sizing.status !== "VALIDATED" ||
      !Number.isFinite(sizing.proposedRiskMoney) || sizing.proposedRiskMoney <= 0 ||
      !Number.isFinite(sizing.quantity) || sizing.quantity <= 0 ||
      brokerConstraintsPassed !== true || marginCheckPassed !== true) {
    return reject("BROKER_SIZING_OR_MARGIN_CHECK_FAILED");
  }

  if (!portfolioRisk || typeof portfolioRisk !== "object" ||
      !exposureRisk || typeof exposureRisk !== "object") {
    return reject("SERVER_PORTFOLIO_RISK_CONTEXT_REQUIRED");
  }

  const portfolio = evaluatePortfolioRisk({
    ...portfolioRisk,
    accountMode: "DEMO",
    botEnabled,
    emergencyStopped,
    proposedRiskMoney: sizing.proposedRiskMoney
  });
  if (!portfolio.allowed) return reject(portfolio.reason, { portfolioRisk: portfolio });

  const exposure = evaluatePortfolioExposure(exposureRisk);
  if (!exposure.allowed) return reject(exposure.reason, { exposureRisk: exposure });

  return {
    status: "ELIGIBLE_FOR_DEMO_PAPER_ENTRY",
    allowed: true,
    paperOnly: true,
    instrument,
    side: signal.side,
    quoteProvider: quote.provider,
    quoteAgeSeconds,
    quantity: sizing.quantity,
    proposedRiskMoney: sizing.proposedRiskMoney,
    portfolioRisk: portfolio,
    exposureRisk: exposure,
    note: "Preflight approval only. No trade was created. The server must re-fetch account, quote, positions, margin and risk data and repeat all checks immediately before any paper-trade write."
  };
}
