const DIRECTIONS = new Set(["BUY", "SELL", "NEUTRAL"]);
const CATEGORIES = new Set([
  "technical", "multi_timeframe", "price_action", "liquidity",
  "order_flow", "sentiment", "news", "volatility", "fundamental"
]);
const WEIGHTS = Object.freeze({
  technical: 1.2, multi_timeframe: 1.4, price_action: 1.3,
  liquidity: 1.2, order_flow: 1.1, sentiment: 0.7,
  news: 1.0, volatility: 0.8, fundamental: 0.8
});
const finite = Number.isFinite;

/**
 * Conservative, source-audited signal fusion for fast M1/M5 entries.
 * This module does not fetch data or place orders. Only verified, timestamped
 * evidence supplied by trusted server-side adapters may be passed here.
 */
export function evaluateMarketConfluence({
  instrument,
  timeframe,
  evidence = [],
  market = {},
  risk = {},
  now = Date.now(),
  maxAgeMs = 120000,
  minimumCategories = 4,
  minimumIndependentSources = 3,
  minimumConfidence = 72,
  minimumAgreement = 0.76
} = {}) {
  const tf = String(timeframe || "").toUpperCase();
  const scalp = tf === "M1" || tf === "M5";
  const reasons = [];
  if (!/^[A-Z0-9_]{2,24}$/.test(String(instrument || "").toUpperCase())) {
    return { direction: "WAIT", confidence: 0, reasons: ["INVALID_INSTRUMENT"], evidence: [] };
  }
  if (!Array.isArray(evidence)) {
    return { direction: "WAIT", confidence: 0, reasons: ["INVALID_EVIDENCE"], evidence: [] };
  }
  if (scalp && evidence.length > 100) {
    return { direction: "WAIT", confidence: 0, reasons: ["EVIDENCE_LIMIT_EXCEEDED"], evidence: [] };
  }

  const accepted = [];
  const seen = new Set();
  for (const item of evidence) {
    if (!item || !CATEGORIES.has(item.category) || !DIRECTIONS.has(item.direction) ||
        typeof item.source !== "string" || !item.source.trim() ||
        !finite(item.confidence) || item.confidence < 0 || item.confidence > 100) continue;
    const stamp = Date.parse(item.asOf);
    const age = now - stamp;
    if (!finite(stamp) || age < 0 || age > maxAgeMs) continue;
    const key = `${item.category}:${item.source.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push({
      category: item.category,
      direction: item.direction,
      source: item.source.trim(),
      asOf: new Date(stamp).toISOString(),
      ageMs: age,
      confidence: item.confidence,
      weight: WEIGHTS[item.category],
      detail: typeof item.detail === "string" ? item.detail.slice(0, 240) : null
    });
  }

  const categories = [...new Set(accepted.map(x => x.category))];
  const sources = [...new Set(accepted.map(x => x.source))];
  const required = scalp
    ? ["technical", "multi_timeframe", "price_action", "liquidity"]
    : ["technical", "multi_timeframe", "price_action"];
  for (const category of required) {
    if (!categories.includes(category)) reasons.push(`MISSING_${category.toUpperCase()}_CONFIRMATION`);
  }
  if (categories.length < minimumCategories) reasons.push("INSUFFICIENT_SIGNAL_CATEGORIES");
  if (sources.length < minimumIndependentSources) reasons.push("INSUFFICIENT_INDEPENDENT_SOURCES");

  const spread = Number(risk.spreadBps);
  const maxSpread = Number(risk.maxSpreadBps);
  if (!finite(spread) || !finite(maxSpread) || spread < 0 || maxSpread <= 0) {
    reasons.push("SPREAD_DATA_UNAVAILABLE");
  } else if (spread > maxSpread) reasons.push("SPREAD_TOO_WIDE");

  const rr = Number(risk.riskReward);
  const minRr = finite(Number(risk.minimumRiskReward)) ? Number(risk.minimumRiskReward) : 1.5;
  if (!finite(rr) || rr < minRr) reasons.push("RISK_REWARD_BELOW_MINIMUM");
  if (risk.entryTriggerConfirmed !== true) reasons.push("ENTRY_TRIGGER_NOT_CONFIRMED");
  if (risk.highImpactNewsWindow === true) reasons.push("HIGH_IMPACT_NEWS_BLACKOUT");
  if (market.tradable !== true) reasons.push("MARKET_NOT_VERIFIED_TRADABLE");
  if (market.quoteFresh !== true) reasons.push("QUOTE_NOT_FRESH");
  if (market.candleClosed !== true) reasons.push("ENTRY_CANDLE_NOT_CLOSED");

  let buy = 0, sell = 0, total = 0;
  for (const item of accepted) {
    const contribution = item.weight * item.confidence / 100;
    if (item.direction === "BUY") buy += contribution;
    if (item.direction === "SELL") sell += contribution;
    if (item.direction !== "NEUTRAL") total += contribution;
  }
  const direction = buy === sell ? "WAIT" : buy > sell ? "BUY" : "SELL";
  const winning = Math.max(buy, sell);
  const agreement = total > 0 ? winning / total : 0;
  const confidence = total > 0
    ? Math.round(Math.min(99, 100 * agreement * (Math.min(categories.length, 7) / 7)))
    : 0;
  if (direction === "WAIT") reasons.push("NO_DIRECTIONAL_EDGE");
  if (agreement < minimumAgreement) reasons.push("SIGNAL_CONFLICT_OR_WEAK_AGREEMENT");
  if (confidence < minimumConfidence) reasons.push("CONFIDENCE_BELOW_THRESHOLD");

  const blocked = reasons.length > 0;
  return {
    instrument: String(instrument).toUpperCase(),
    timeframe: tf,
    mode: scalp ? "SENSITIVE_SCALPING" : "MULTI_TIMEFRAME",
    direction: blocked ? "WAIT" : direction,
    confidence: blocked ? confidence : confidence,
    agreement: Number(agreement.toFixed(4)),
    score: { buy: Number(buy.toFixed(4)), sell: Number(sell.toFixed(4)) },
    categories,
    independentSources: sources.length,
    acceptedEvidence: accepted,
    rejectedEvidenceCount: evidence.length - accepted.length,
    reasons,
    decision: blocked ? "NO_TRADE" : "SIGNAL_READY_FOR_RISK_GATE",
    executionAuthorized: false,
    disclaimer: "Analysis only. A separate broker adapter and explicit account authorization are required for execution."
  };
}
