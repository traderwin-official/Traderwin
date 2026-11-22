import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("DEMO control creates and manages isolated v2 paper sessions",async()=>{
 const s=await readFile(new URL("../api/bots/demo/control.js",import.meta.url),"utf8");
 assert.match(s,/demo_paper_sessions/);assert.match(s,/demo_paper_trades/);
 assert.match(s,/demo_paper_worker_heartbeats/);assert.match(s,/strategy:"MANUAL"/);
 assert.match(s,/timeframe="M15"/);assert.match(s,/broker:"DERIV"/);
 assert.match(s,/config_snapshot/);assert.match(s,/account_mode/);
});
test("dashboard still exposes timeframe, validated strategy and worker health",async()=>{
 const html=await readFile(new URL("../index.html",import.meta.url),"utf8");
 assert.match(html,/id="botTimeframe"/);assert.match(html,/value="MULTI_CONFIRMATION_V1"/);
 assert.match(html,/id="demoWorkerHealth"/);assert.match(html,/showDemoWorkerHealth\(r\.workerHeartbeat\)/);
});

test("DEMO status returns all open positions while preserving the legacy primary openTrade field",async()=>{
 const s=await readFile(new URL("../api/bots/demo/control.js",import.meta.url),"utf8");
 assert.match(s,/data:openTrades/);
 assert.match(s,/order\("opened_at",\{ascending:false\}\)/);
 assert.match(s,/openTrades:compatibleTrades/);
 assert.match(s,/compatibleTrades\.find\(t=>t\.trade_origin==="BOT"\)/);
 assert.match(s,/eq\("trade_origin","BOT"\)\.maybeSingle\(\)/);
});
test("DEMO sessions persist a bounded multi-position count and aggregate risk ceiling",async()=>{
 const s=await readFile(new URL("../api/bots/demo/control.js",import.meta.url),"utf8");
 assert.match(s,/max_open_positions/);
 assert.match(s,/const maxOpenPositions=3/);
 assert.match(s,/max_total_open_risk_pct:2\.00/);
});
test("dashboard lets members select one of their open DEMO positions",async()=>{
 const html=await readFile(new URL("../index.html",import.meta.url),"utf8");
 assert.match(html,/id="paperOpenPositionSelect"/);
 assert.match(html,/function renderOpenPaperPositions\(trades\)/);
 assert.match(html,/status\.openTrades/);
 assert.match(html,/refreshOpenPaperPositions/);
});

test("public account, onboarding and standalone-bot pages use the Young Tiger FX brand", async () => {
 for (const file of ["index.html","auth.html","onboarding.html","bot-shop.html"]) {
  const html=await readFile(new URL("../"+file,import.meta.url),"utf8");
  assert.match(html,/Young Tiger FX|YOUNG TIGER FX/);
  assert.doesNotMatch(html,/Traderwin|TRADERWIN/);
 }
});
