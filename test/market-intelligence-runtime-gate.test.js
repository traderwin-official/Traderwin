import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateMarketCandidate } from "../lib/market-intelligence-gate.js";

const now = Date.parse("2026-11-26T06:30:00.000Z");
const asOf = new Date(now - 1000).toISOString();
const base = {
  instrument: "XAUUSD",
  timeframe: "M1",
  direction: "BUY",
  confidence: 91,
  source: "DERIV",
  asOf,
  market: { tradable: true, quoteFresh: true, candleClosed: true },
  risk: {
    spreadBps: 1,
    maxSpreadBps: 3,
    riskReward: 2,
    minimumRiskReward: 1.5,
    entryTriggerConfirmed: true,
    newsStatus: "UNKNOWN"
  },
  now
};

test("one verified Deriv candidate remains WAIT without independent evidence and clear news", () => {
  const result = evaluateMarketCandidate(base);
  assert.equal(result.direction, "WAIT");
  assert.equal(result.independentSources, 1);
  assert.ok(result.reasons.includes("INSUFFICIENT_INDEPENDENT_SOURCES"));
  assert.ok(result.reasons.includes("MISSING_MULTI_TIMEFRAME_CONFIRMATION"));
  assert.ok(result.reasons.includes("MISSING_PRICE_ACTION_CONFIRMATION"));
  assert.ok(result.reasons.includes("MISSING_LIQUIDITY_CONFIRMATION"));
  assert.ok(result.reasons.includes("NEWS_STATUS_NOT_VERIFIED"));
  assert.equal(result.executionAuthorized, false);
});

test("trusted independent evidence may pass analysis but never authorizes execution", () => {
  const evidence = [
    {
      category: "multi_timeframe", direction: "BUY", source: "DERIV",
      confidence: 92, adapterVerified: true, instrument: "XAUUSD",
      timeframes: ["M1", "H1"], asOf
    },
    {
      category: "price_action", direction: "BUY", source: "PRICE_ACTION_PROVIDER",
      confidence: 90, adapterVerified: true, instrument: "XAUUSD",
      timeframe: "M1", asOf
    },
    {
      category: "liquidity", direction: "BUY", source: "LIQUIDITY_PROVIDER",
      confidence: 90, adapterVerified: true, instrument: "XAUUSD",
      timeframe: "M1", asOf
    },
    {
      category: "news", direction: "BUY", source: "NEWS_PROVIDER",
      confidence: 86, adapterVerified: true, instrument: "XAUUSD", asOf
    }
  ];
  const result = evaluateMarketCandidate({
    ...base,
    evidence,
    risk: { ...base.risk, newsStatus: "CLEAR" }
  });
  assert.equal(result.direction, "BUY");
  assert.equal(result.decision, "SIGNAL_READY_FOR_RISK_GATE");
  assert.equal(result.executionAuthorized, false);
});

test("stale and unverified additional evidence cannot clear the gate", () => {
  const result = evaluateMarketCandidate({
    ...base,
    evidence: [
      {
        category: "multi_timeframe", direction: "BUY", source: "STALE_PROVIDER",
        confidence: 95, adapterVerified: true, instrument: "XAUUSD",
        timeframes: ["M1", "H1"], asOf: new Date(now - 600000).toISOString()
      },
      {
        category: "price_action", direction: "BUY", source: "UNVERIFIED_PROVIDER",
        confidence: 95, adapterVerified: false, instrument: "XAUUSD",
        timeframe: "M1", asOf
      }
    ],
    maxAgeMs: 120000
  });
  assert.equal(result.direction, "WAIT");
  assert.ok(result.reasons.includes("STALE_OR_INVALID_EVIDENCE"));
  assert.ok(result.reasons.includes("UNVERIFIED_EVIDENCE_SOURCE"));
  assert.equal(result.executionAuthorized, false);
});

test("the analyst route and DEMO scalping worker both invoke the runtime gate", async () => {
  const [analyst, worker, docker] = await Promise.all([
    readFile(new URL("../handlers/analysis/market.js", import.meta.url), "utf8"),
    readFile(new URL("../services/scalping-worker/index.js", import.meta.url), "utf8"),
    readFile(new URL("../services/scalping-worker/Dockerfile", import.meta.url), "utf8")
  ]);
  assert.match(analyst, /evaluateMarketCandidate/);
  assert.match(analyst, /marketIntelligence/);
  assert.match(worker, /evaluateMarketCandidate/);
  assert.match(worker, /MARKET_INTELLIGENCE_WAIT/);
  assert.match(worker, /lastMarketIntelligence/);
  assert.match(docker, /COPY lib\/market-intelligence\.js/);
  assert.match(docker, /COPY lib\/market-intelligence-gate\.js/);
});
