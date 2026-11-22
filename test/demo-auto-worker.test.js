import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("DEMO worker uses cron authorization, v2 lease and never sends broker orders",async()=>{
 const s=await readFile(new URL("../handlers/cron/demo-auto-worker.js",import.meta.url),"utf8");
 assert.match(s,/CRON_SECRET/);assert.match(s,/claim_demo_paper_worker/);assert.match(s,/release_demo_paper_worker/);
 assert.match(s,/p_lease_seconds:90/);assert.match(s,/eq\("trade_origin","BOT"\)/);assert.match(s,/realOrdersSent:0/);
 assert.match(s,/demo_paper_sessions/);assert.match(s,/demo_paper_trades/);assert.match(s,/neq\("strategy","MANUAL"\)/);
 assert.match(s,/\["TIGER_FIBONACCI_PSYCHOLOGY_V1","AUTO_SELECT_V1"\]/);
});
test("worker processes DEMO sessions only and respects paused, risk-lock and emergency stop",async()=>{
 const s=await readFile(new URL("../handlers/cron/demo-auto-worker.js",import.meta.url),"utf8");
 assert.match(s,/\["RUNNING","PAUSED","RISK_LOCKED"\]/);assert.match(s,/entries_blocked/);
 assert.match(s,/\(emergency\?\.entries_blocked\|\|legacyEmergency\?\.kill_switch_active\)&&!openTrade/);
 assert.match(s,/eq\("trade_origin","BOT"\)/);
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
 assert.match(sql,/remaining_quantity numeric\(28,12\) not null check \(remaining_quantity >= 0\)/);
 assert.match(sql,/status='CLOSED' and remaining_quantity=0/);
});
test("manual close uses v2 atomic close and verified quote",async()=>{
 const route=await readFile(new URL("../handlers/bots/demo/close.js",import.meta.url),"utf8");
 assert.match(route,/demo_paper_trades/);assert.match(route,/close_demo_paper_trade/);
 assert.match(route,/p_exit_price:q\.quote/);assert.match(route,/getDerivQuoteToUsd/);
});

test("DEMO worker selects only the BOT slot so multiple MANUAL positions cannot break its single-position decision path",async()=>{
 const s=await readFile(new URL("../handlers/cron/demo-auto-worker.js",import.meta.url),"utf8");
 assert.match(s,/eq\("trade_origin","BOT"\)\.maybeSingle\(\)/);
 assert.doesNotMatch(s,/MANUAL_POSITION_NOT_MANAGED/);
});
test("multi-position v3 keeps one BOT worker slot while permitting additional manual positions",async()=>{
 const sql=await readFile(new URL("../supabase/migrations/202611200003_demo_multi_position_v3.sql",import.meta.url),"utf8");
 assert.match(sql,/drop index if exists public\.demo_paper_one_open_trade_per_user/);
 assert.match(sql,/demo_paper_one_open_bot_trade_per_session/);
 assert.match(sql,/max_open_positions integer not null default 3/);
 assert.match(sql,/max_total_open_risk_pct numeric\(5,2\) not null default 2\.00/);
 assert.match(sql,/MAX_OPEN_POSITIONS/);
 assert.match(sql,/TOTAL_OPEN_RISK_LIMIT/);
 assert.match(sql,/sum\(risk_amount_usd\*remaining_quantity\/nullif\(quantity,0\)\)/);
 assert.doesNotMatch(sql,/drop table|truncate/i);
});

test("scheduled DEMO worker runs the account-wide portfolio giveback guard under its existing lease",async()=>{
 const s=await readFile(new URL("../handlers/cron/demo-auto-worker.js",import.meta.url),"utf8");
 assert.match(s,/runDemoPortfolioProtection/);
 assert.match(s,/portfolioProtection/);
 assert.match(s,/mode:"DEMO_PAPER_ONLY",realOrdersSent:0/);
 assert.ok(s.lastIndexOf("runDemoPortfolioProtection") < s.indexOf("release_demo_paper_worker"),"portfolio monitor must run while the worker lease is held");
});

