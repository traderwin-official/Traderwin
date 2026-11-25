import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("continuous worker executes only opted-in DEMO paper trades and never sends broker orders",async()=>{
 const s=await readFile(new URL("../services/scalping-worker/index.js",import.meta.url),"utf8");
 assert.match(s,/demo_scalping_preferences/);
 assert.match(s,/config_snapshot/);
 assert.match(s,/WEBSITE_DEMO_AUTO_PAPER_ONLY/);
 assert.match(s,/eq\("account_mode","DEMO"\)/);
 assert.match(s,/eq\("execution","WEBSITE_PAPER_ONLY"\)/);
 assert.match(s,/trading_instrument_approvals/);
 assert.match(s,/ticks_history:[\s\S]*granularity:60/);
 assert.match(s,/scalping_signal_events/);
 assert.doesNotMatch(s,/db\.channel\(|\.send\(\{type:"broadcast"/);
 assert.match(s,/SIGNAL_ONLY_NO_ORDERS/);
 assert.doesNotMatch(s,/open_demo_paper_trade|buy\s*\(|sell\s*\(/i);
});
test("scalping preference migration enforces the agreed one-position cap",async()=>{
 const sql=await readFile(new URL("../supabase/migrations/202611250004_scalping_market_ticks.sql",import.meta.url),"utf8");
 assert.match(sql,/max_open_positions smallint not null default 1 check \(max_open_positions = 1\)/);
 assert.doesNotMatch(sql,/max_open_positions between 1 and 2/);
});

test("scalping execution guard keeps DEMO risk, daily loss, position and candle limits server-side",async()=>{
 const sql=await readFile(new URL("../supabase/migrations/202611260001_scalping_demo_execution_guard.sql",import.meta.url),"utf8");
 assert.match(sql,/open_demo_scalping_paper_trade/);
 assert.match(sql,/p_risk_pct > 0\.25/);
 assert.match(sql,/max_daily_loss_pct,1\.00/);
 assert.match(sql,/max_open_positions <> 1/);
 assert.match(sql,/last_candle_as_of/);
 assert.match(sql,/SCALPING_ONE_OPEN_POSITION_LIMIT/);
 assert.match(sql,/to service_role/);
 assert.match(sql,/from public, anon, authenticated/);
});
