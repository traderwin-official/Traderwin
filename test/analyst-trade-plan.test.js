import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalystTradePlan } from "../lib/analyst-trade-plan.js";

const quote = {
  source: "DERIV", providerSymbol: "frxXAUUSD", bid: 2300, ask: 2300.5,
  quoteAsOf: new Date(1_000_000).toISOString()
};

test("builds BUY plan from ask with ATR stop and 1.5R/2R targets", () => {
  const p = buildAnalystTradePlan({ direction: "BUY", quote, atr: 2, instrument: "XAUUSD", timeframe: "M15", now: 1_001_000 });
  assert.equal(p.status, "INDICATIVE_ONLY");
  assert.equal(p.entrySide, "ASK");
  assert.equal(p.entry, 2300.5);
  assert.equal(p.stopLoss, 2297.5);
  assert.equal(p.takeProfit1, 2305);
  assert.equal(p.takeProfit2, 2306.5);
  assert.equal(p.riskReward1, 1.5);
  assert.equal(p.riskReward2, 2);
});

test("builds SELL plan from bid and rejects stale, missing-side and future quotes", () => {
  const p = buildAnalystTradePlan({ direction: "SELL", quote, atr: 2, instrument: "XAUUSD", timeframe: "M15", now: 1_001_000 });
  assert.equal(p.entrySide, "BID");
  assert.equal(p.entry, 2300);
  assert.equal(p.stopLoss, 2303);
  assert.equal(p.takeProfit1, 2295.5);
  assert.equal(p.takeProfit2, 2294);
  assert.equal(buildAnalystTradePlan({ direction: "BUY", quote: { ...quote, bid: undefined }, atr: 2, instrument: "XAUUSD", now: 1_001_000 }).status, "UNAVAILABLE");
  assert.equal(buildAnalystTradePlan({ direction: "BUY", quote, atr: 2, instrument: "XAUUSD", now: 1_040_000 }).status, "UNAVAILABLE");
  assert.equal(buildAnalystTradePlan({ direction: "BUY", quote: { ...quote, quoteAsOf: new Date(1_001_001).toISOString() }, atr: 2, instrument: "XAUUSD", now: 1_001_000 }).status, "UNAVAILABLE");
});

test("does not create a directional plan for WAIT", () => {
  assert.equal(buildAnalystTradePlan({ direction: "WAIT", quote, atr: 2 }).status, "NO_DIRECTIONAL_SETUP");
});
