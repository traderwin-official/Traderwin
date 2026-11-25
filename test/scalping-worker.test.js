import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("continuous worker executes only opted-in DEMO paper trades and never sends broker orders",async()=>{
 const s=await readFile(new URL("../services/scalping-worker/index.js",import.meta.url),"utf8");
 assert.match(s,/demo_scalping_preferences/);
 assert.match(s,/config_snapshot/);
 assert.match(s,/trader_profiles/);
 assert.match(s,/profileByUser\.get\(session\.user_id\).*account_mode==="DEMO"/);
 assert.match(s,/preference\.paper_execution_enabled===true/);
 assert.match(s,/preference\.account_mode==="DEMO"/);
 assert.match(s,/preference\.execution==="WEBSITE_PAPER_ONLY"/);
 assert.match(s,/trading_instrument_approvals/);
 assert.match(s,/ticks_history:[\s\S]*granularity:60/);
 assert.match(s,/scalping_signal_events/);
 assert.doesNotMatch(s,/db\.channel\(|\.send\(\{type:"broadcast"/);
 assert.match(s,/DEMO_PAPER_ONLY_NO_BROKER_ORDERS/);
 assert.match(s,/openScalpingPaperPosition/);
 assert.match(s,/manageScalpingPaperPosition/);
 assert.match(s,/getDerivQuoteToUsd/);
 assert.match(s,/refreshOpenTrades/);
 assert.match(s,/claim_traderwin_scalping_worker/);
 assert.match(s,/release_traderwin_scalping_worker/);
 assert.match(s,/manageOpen/);
 assert.match(s,/OPEN_SCALPING_POSITION_PROVIDER_MAPPING_MISSING/);
 assert.match(s,/!state\.lastError/);
 assert.match(s,/TIGER_SCHEME_QUANTUM_SCALPING/);
 assert.doesNotMatch(s,/proposal_open_contract|buy\s*\(|sell\s*\(/i);
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
 assert.match(sql,/paper_execution_enabled boolean not null default false/);
 assert.match(sql,/paper_execution_enabled is not true/);
 assert.match(sql,/CURRENT_ACCOUNT_MODE_NOT_DEMO/);
 assert.match(sql,/from public\.trader_profiles/);
 assert.match(sql,/p\.paper_execution_enabled = true/);
 assert.match(sql,/SCALPING_ONE_OPEN_POSITION_LIMIT/);
 assert.match(sql,/guard_scalping_single_open_position/);
 assert.match(sql,/scalping_worker_leases/);
 assert.match(sql,/claim_traderwin_scalping_worker/);
 assert.match(sql,/to service_role/);
 assert.match(sql,/from public, anon, authenticated/);
});
