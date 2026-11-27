import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalystResearchSummary } from "../lib/analyst-research-summary.js";

test("combines technical, calendar, headline and market-quality context in one research snapshot", () => {
  const summary = buildAnalystResearchSummary({
    instrument: "XAUUSD",
    timeframe: "M15",
    candidate: {
      direction: "BUY", confidence: 78, explanation: "Higher timeframe agrees.",
      multiTimeframe: { status: "ALIGNED", higherTimeframe: "H1", higherTimeframeDirection: "BUY" }
    },
    tradePlan: { status: "INDICATIVE_ONLY" },
    marketData: { quoteStatus: "FRESH", quoteAsOf: "2026-11-26T12:00:00Z", spreadBps: 3, approvalStatus: "APPROVED", multiTimeframeStatus: "ALIGNED", tradePlanStatus: "INDICATIVE_ONLY" },
    marketIntelligence: { decision: "NO_TRADE", direction: "WAIT", confidence: 0, reasons: ["NEWS_STATUS_NOT_VERIFIED"] },
    newsContext: { status: "HEADLINES_AVAILABLE", source: "GDELT_DOC_API", articles: [{ title: "Fed rate decision", domain: "news.test", publishedAt: "2026-11-26T11:00:00Z", macroTopic: "MONETARY_POLICY", relevance: { score: 100, level: "HIGH" }, tone: "UNCLASSIFIED" }] },
    newsRisk: { status: "UNKNOWN" },
    calendarRisk: { status: "UNKNOWN", events: [], upcomingEvents: [{ name: "US CPI", category: "INFLATION", currency: "USD", source: "BiQuote", time: "2026-11-26T15:00:00Z", timeMode: "EXACT", relevance: { score: 100, level: "HIGH" } }] },
    goldReference: { status: "AVAILABLE", price: 2650 },
    goldReferenceComparison: { status: "WITHIN_TOLERANCE", deviationBps: 12 },
    analysedAt: "2026-11-26T12:00:00Z"
  });
  assert.equal(summary.technical.candidateDirection, "BUY");
  assert.equal(summary.fundamental.upcomingAndBlackoutEvents[0].category, "INFLATION");
  assert.equal(summary.fundamental.contextualHeadlines[0].relevance.score, 100);
  assert.equal(summary.goldReference.deviationBps, 12);
  assert.ok(summary.risk.flags.includes("CALENDAR_CLEARANCE_UNVERIFIED"));
  assert.equal(summary.risk.marketGateDecision, "NO_TRADE");
  assert.equal(summary.execution.authorized, false);
  assert.equal(summary.execution.orderAction, "NONE");
});

test("does not turn absent providers into CLEAR or invent price levels", () => {
  const summary = buildAnalystResearchSummary({
    instrument: "EURUSD",
    candidate: {},
    marketData: {},
    marketIntelligence: {},
    newsContext: {},
    newsRisk: {},
    calendarRisk: {}
  });
  assert.equal(summary.fundamental.calendarStatus, "UNKNOWN");
  assert.equal(summary.fundamental.adverseNewsStatus, "UNKNOWN");
  assert.equal(summary.marketQuality.spreadBps, null);
  assert.ok(summary.risk.flags.includes("ADVERSE_NEWS_CLEARANCE_UNVERIFIED"));
  assert.ok(summary.risk.flags.includes("FRESH_EXECUTABLE_QUOTE_UNVERIFIED"));
  assert.equal(summary.execution.authorized, false);
});

test("never mixes XAUUSD reference prices into other instruments", () => {
  const summary = buildAnalystResearchSummary({
    instrument: "BTCUSD",
    goldReference: { status: "AVAILABLE", price: 2650 },
    goldReferenceComparison: { deviationBps: 10 }
  });
  assert.equal(summary.goldReference, null);
  assert.equal(summary.instrument, "BTCUSD");
});


test("flags a missing or divergent independent XAUUSD reference in the consolidated risk summary", () => {
  const missing = buildAnalystResearchSummary({
    instrument: "XAUUSD", marketData: { goldReferenceStatus: "UNKNOWN" }
  });
  assert.ok(missing.risk.flags.includes("INDEPENDENT_GOLD_REFERENCE_NOT_VERIFIED"));
  const divergent = buildAnalystResearchSummary({
    instrument: "XAUUSD", marketData: { goldReferenceStatus: "BLOCK" }
  });
  assert.ok(divergent.risk.flags.includes("INDEPENDENT_GOLD_REFERENCE_DIVERGENCE"));
  const notGold = buildAnalystResearchSummary({
    instrument: "EURUSD", marketData: { goldReferenceStatus: "UNKNOWN" }
  });
  assert.ok(!notGold.risk.flags.includes("INDEPENDENT_GOLD_REFERENCE_NOT_VERIFIED"));
});


test("deduplicates date-only events that appear in both blackout and upcoming calendar lists", () => {
  const sameEvent = {
    name: "US CPI", category: "INFLATION", currency: "USD",
    time: "2026-11-26T00:00:00.000Z", timeMode: "DATE"
  };
  const summary = buildAnalystResearchSummary({
    instrument: "XAUUSD",
    calendarRisk: {
      status: "BLACKOUT",
      events: [sameEvent],
      upcomingEvents: [sameEvent]
    }
  });
  assert.equal(summary.fundamental.upcomingAndBlackoutEvents.length, 1);
  assert.equal(summary.fundamental.upcomingAndBlackoutEvents[0].timing, "BLACKOUT_WINDOW");
});
