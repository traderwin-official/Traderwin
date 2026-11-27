const DIRECTIONS = new Set(["BUY", "SELL", "NEUTRAL"]);
const CATEGORIES = new Set([
  "technical", "multi_timeframe", "price_action", "liquidity",
  "order_flow", "sentiment", "news", "volatility", "fundamental"
]);
const CHART_CATEGORIES = new Set([
  "technical", "multi_timeframe", "price_action", "liquidity", "order_flow", "volatility"
]);
const TIMEFRAME_RANK = Object.freeze({
  M1: 1, M2: 2, M3: 3, M5: 4, M10: 5, M15: 6, M30: 7,
  H1: 8, H2: 9, H4: 10, H6: 11, H8: 12, H12: 13, D1: 14, W1: 15, MN1: 16
});
const WEIGHTS = Object.freeze({
  technical: 1.2, multi_timeframe: 1.4, price_action: 1.3,
  liquidity: 1.2, order_flow: 1.1, sentiment: 0.7,
  news: 1.0, volatility: 0.8, fundamental: 0.8
});
const finite = Number.isFinite;

// Only server-side adapters in this process can mint accepted evidence.
// A caller-provided boolean is not an authentication mechanism.
const trustedEvidence = new WeakSet();
export function attestMarketEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new TypeError("Market evidence must be an object.");
  }
  const attested = Object.freeze({ ...evidence, adapterVerified: true });
  trustedEvidence.add(attested);
  return attested;
}

