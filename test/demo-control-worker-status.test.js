import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("DEMO control creates and manages isolated v2 paper sessions",async()=>{
 const s=await readFile(new URL("../api/bots/demo/control.js",import.meta.url),"utf8");
 assert.match(s,/demo_paper_sessions/);assert.match(s,/demo_paper_trades/);
 assert.match(s,/demo_paper_worker_heartbeats/);assert.match(s,/TIGER_FIBONACCI_PSYCHOLOGY_V1/);
 assert.match(s,/\["M5","M15","H1","H4"\]/);assert.match(s,/broker:"DERIV"/);
 assert.match(s,/config_snapshot/);assert.match(s,/account_mode/);
});
test("dashboard still exposes timeframe, validated strategy and worker health",async()=>{
 const html=await readFile(new URL("../index.html",import.meta.url),"utf8");
 assert.match(html,/id="botTimeframe"/);assert.match(html,/value="MULTI_CONFIRMATION_V1"/);
 assert.match(html,/id="demoWorkerHealth"/);assert.match(html,/showDemoWorkerHealth\(r\.workerHeartbeat\)/);
});
