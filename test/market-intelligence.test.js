import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMarketConfluence, attestMarketEvidence } from "../lib/market-intelligence.js";

const now = Date.parse("2026-11-16T12:00:00.000Z");
const rawEvidence = [
  {category:"technical",direction:"BUY",source:"ta-engine",confidence:94},
  {category:"multi_timeframe",direction:"BUY",source:"mtf-engine",confidence:92},
  {category:"price_action",direction:"BUY",source:"price-action",confidence:90},
  {category:"liquidity",direction:"BUY",source:"liquidity-map",confidence:91},
  {category:"order_flow",direction:"BUY",source:"order-flow",confidence:88},
  {category:"news",direction:"BUY",source:"news-feed",confidence:80}
];
const evidenceFor = (instrument = "XAUUSD", timeframe = "M5") => rawEvidence.map(item => ({
  ...item,
  instrument,
  adapterVerified: true,
  ...(item.category === "multi_timeframe"
    ? {timeframes:[timeframe,"H1"]}
    : {timeframe})
})).map((item, index) => attestMarketEvidence({
  ...item,
  asOf: new Date(now - (index + 1) * 1000).toISOString()
}));
const evidence = evidenceFor();
const market = {tradable:true,quoteFresh:true,candleClosed:true};
const risk = {
  spreadBps:1,maxSpreadBps:3,riskReward:2,minimumRiskReward:1.5,
  entryTriggerConfirmed:true,newsStatus:"CLEAR"
};

test("high-confluence M5 scalp can pass analysis but never authorizes execution", () => {
  const result = evaluateMarketConfluence({instrument:"XAUUSD",timeframe:"M5",evidence,market,risk,now});
  assert.equal(result.direction,"BUY");
  assert.equal(result.decision,"SIGNAL_READY_FOR_RISK_GATE");
  assert.equal(result.executionAuthorized,false);
  assert.equal(result.mode,"SENSITIVE_SCALPING");
});

test("minimum four-category evidence can reach the configured confidence threshold", () => {
  const result = evaluateMarketConfluence({
    instrument:"XAUUSD",timeframe:"M5",evidence:evidence.slice(0,4),market,risk,now
  });
  assert.equal(result.categories.length,4);
  assert.ok(result.confidence >= 72, `expected >=72 confidence, received ${result.confidence}`);
  assert.equal(result.direction,"BUY");
});

test("case-only source-name variants do not count as independent providers", () => {
  const variants = evidence.map(item=>attestMarketEvidence({...item,source:"Provider-A"}));
  const result = evaluateMarketConfluence({instrument:"XAUUSD",timeframe:"M5",evidence:variants,market,risk,now});
  assert.equal(result.independentSources,1);
  assert.ok(result.reasons.includes("INSUFFICIENT_INDEPENDENT_SOURCES"));
  assert.equal(result.direction,"WAIT");
});

test("missing liquidity confirmation blocks a sensitive scalp", () => {
  const result = evaluateMarketConfluence({instrument:"XAUUSD",timeframe:"M5",evidence:evidence.filter(x=>x.category!=="liquidity"),market,risk,now});
  assert.equal(result.direction,"WAIT");
  assert.ok(result.reasons.includes("MISSING_LIQUIDITY_CONFIRMATION"));
});

test("stale or future evidence is rejected", () => {
  const stale = evidenceFor("EURUSD").map(x=>attestMarketEvidence({...x,asOf:new Date(now-600000).toISOString()}));
  const future = [attestMarketEvidence({...evidenceFor("EURUSD")[0],asOf:new Date(now+10000).toISOString()})];
  const result = evaluateMarketConfluence({instrument:"EURUSD",timeframe:"M5",evidence:[...stale,...future],market,risk,now});
  assert.equal(result.direction,"WAIT");
  assert.equal(result.acceptedEvidence.length,0);
  assert.ok(result.reasons.includes("STALE_OR_INVALID_EVIDENCE"));
});

test("spread, news blackout and weak reward-risk block a trade", () => {
  const result = evaluateMarketConfluence({
    instrument:"EURUSD",timeframe:"M5",evidence:evidenceFor("EURUSD"),market,
    risk:{...risk,spreadBps:5,riskReward:1.1,newsStatus:"BLACKOUT",highImpactNewsWindow:true},now
  });
  assert.equal(result.direction,"WAIT");
  assert.ok(result.reasons.includes("SPREAD_TOO_WIDE"));
  assert.ok(result.reasons.includes("RISK_REWARD_BELOW_MINIMUM"));
  assert.ok(result.reasons.includes("HIGH_IMPACT_NEWS_BLACKOUT"));
});