/**
 * Conservative, source-audited signal fusion for fast M1/M5 entries.
 * This module does not fetch data or place orders. Evidence must be created by
 * trusted server-side adapters and must carry an explicit adapter attestation,
 * instrument identity, applicable timeframe identity and provider timestamp.
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
  const normalizedInstrument = String(instrument || "").trim().toUpperCase();
  const tf = String(timeframe || "").trim().toUpperCase();
  const scalp = tf === "M1" || tf === "M5";
  const reasons = [];
  if (!/^[A-Z0-9_]{2,24}$/.test(normalizedInstrument)) {
    return { direction: "WAIT", confidence: 0, reasons: ["INVALID_INSTRUMENT"], evidence: [] };
  }
  if (!Object.hasOwn(TIMEFRAME_RANK, tf)) {
    return { direction: "WAIT", confidence: 0, reasons: ["INVALID_TIMEFRAME"], evidence: [] };
  }
  if (!Array.isArray(evidence)) {
    return { direction: "WAIT", confidence: 0, reasons: ["INVALID_EVIDENCE"], evidence: [] };
  }
  if (!finite(now) || !finite(maxAgeMs) || maxAgeMs <= 0 ||
      !Number.isInteger(minimumCategories) || minimumCategories < 1 ||
      !Number.isInteger(minimumIndependentSources) || minimumIndependentSources < 1 ||
      !finite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 100 ||
      !finite(minimumAgreement) || minimumAgreement < 0 || minimumAgreement > 1) {
    return { direction: "WAIT", confidence: 0, reasons: ["INVALID_QUALITY_CONFIGURATION"], evidence: [] };
  }
  if (evidence.length > 200) {
    return { direction: "WAIT", confidence: 0, reasons: ["EVIDENCE_LIMIT_EXCEEDED"], evidence: [] };
  }

  const marketContext = market && typeof market === "object" ? market : {};
  const riskContext = risk && typeof risk === "object" ? risk : {};
  const accepted = [];
  const seen = new Set();
  let unverifiedEvidenceCount = 0;
  let contextMismatchCount = 0;
  let staleEvidenceCount = 0;

  for (const item of evidence) {
    if (!item || !CATEGORIES.has(item.category) || !DIRECTIONS.has(item.direction) ||
        typeof item.source !== "string" || !item.source.trim() ||
        !finite(item.confidence) || item.confidence < 0 || item.confidence > 100) continue;

    if (!trustedEvidence.has(item)) {
      unverifiedEvidenceCount++;
      continue;
    }
    if (typeof item.instrument !== "string" ||
        item.instrument.trim().toUpperCase() !== normalizedInstrument) {
      contextMismatchCount++;
      continue;
    }
    if (CHART_CATEGORIES.has(item.category)) {
      if (item.category === "multi_timeframe") {
        const frames = Array.isArray(item.timeframes)
          ? [...new Set(item.timeframes.map(value => String(value || "").trim().toUpperCase())
            .filter(value => Object.hasOwn(TIMEFRAME_RANK, value)))]
          : [];
        const hasRequestedFrame = frames.includes(tf);
        const hasHigherFrame = frames.some(frame => TIMEFRAME_RANK[frame] > TIMEFRAME_RANK[tf]);
        if (!hasRequestedFrame || !hasHigherFrame) {
          contextMismatchCount++;
          continue;
        }
      } else if (String(item.timeframe || "").trim().toUpperCase() !== tf) {
        contextMismatchCount++;
        continue;
      }
    }

    const stamp = Date.parse(item.asOf);
    const age = now - stamp;
    if (!finite(stamp) || age < 0 || age > maxAgeMs) {
      staleEvidenceCount++;
      continue;
    }
    const sourceKey = item.source.trim().toLowerCase();
    const key = `${item.category}:${sourceKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push({
      category: item.category,
      direction: item.direction,
      source: item.source.trim(),
      adapterVerified: true,
      instrument: normalizedInstrument,
      timeframe: CHART_CATEGORIES.has(item.category) ? tf : null,
      asOf: new Date(stamp).toISOString(),
      ageMs: age,
      confidence: item.confidence,
      weight: WEIGHTS[item.category],
      detail: typeof item.detail === "string" ? item.detail.slice(0, 240) : null
    });
  }

  if (unverifiedEvidenceCount > 0) reasons.push("UNVERIFIED_EVIDENCE_SOURCE");
  if (contextMismatchCount > 0) reasons.push("EVIDENCE_CONTEXT_MISMATCH");
  if (staleEvidenceCount > 0) reasons.push("STALE_OR_INVALID_EVIDENCE");

  const categories = [...new Set(accepted.map(x => x.category))];
  const sources = [...new Set(accepted.map(x => x.source.trim().toLowerCase()))];
  const required = scalp
    ? ["technical", "multi_timeframe", "price_action", "liquidity"]
    : ["technical", "multi_timeframe", "price_action"];
  for (const category of required) {
    if (!categories.includes(category)) reasons.push(`MISSING_${category.toUpperCase()}_CONFIRMATION`);
  }
  if (categories.length < minimumCategories) reasons.push("INSUFFICIENT_SIGNAL_CATEGORIES");
  if (sources.length < minimumIndependentSources) reasons.push("INSUFFICIENT_INDEPENDENT_SOURCES");

  const spreadMissing = riskContext.spreadBps === null || riskContext.spreadBps === undefined || riskContext.spreadBps === "";
  const maxSpreadMissing = riskContext.maxSpreadBps === null || riskContext.maxSpreadBps === undefined || riskContext.maxSpreadBps === "";
  const spread = Number(riskContext.spreadBps);
  const maxSpread = Number(riskContext.maxSpreadBps);
  if (spreadMissing || maxSpreadMissing || !finite(spread) || !finite(maxSpread) || spread < 0 || maxSpread <= 0) {
    reasons.push("SPREAD_DATA_UNAVAILABLE");
  } else if (spread > maxSpread) reasons.push("SPREAD_TOO_WIDE");

  const rrMissing = riskContext.riskReward === null || riskContext.riskReward === undefined || riskContext.riskReward === "";
  const rr = Number(riskContext.riskReward);
  const configuredMinRr = riskContext.minimumRiskReward;
  const minRr = configuredMinRr !== null && configuredMinRr !== undefined && configuredMinRr !== "" && finite(Number(configuredMinRr))
    ? Number(configuredMinRr) : 1.5;
  if (rrMissing || !finite(rr) || rr < minRr) reasons.push("RISK_REWARD_BELOW_MINIMUM");
  if (riskContext.independentReferenceRequired === true && riskContext.independentReferenceStatus !== "PASS") {
    reasons.push(riskContext.independentReferenceStatus === "BLOCK"
      ? "INDEPENDENT_REFERENCE_DIVERGENCE"
      : "INDEPENDENT_REFERENCE_NOT_VERIFIED");
  }
  if (riskContext.entryTriggerConfirmed !== true) reasons.push("ENTRY_TRIGGER_NOT_CONFIRMED");
  if (riskContext.highImpactNewsWindow === true || riskContext.newsStatus === "BLACKOUT") {
    reasons.push("HIGH_IMPACT_NEWS_BLACKOUT");
  } else if (riskContext.newsStatus !== "CLEAR") {
    reasons.push("NEWS_STATUS_NOT_VERIFIED");
  }
  if (marketContext.tradable !== true) reasons.push("MARKET_NOT_VERIFIED_TRADABLE");
  if (marketContext.quoteFresh !== true) reasons.push("QUOTE_NOT_FRESH");
  if (marketContext.candleClosed !== true) reasons.push("ENTRY_CANDLE_NOT_CLOSED");

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
  // Confidence is a signal-quality score, not a probability of profit.
  // Agreement remains dominant; evidence breadth is only a bounded modifier.
  const breadth = Math.min(categories.length, 7) / 7;
  const confidence = total > 0
    ? Math.round(Math.min(99, 100 * agreement * (0.65 + 0.35 * breadth)))
    : 0;
  if (direction === "WAIT") reasons.push("NO_DIRECTIONAL_EDGE");
  if (agreement < minimumAgreement) reasons.push("SIGNAL_CONFLICT_OR_WEAK_AGREEMENT");
  if (confidence < minimumConfidence) reasons.push("CONFIDENCE_BELOW_THRESHOLD");

  const blocked = reasons.length > 0;
  return {
    instrument: normalizedInstrument,
    timeframe: tf,
    mode: scalp ? "SENSITIVE_SCALPING" : "MULTI_TIMEFRAME",
    direction: blocked ? "WAIT" : direction,
    confidence,
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
