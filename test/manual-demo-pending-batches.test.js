import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("pending batch API validates count, planned levels, percentages, DEMO mode and verified quote",async()=>{
 const api=await readFile(new URL("../handlers/bots/demo/pending-batches.js",import.meta.url),"utf8");
 assert.match(api,/Number\.isInteger\(tradeCount\)/);
 assert.match(api,/tradeCount<1\|\|tradeCount>10/);
 assert.match(api,/Math\.round\(allocations\.reduce\(\(a,b\)=>a\+b,0\)\*100\)!==10000/);
 assert.match(api,/profile\.account_mode!=="DEMO"/);
 assert.match(api,/loadApprovedInstrument/);
 assert.match(api,/freshQuote\(quote,symbol\)/);
 assert.match(api,/direction==="BUY"\?Number\(quote\.quote\)>entry:Number\(quote\.quote\)<entry/);
 assert.match(api,/create_demo_manual_entry_batch/);
 assert.match(api,/p_total_risk_usd:sizing\.riskAmount/);
 assert.match(api,/No position is open yet/);
 assert.doesNotMatch(api,/buy\(|sell\(|placeOrder|sendBrokerOrder/i);
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
 assert.match(sql,/create table if not exists public\.demo_manual_entry_batches/);
 assert.match(sql,/status text not null default 'PENDING'/);
 assert.match(sql,/create or replace function public\.create_demo_manual_entry_batch/);
 assert.match(sql,/v_open_count\+v_pending_count\+p_trade_count>v_session\.max_open_positions/);
 assert.match(sql,/v_open_risk\+v_pending_risk\+p_total_risk_usd/);
 assert.match(sql,/create or replace function public\.activate_demo_manual_entry_batch/);
 assert.match(sql,/v_batch\.last_quote>v_batch\.entry_price and p_quote<=v_batch\.entry_price/);
 assert.match(sql,/v_batch\.last_quote<v_batch\.entry_price and p_quote>=v_batch\.entry_price/);
 assert.match(sql,/for update/);
 assert.match(sql,/metadata->>'manual_entry_batch_id'/);
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
 assert.match(page,/shared entry, SL and T1\/T2\/T3 levels/);
});
