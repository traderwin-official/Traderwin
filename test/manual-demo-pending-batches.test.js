import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { detectDemoPendingEntryType } from "../lib/demo-pending-entry-type.js";

test("pending batch API validates count, planned levels, percentages, DEMO mode and verified quote",async()=>{
 const api=await readFile(new URL("../handlers/bots/demo/pending-batches.js",import.meta.url),"utf8");
 assert.match(api,/Number\.isInteger\(tradeCount\)/);
 assert.match(api,/tradeCount<1\|\|tradeCount>10/);
 assert.match(api,/Math\.round\(v\*100\)===v\*100/);
 assert.match(api,/Math\.round\(allocations\.reduce\(\(a,b\)=>a\+b,0\)\*100\)!==10000/);
 assert.match(api,/profile\.account_mode!=="DEMO"/);
 assert.match(api,/loadApprovedInstrument/);
 assert.match(api,/freshQuote\(quote,symbol\)/);
 assert.match(api,/detectDemoPendingEntryType\(direction,quote\.quote,entry\)/);
 assert.match(api,/finalDetectedEntryType!==initiallyDetectedEntryType/);
 assert.match(api,/Market crossed your planned entry while you were submitting/);
 assert.match(api,/p_entry_type:entryType/);
 assert.match(api,/Market is exactly at your planned entry/);
 assert.match(api,/entryType,tradeCount/);
 assert.match(api,/create_demo_manual_entry_batch/);
 assert.match(api,/p_total_risk_usd:sizing\.riskAmount/);
 assert.match(api,/No position is open yet/);
 assert.doesNotMatch(api,/buy\(|sell\(|placeOrder|sendBrokerOrder/i);
});


test("pending entry type is auto-detected for all four BUY/SELL LIMIT/STOP cases",()=>{
 assert.equal(detectDemoPendingEntryType("BUY",2050,2040),"LIMIT");
 assert.equal(detectDemoPendingEntryType("BUY",2030,2040),"STOP");
 assert.equal(detectDemoPendingEntryType("SELL",2030,2040),"LIMIT");
 assert.equal(detectDemoPendingEntryType("SELL",2050,2040),"STOP");
 assert.equal(detectDemoPendingEntryType("SELL",2040,2040),null);
 assert.equal(detectDemoPendingEntryType("HOLD",2050,2040),null);
});

test("pending batch worker requires a fresh verified quote and approved instrument before atomic activation",async()=>{
 const worker=await readFile(new URL("../handlers/cron/demo-auto-worker.js",import.meta.url),"utf8");
 assert.match(worker,/processPendingManualEntryBatches/);
 assert.match(worker,/eq\("status","PENDING"\)/);
 assert.match(worker,/getDerivPublicQuote\(batch\.instrument\)/);
 assert.match(worker,/loadApprovedInstrument\(db,\{broker:"DERIV",instrument:batch\.instrument,providerSymbol:quote\.providerSymbol\}\)/);
 assert.match(worker,/activate_demo_manual_entry_batch/);
 assert.match(worker,/p_quote_as_of:quote\.quoteAsOf/);
 assert.match(worker,/pendingManualBatches=await processPendingManualEntryBatches\(db\)/);
 assert.match(worker,/realOrdersSent:0/);
});

test("pending batch migration reserves aggregate risk and position slots, activates atomically, and serializes cancellation",async()=>{
 const sql=await readFile(new URL("../supabase/migrations/202611240003_manual_demo_pending_batches.sql",import.meta.url),"utf8");
 const upgrade=await readFile(new URL("../supabase/migrations/202611250001_manual_demo_stop_limit_entry_types.sql",import.meta.url),"utf8");
 assert.match(sql,/create table if not exists public\.demo_manual_entry_batches/);
 assert.match(sql,/status text not null default 'PENDING'/);
 assert.match(sql,/create or replace function public\.create_demo_manual_entry_batch/);
 assert.match(sql,/round\(p_tp1_percent,2\)<>p_tp1_percent/);
 assert.match(sql,/v_open_count\+v_pending_count\+p_trade_count>v_session\.max_open_positions/);
 assert.match(sql,/v_open_risk\+v_pending_risk\+p_total_risk_usd/);
 assert.match(sql,/create or replace function public\.activate_demo_manual_entry_batch/);
 assert.match(sql,/entry_type text not null/);
 assert.match(sql,/p_entry_type text/);
 assert.match(upgrade,/add column if not exists entry_type/);
 assert.match(upgrade,/create or replace function public\.create_demo_manual_entry_batch/);
 assert.match(upgrade,/create or replace function public\.activate_demo_manual_entry_batch/);
 assert.match(upgrade,/v_batch\.side=\x27SELL\x27 and v_batch\.entry_type=\x27STOP\x27 and v_batch\.last_quote>v_batch\.entry_price and p_quote<=v_batch\.entry_price/);
 assert.match(upgrade,/\$activate_batch\$/);
 assert.match(upgrade,/p_entry_type is null/);
 assert.match(sql,/v_batch\.side=\x27BUY\x27 and v_batch\.entry_type=\x27STOP\x27 and v_batch\.last_quote<v_batch\.entry_price and p_quote>=v_batch\.entry_price/);
 assert.match(sql,/v_batch\.side=\x27SELL\x27 and v_batch\.entry_type=\x27STOP\x27 and v_batch\.last_quote>v_batch\.entry_price and p_quote<=v_batch\.entry_price/);
 assert.match(sql,/for update/);
 assert.match(sql,/manual_entry_batch_id/);
 assert.match(sql,/create or replace function public\.cancel_demo_manual_entry_batch/);
 assert.match(sql,/create trigger demo_paper_respect_pending_manual_batches/);
 assert.match(sql,/from public,anon,authenticated/);
 assert.match(sql,/to service_role/);
 assert.match(sql,/QUOTE_CHECKPOINT_NOT_NEWER/);
});

test("manual dashboard asks for trade count and planned entry and allows cancellation of pending setups",async()=>{
 const page=await readFile(new URL("../index.html",import.meta.url),"utf8");
 assert.match(page,/id="paperTradeCount"/);
 assert.match(page,/id="paperEntry"/);
 assert.match(page,/Save Pending DEMO Trade Setup/);
 assert.match(page,/\/api\/bots\/demo\/pending-batches/);
 assert.match(page,/Cancel pending setup/);
 assert.ok(page.includes("automatically detects LIMIT or STOP"));
 assert.ok(page.includes("same entry, SL and T1/T2/T3 levels."));
 assert.ok(page.includes("A brief touch and reversal between checks can be missed"));
 assert.ok(page.includes("approximately once per minute"));
});
