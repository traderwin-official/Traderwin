import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMarketConfluence } from "../lib/market-intelligence.js";

const now = Date.parse("2026-11-15T12:00:00.000Z");
const evidence = [
  {category:"technical",direction:"BUY",source:"ta-engine",asOf:new Date(now-1000).toISOString(),confidence:94},
  {category:"multi_timeframe",direction:"BUY",source:"mtf-engine",asOf:new Date(now-2000).toISOString(),confidence:92},
  {category:"price_action",direction:"BUY",source:"price-action",asOf:new Date(now-3000).toISOString(),confidence:90},
  {category:"liquidity",direction:"BUY",source:"liquidity-map",asOf:new Date(now-4000).toISOString(),confidence:91},
  {category:"order_flow",direction:"BUY",source:"order-flow",asOf:new Date(now-5000).toISOString(),confidence:88},
  {category:"news",direction:"BUY",source:"news-feed",asOf:new Date(now-6000).toISOString(),confidence:80}
];
const market = {tradable:true,quoteFresh:true,candleClosed:true};
const risk = {spreadBps:1,maxSpreadBps:3,riskReward:2,minimumRiskReward:1.5,entryTriggerConfirmed:true};

test("high-confluence M1 scalp can pass analysis but never authorizes execution", () => {
  const result = evaluateMarketConfluence({instrument:"XAUUSD",timeframe:"M1",evidence,market,risk,now});
  assert.equal(result.direction,"BUY");
  assert.equal(result.decision,"SIGNAL_READY_FOR_RISK_GATE");
  assert.equal(result.executionAuthorized,false);
  assert.equal(result.mode,"SENSITIVE_SCALPING");
});

test("missing liquidity confirmation blocks a sensitive scalp", () => {
  const result = evaluateMarketConfluence({instrument:"XAUUSD",timeframe:"M5",evidence:evidence.filter(x=>x.category!=="liquidity"),market,risk,now});
  assert.equal(result.direction,"WAIT");
  assert.ok(result.reasons.includes("MISSING_LIQUIDITY_CONFIRMATION"));
});

test("stale or future evidence is rejected", () => {
  const stale = evidence.map(x=>({...x,asOf:new Date(now-600000).toISOString()}));
  const future = [{...evidence[0],asOf:new Date(now+10000).toISOString()}];
  const result = evaluateMarketConfluence({instrument:"EURUSD",timeframe:"M1",evidence:[...stale,...future],market,risk,now});
  assert.equal(result.direction,"WAIT");
  assert.equal(result.acceptedEvidence.length,0);
});

test("spread, news blackout and weak reward-risk block a trade", () => {
  const result = evaluateMarketConfluence({
    instrument:"EURUSD",timeframe:"M1",evidence,market,
    risk:{...risk,spreadBps:5,riskReward:1.1,highImpactNewsWindow:true},now
  });
  assert.equal(result.direction,"WAIT");
  assert.ok(result.reasons.includes("SPREAD_TOO_WIDE"));
  assert.ok(result.reasons.includes("RISK_REWARD_BELOW_MINIMUM"));
  assert.ok(result.reasons.includes("HIGH_IMPACT_NEWS_BLACKOUT"));
});

test("conflicting signal sources force WAIT", () => {
  const mixed = evidence.map((x,i)=>i<3?x:{...x,direction:"SELL"});
  const result = evaluateMarketConfluence({instrument:"BTCUSD",timeframe:"M5",evidence:mixed,market,risk,now});
  assert.equal(result.direction,"WAIT");
  assert.ok(result.reasons.includes("SIGNAL_CONFLICT_OR_WEAK_AGREEMENT"));
});

test("unknown and duplicate sources cannot inflate confluence", () => {
  const mixed=[...evidence,{...evidence[0],source:"ta-engine"}];
  const result=evaluateMarketConfluence({instrument:"XAUUSD",timeframe:"M1",evidence:mixed,market,risk,now});
  assert.equal(result.acceptedEvidence.length,6);
  assert.equal(result.independentSources,6);
});
