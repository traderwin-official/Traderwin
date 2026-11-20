import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("DEMO worker uses cron authorization, v2 lease and never sends broker orders",async()=>{
 const s=await readFile(new URL("../api/cron/demo-auto-worker.js",import.meta.url),"utf8");
 assert.match(s,/CRON_SECRET/);assert.match(s,/claim_demo_paper_worker/);assert.match(s,/release_demo_paper_worker/);
 assert.match(s,/p_lease_seconds:90/);assert.match(s,/MANUAL_POSITION_NOT_MANAGED/);assert.match(s,/realOrdersSent:0/);
 assert.match(s,/demo_paper_sessions/);assert.match(s,/demo_paper_trades/);
});
test("worker processes DEMO sessions only and respects paused, risk-lock and emergency stop",async()=>{
 const s=await readFile(new URL("../api/cron/demo-auto-worker.js",import.meta.url),"utf8");
 assert.match(s,/\["RUNNING","PAUSED","RISK_LOCKED"\]/);assert.match(s,/entries_blocked/);
 assert.match(s,/\(emergency\?\.entries_blocked\|\|legacyEmergency\?\.kill_switch_active\)&&!openTrade/);
 assert.match(s,/MANUAL_POSITION_NOT_MANAGED/);
});
test("v2 migration provides isolated tables, owner reads and service-only atomic RPCs",async()=>{
 const sql=await readFile(new URL("../supabase/migrations/202611200001_demo_paper_ledger_v2.sql",import.meta.url),"utf8");
 for(const name of ["demo_paper_sessions","demo_paper_trades","demo_paper_worker_heartbeats","demo_paper_worker_leases","demo_paper_emergency_controls"])assert.match(sql,new RegExp(name));
 assert.match(sql,/auth\.uid\(\)=user_id/);assert.match(sql,/auth\.role\(\)<>'service_role'/);
 assert.match(sql,/open_demo_paper_trade/);assert.match(sql,/close_demo_paper_trade/);assert.match(sql,/manage_demo_paper_exit/);
 assert.match(sql,/Africa\/Nairobi/);assert.match(sql,/to service_role/);assert.match(sql,/demo_paper_one_open_trade_per_user/);
 assert.doesNotMatch(sql,/references public\.bot_settings/);
});
test("staged exits preserve TP1 40 percent, TP2 30 percent and TP3 remainder",async()=>{
 const sql=await readFile(new URL("../supabase/migrations/202611200001_demo_paper_ledger_v2.sql",import.meta.url),"utf8");
 assert.match(sql,/v_trade\.quantity\*0\.40/);assert.match(sql,/v_trade\.quantity\*0\.30/);
 assert.match(sql,/v_qty:=v_trade\.remaining_quantity/);assert.match(sql,/MANUAL_TRADE_NOT_MANAGED/);
});
test("manual close uses v2 atomic close and verified quote",async()=>{
 const route=await readFile(new URL("../api/bots/demo/close.js",import.meta.url),"utf8");
 assert.match(route,/demo_paper_trades/);assert.match(route,/close_demo_paper_trade/);
 assert.match(route,/p_exit_price:q\.quote/);assert.match(route,/getDerivQuoteToUsd/);
});
