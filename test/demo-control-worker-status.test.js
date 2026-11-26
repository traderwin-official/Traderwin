import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("DEMO control creates and manages isolated v2 paper sessions",async()=>{
 const s=await readFile(new URL("../handlers/bots/demo/control.js",import.meta.url),"utf8");
 assert.match(s,/demo_paper_sessions/);assert.match(s,/demo_paper_trades/);
 assert.match(s,/demo_paper_worker_heartbeats/);assert.match(s,/let selectedStrategy="MANUAL"/);
 assert.match(s,/requestedTimeframe=String\(b\.timeframe\|\|"M15"\)/);assert.match(s,/timeframe=requestedTimeframe/);assert.match(s,/broker:"DERIV"/);
 assert.match(s,/select\("risk_per_trade,max_daily_loss"\)/);
 assert.match(s,/eq\("broker","DERIV"\)/);
 assert.match(s,/eq\("instrument",requestedInstrument\)/);
 assert.match(s,/if\(executionMode==="AUTO"\)\{/);
 assert.doesNotMatch(s,/select\("max_risk_per_trade_pct,max_daily_loss_pct"\)/);
 assert.match(s,/config_snapshot/);assert.match(s,/account_mode/);
});
test("dashboard still exposes timeframe, validated strategy and worker health",async()=>{
 const html=await readFile(new URL("../index.html",import.meta.url),"utf8");
 assert.match(html,/id="botTimeframe"/);assert.match(html,/value="MULTI_CONFIRMATION_V1"/);
 assert.match(html,/value="AUTO_SELECT_V1"/);assert.match(html,/id="demoExecutionMode"/);
 assert.match(html,/id="demoWorkerHealth"/);assert.match(html,/showDemoWorkerHealth\(r\.workerHeartbeat\)/);
});

test("DEMO status returns all open positions while preserving the legacy primary openTrade field",async()=>{
 const s=await readFile(new URL("../handlers/bots/demo/control.js",import.meta.url),"utf8");
 assert.match(s,/data:openTrades/);
 assert.match(s,/order\("opened_at",\{ascending:false\}\)/);
 assert.match(s,/openTrades:compatibleTrades/);
 assert.match(s,/compatibleTrades\.find\(t=>t\.trade_origin==="BOT"\)/);
 assert.match(s,/eq\("trade_origin","BOT"\)\.limit\(1\)\.maybeSingle\(\)/);
});
test("DEMO sessions persist a bounded multi-position count and aggregate risk ceiling",async()=>{
 const s=await readFile(new URL("../handlers/bots/demo/control.js",import.meta.url),"utf8");
 assert.match(s,/max_open_positions/);
 assert.match(s,/const maxOpenPositions=3/);
 assert.match(s,/const risk=Math\.min\([^\n]+,0\.25\)/);
 assert.match(s,/const daily=Math\.min\([^\n]+,1\.00\)/);
 assert.match(s,/max_total_open_risk_pct:1\.00/);
});
test("dashboard lets members select one of their open DEMO positions",async()=>{
 const html=await readFile(new URL("../index.html",import.meta.url),"utf8");
 assert.match(html,/id="paperOpenPositionSelect"/);
 assert.match(html,/function renderOpenPaperPositions\(trades\)/);
 assert.match(html,/status\.openTrades/);
 assert.match(html,/refreshOpenPaperPositions/);
});

test("public account and onboarding pages use the Young Tiger FX brand", async () => {
 for (const file of ["index.html","auth.html","onboarding.html"]) {
  const html=await readFile(new URL("../"+file,import.meta.url),"utf8");
  assert.match(html,/Young Tiger FX|YOUNG TIGER FX/);
  assert.doesNotMatch(html,/Traderwin|TRADERWIN/);
 }
});


test("stopping AUTO sessions safely detects one or more open BOT positions",async()=>{
 const s=await readFile(new URL("../handlers/bots/demo/control.js",import.meta.url),"utf8");
 assert.match(s,/AUTO sessions may hold several BOT positions/);
 assert.match(s,/eq\("trade_origin","BOT"\)\.limit\(1\)\.maybeSingle\(\)/);
});

test("dashboard profile inputs enforce DEMO risk ceilings while keeping REAL preferences separate",async()=>{
 const html=await readFile(new URL("../index.html",import.meta.url),"utf8");
 assert.match(html,/id="profileRisk" type="number" min="0\.01" max="0\.25"/);
 assert.match(html,/id="profileDailyLoss" type="number" min="0\.1" max="1"/);
 assert.match(html,/function applyModeRiskLimits\(\)/);
 assert.match(html,/riskMax=demo\?0\.25:2/);
 assert.match(html,/dailyMax=demo\?1:10/);
 assert.match(html,/REAL settings are preferences only/);
});