test("conflicting signal sources force WAIT", () => {
  const mixed = evidenceFor("BTCUSD").map((x,i)=>i<3?x:attestMarketEvidence({...x,direction:"SELL"}));
  const result = evaluateMarketConfluence({instrument:"BTCUSD",timeframe:"M5",evidence:mixed,market,risk,now});
  assert.equal(result.direction,"WAIT");
  assert.ok(result.reasons.includes("SIGNAL_CONFLICT_OR_WEAK_AGREEMENT"));
});

test("duplicate evidence from the same category and provider is ignored", () => {
  const mixed=[...evidence,attestMarketEvidence({...evidence[0],source:"TA-ENGINE"})];
  const result=evaluateMarketConfluence({instrument:"XAUUSD",timeframe:"M5",evidence:mixed,market,risk,now});
  assert.equal(result.acceptedEvidence.length,6);
  assert.equal(result.independentSources,6);
});

test("missing spread, quote freshness or candle completion blocks a trade", () => {
  const result=evaluateMarketConfluence({
    instrument:"XAUUSD",timeframe:"M5",evidence,
    market:{tradable:true,quoteFresh:false,candleClosed:false},
    risk:{...risk,spreadBps:null},now
  });
  assert.equal(result.direction,"WAIT");
  assert.ok(result.reasons.includes("SPREAD_DATA_UNAVAILABLE"));
  assert.ok(result.reasons.includes("QUOTE_NOT_FRESH"));
  assert.ok(result.reasons.includes("ENTRY_CANDLE_NOT_CLOSED"));
});

test("evidence for another instrument is rejected", () => {
  const result=evaluateMarketConfluence({
    instrument:"XAUUSD",timeframe:"M5",
    evidence:evidenceFor("EURUSD"),market,risk,now
  });
  assert.equal(result.direction,"WAIT");
  assert.equal(result.acceptedEvidence.length,0);
  assert.ok(result.reasons.includes("EVIDENCE_CONTEXT_MISMATCH"));
});

test("chart evidence must match the requested timeframe", () => {
  const wrongTimeframe=evidence.map(item=>item.category==="technical"?attestMarketEvidence({...item,timeframe:"H1"}):item);
  const result=evaluateMarketConfluence({instrument:"XAUUSD",timeframe:"M5",evidence:wrongTimeframe,market,risk,now});
  assert.equal(result.direction,"WAIT");
  assert.ok(result.reasons.includes("EVIDENCE_CONTEXT_MISMATCH"));
  assert.ok(result.reasons.includes("MISSING_TECHNICAL_CONFIRMATION"));
});

test("multi-timeframe evidence must include the requested and a higher timeframe", () => {
  const wrong=evidence.map(item=>item.category==="multi_timeframe"?attestMarketEvidence({...item,timeframes:["H1","H4"]}):item);
  const result=evaluateMarketConfluence({instrument:"XAUUSD",timeframe:"M5",evidence:wrong,market,risk,now});
  assert.equal(result.direction,"WAIT");
  assert.ok(result.reasons.includes("EVIDENCE_CONTEXT_MISMATCH"));
  assert.ok(result.reasons.includes("MISSING_MULTI_TIMEFRAME_CONFIRMATION"));
});

test("unverified adapter evidence is rejected", () => {
  const unverified=evidence.map((item,index)=>index===0?{...item,adapterVerified:false}:item);
  const result=evaluateMarketConfluence({instrument:"XAUUSD",timeframe:"M5",evidence:unverified,market,risk,now});
  assert.equal(result.direction,"WAIT");
  assert.ok(result.reasons.includes("UNVERIFIED_EVIDENCE_SOURCE"));
  assert.ok(result.reasons.includes("MISSING_TECHNICAL_CONFIRMATION"));
});

test("missing news status fails closed", () => {
  const {newsStatus,...unverifiedRisk}=risk;
  const result=evaluateMarketConfluence({instrument:"XAUUSD",timeframe:"M5",evidence,market,risk:unverifiedRisk,now});
  assert.equal(result.direction,"WAIT");
  assert.ok(result.reasons.includes("NEWS_STATUS_NOT_VERIFIED"));
});

test("invalid time or timeframe configuration fails closed", () => {
  assert.equal(evaluateMarketConfluence({instrument:"XAUUSD",timeframe:"M5",evidence,market,risk,now:NaN}).direction,"WAIT");
  assert.ok(evaluateMarketConfluence({instrument:"XAUUSD",timeframe:"TICK",evidence,market,risk,now}).reasons.includes("INVALID_TIMEFRAME"));
});