test("DEMO portfolio queue rotates blocked and failed accounts while retrying CAS conflicts",async()=>{
 const s=await readFile(new URL("../lib/demo-portfolio-protection-runner.js",import.meta.url),"utf8");
 assert.match(s,/CLOSE_BLOCKED", "BLOCKED"/);
 assert.match(s,/PORTFOLIO_QUEUE_UPDATE_FAILED/);
 assert.match(s,/CLOSE_BLOCKED", "BLOCKED"\]\s*\.includes\(result\.status\)/);
 assert.doesNotMatch(s,/RETRY.*includes\(result\.status\)/);
});

test("worker scheduling is delegated to Supabase Cron, not Vercel Hobby schedules",async()=>{
 const config=JSON.parse(await readFile(new URL("../vercel.json",import.meta.url),"utf8"));
 assert.equal(config.schedules,undefined);
 const guide=await readFile(new URL("../docs/DEMO_WORKER_SCHEDULING.md",import.meta.url),"utf8");
 for(const phrase of ["Supabase Cron","pg_cron","pg_net","vault.create_secret","* * * * *"]) assert.ok(guide.includes(phrase),`Missing scheduling instruction: ${phrase}`);
 const handler=await readFile(new URL("../handlers/cron/demo-auto-worker.js",import.meta.url),"utf8");
 assert.match(handler,/authorization/);
 assert.match(handler,/CRON_SECRET/);
 assert.ok(handler.includes("CRON_SECRET.length<32"));
});

test("new BOT entries re-fetch the Deriv quote and emergency controls immediately before the atomic paper open",async()=>{
 const s=await readFile(new URL("../handlers/cron/demo-auto-worker.js",import.meta.url),"utf8");
 const openBlock=s.slice(s.indexOf('if(decision.action==="OPEN")'));
 assert.match(openBlock,/getDerivPublicQuote\(raw\.instrument\)/);
 assert.match(openBlock,/getDerivQuoteToUsd\(raw\.instrument,entryQuote\)/);
 assert.match(openBlock,/latestEmergencyError\|\|latestLegacyEmergencyError/);
 assert.match(openBlock,/latestEmergency\?\.entries_blocked\|\|latestLegacyEmergency\?\.kill_switch_active/);
 assert.match(openBlock,/decideDemoAutoAction\(\{session,settings,quote:entryQuote,market,openTrade:null/);
 assert.ok(openBlock.indexOf("const rechecked=")<openBlock.indexOf('db.rpc("open_demo_paper_trade"'));
 assert.match(openBlock,/ENTRY_RECHECK_NO_LONGER_VALID/);
});

test("manual DEMO entries refresh the quote, recalculate size, and recheck both emergency controls before RPC",async()=>{
 const s=await readFile(new URL("../handlers/bots/demo/trade.js",import.meta.url),"utf8");
 const rpc=s.slice(s.indexOf('const {data:result,error}=await db.rpc("open_demo_paper_trade"'));
 const finalCheck=s.slice(s.indexOf("// Refresh server-owned market"));
 assert.match(finalCheck,/finalQuote=await getDerivPublicQuote\(symbol\)/);
 assert.match(finalCheck,/getDerivQuoteToUsd\(symbol,finalQuote\)/);
 assert.match(finalCheck,/calculatePaperPosition\(\{balance:Number\(session\.current_balance\),riskPct,entry:finalQuote\.quote/);
 assert.match(finalCheck,/finalEmergencyError\|\|finalLegacyError/);
 assert.match(finalCheck,/finalEmergency\?\.entries_blocked\|\|finalLegacy\?\.kill_switch_active/);
 const preflightStart=s.indexOf("// Refresh server-owned market");
 const rpcStart=s.indexOf('const {data:result,error}=await db.rpc("open_demo_paper_trade"');
 assert.ok(preflightStart>=0&&preflightStart<rpcStart);
 assert.match(rpc,/p_entry:quote\.quote,p_stop:stop,p_target:target/);
 assert.ok(s.indexOf("quote=finalQuote;")<s.indexOf('const {data:result,error}=await db.rpc("open_demo_paper_trade"'),"RPC must use the final refreshed quote");
 assert.match(rpc,/p_quote_as_of:quote\.quoteAsOf/);
});
