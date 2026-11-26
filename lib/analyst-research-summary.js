const asArray = value => Array.isArray(value) ? value : [];
const cleanText = (value, max = 180) => typeof value === "string" ? value.trim().slice(0, max) : null;
const finite = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));

/**
 * Combines independently sourced analyst outputs into one auditable research
 * snapshot. This is presentation/context aggregation only: it never promotes
 * UNKNOWN to CLEAR and never authorizes execution.
 */
export function buildAnalystResearchSummary({
  instrument,
  timeframe,
  candidate,
  tradePlan,
  marketData,
  marketIntelligence,
  newsContext,
  newsRisk,
  calendarRisk,
  goldReference,
  goldReferenceComparison,
  analysedAt
} = {}) {
  const symbol = cleanText(instrument, 24)?.toUpperCase() || "UNKNOWN";
  const technical = candidate && typeof candidate === "object" ? candidate : {};
  const gate = marketIntelligence && typeof marketIntelligence === "object" ? marketIntelligence : {};
  const headlines = asArray(newsContext?.articles).slice(0, 5).map(item => ({
    title: cleanText(item?.title, 240),
    source: cleanText(item?.domain, 120),
    publishedAt: cleanText(item?.publishedAt, 40),
    topic: cleanText(item?.macroTopic, 40) || "GENERAL_MARKET",
    relevance: item?.relevance && finite(item.relevance.score)
      ? { score: Number(item.relevance.score), level: cleanText(item.relevance.level, 12) || "UNKNOWN" }
      : { score: null, level: "UNKNOWN" },
    tone: cleanText(item?.tone, 32) || "UNCLASSIFIED"
  })).filter(item => item.title);
  const calendarSeen = new Set();
  const calendarEvents = [
    ...asArray(calendarRisk?.events).map(event => ({ ...event, timing: "BLACKOUT_WINDOW" })),
    ...asArray(calendarRisk?.upcomingEvents).map(event => ({ ...event, timing: "UPCOMING" }))
  ].filter(event => {
    const key = [
      cleanText(event?.name, 180)?.toLowerCase() || "",
      cleanText(event?.currency, 8)?.toUpperCase() || "",
      cleanText(event?.time, 48) || ""
    ].join("|");
    if (calendarSeen.has(key)) return false;
    calendarSeen.add(key);
    return true;
  }).slice(0, 10).map(event => ({
    name: cleanText(event?.name, 180),
    category: cleanText(event?.category, 40) || "OTHER_MACRO",
    currency: cleanText(event?.currency, 8),
    source: cleanText(event?.source, 120),
    time: cleanText(event?.time, 48),
    timeMode: cleanText(event?.timeMode, 24) || "UNKNOWN",
    timing: event.timing,
    relevance: event?.relevance && finite(event.relevance.score)
      ? { score: Number(event.relevance.score), level: cleanText(event.relevance.level, 12) || "UNKNOWN" }
      : { score: null, level: "UNKNOWN" }
  })).filter(event => event.name);
  const riskFlags = [];
  if (newsRisk?.status === "BLACKOUT") riskFlags.push("ADVERSE_NEWS_BLACKOUT");
  if (calendarRisk?.status === "BLACKOUT") riskFlags.push("ECONOMIC_CALENDAR_BLACKOUT");
  if (newsRisk?.status !== "CLEAR") riskFlags.push("ADVERSE_NEWS_CLEARANCE_UNVERIFIED");
  if (calendarRisk?.status !== "CLEAR") riskFlags.push("CALENDAR_CLEARANCE_UNVERIFIED");
  if (marketData?.quoteStatus !== "FRESH") riskFlags.push("FRESH_EXECUTABLE_QUOTE_UNVERIFIED");
  if (marketData?.approvalStatus !== "APPROVED") riskFlags.push("INSTRUMENT_APPROVAL_UNVERIFIED");
  if (marketData?.multiTimeframeStatus !== "ALIGNED") riskFlags.push("MULTI_TIMEFRAME_NOT_ALIGNED");
  if (symbol === "XAUUSD" && marketData?.goldReferenceStatus !== "PASS") {
    riskFlags.push(marketData?.goldReferenceStatus === "BLOCK"
      ? "INDEPENDENT_GOLD_REFERENCE_DIVERGENCE"
      : "INDEPENDENT_GOLD_REFERENCE_NOT_VERIFIED");
  }
  for (const reason of asArray(gate?.reasons)) {
    if (typeof reason === "string" && !riskFlags.includes(reason)) riskFlags.push(reason);
  }
  const calendarStatus = cleanText(calendarRisk?.status, 20) || "UNKNOWN";
  const adverseNewsStatus = cleanText(newsRisk?.status, 20) || "UNKNOWN";
  const gold = symbol === "XAUUSD" ? {
    referenceStatus: cleanText(goldReference?.status, 24) || "UNKNOWN",
    referencePrice: finite(goldReference?.price) ? Number(goldReference.price) : null,
    deviationBps: finite(goldReferenceComparison?.deviationBps)
      ? Number(goldReferenceComparison.deviationBps) : null,
    comparisonStatus: cleanText(goldReferenceComparison?.status, 24) || "UNKNOWN",
    disclaimer: "Indicative independent reference; not an executable broker quote."
  } : null;
  const gateDecision = cleanText(gate?.decision, 40) || "UNKNOWN";
  return {
    schemaVersion: 1,
    instrument: symbol,
    timeframe: cleanText(timeframe, 8)?.toUpperCase() || "UNKNOWN",
    analysedAt: cleanText(analysedAt, 48),
    researchOnly: true,
    technical: {
      candidateDirection: cleanText(technical?.direction, 12) || "WAIT",
      candidateConfidence: finite(technical?.confidence) ? Number(technical.confidence) : 0,
      multiTimeframeStatus: cleanText(technical?.multiTimeframe?.status, 40) || "UNKNOWN",
      higherTimeframe: cleanText(technical?.multiTimeframe?.higherTimeframe, 8),
      higherTimeframeDirection: cleanText(technical?.multiTimeframe?.higherTimeframeDirection, 12) || "UNKNOWN",
      explanation: cleanText(technical?.explanation, 500)
    },
    fundamental: {
      calendarStatus,
      adverseNewsStatus,
      upcomingAndBlackoutEvents: calendarEvents,
      contextualHeadlines: headlines,
      headlineFeedStatus: cleanText(newsContext?.status, 32) || "UNKNOWN",
      headlineFeedSource: cleanText(newsContext?.source, 80) || "UNKNOWN"
    },
    marketQuality: {
      quoteStatus: cleanText(marketData?.quoteStatus, 32) || "UNKNOWN",
      quoteAsOf: cleanText(marketData?.quoteAsOf, 48),
      spreadBps: finite(marketData?.spreadBps) ? Number(marketData.spreadBps) : null,
      instrumentApproval: cleanText(marketData?.approvalStatus, 32) || "UNKNOWN",
      tradePlanStatus: cleanText(marketData?.tradePlanStatus || tradePlan?.status, 32) || "UNKNOWN"
    },
    goldReference: gold,
    risk: {
      flags: [...new Set(riskFlags)],
      marketGateDecision: gateDecision,
      marketGateDirection: cleanText(gate?.direction, 12) || "WAIT",
      marketGateConfidence: finite(gate?.confidence) ? Number(gate.confidence) : 0
    },
    execution: {
      authorized: false,
      mode: "RESEARCH_ONLY",
      orderAction: "NONE",
      reason: "Research aggregation never authorizes broker or paper execution."
    },
    limitations: [
      "Macro relevance and headline topics are deterministic context labels, not causal impact or price direction.",
      "UNKNOWN source status is not CLEAR; missing or incomplete evidence remains a risk flag.",
      "Technical confidence is a quality score, not a probability of profit."
    ]
  };
}
