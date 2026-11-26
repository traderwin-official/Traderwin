import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {manageTradesIndependently} from "../lib/scalping-trade-concurrency.js";

test("continuous worker executes only opted-in DEMO paper trades and never sends broker orders",async()=>{
 const s=await readFile(new URL("../services/scalping-worker/index.js",import.meta.url),"utf8");
 const permissions=await readFile(new URL("../lib/scalping-session-eligibility.js",import.meta.url),"utf8");
 assert.match(s,/demo_scalping_preferences/);
 assert.match(s,/config_snapshot/);
 assert.match(s,/trader_profiles/);
 assert.match(s,/scalpingSessionPermissions/);
 const dockerfile=await readFile(new URL("../services/scalping-worker/Dockerfile",import.meta.url),"utf8");
 assert.match(dockerfile,/COPY lib\/scalping-session-eligibility\.js \.\/lib\/scalping-session-eligibility\.js/);
 assert.match(dockerfile,/COPY lib\/scalping-trade-concurrency\.js \.\/lib\/scalping-trade-concurrency\.js/);
 assert.match(s,/hasOpenTrade:openSessionSet\.has\(session\.id\)/);
 assert.match(permissions,/preference\?\.paper_execution_enabled === true/);
 assert.match(permissions,/preference\?\.account_mode === "DEMO"/);
 assert.match(permissions,/preference\?\.execution === "WEBSITE_PAPER_ONLY"/);
 assert.match(permissions,/profile\?\.account_mode === "DEMO"/);
 assert.match(s,/trading_instrument_approvals/);
 assert.match(s,/\["M1",60,180\]/);
 assert.match(s,/scalping_signal_events/);
 assert.doesNotMatch(s,/db\.channel\(|\.send\(\{type:"broadcast"/);
 assert.match(s,/DEMO_PAPER_ONLY_NO_BROKER_ORDERS/);
 assert.match(s,/openScalpingPaperPosition/);
 assert.match(s,/if\(!leaseOwned\|\|stopping\)return;/);
 assert.match(s,/openScalpingPaperPosition\(\{db,leaseToken,/);
 assert.match(s,/manageScalpingPaperPosition/);
 assert.match(s,/manageScalpingPaperPosition\(\{db,trade,tick,leaseToken,/);
 assert.match(s,/mark_demo_scalping_paper_trade_with_lease/);
 assert.match(s,/p_lease_token:leaseToken/);
 assert.match(s,/getDerivQuoteToUsd/);
 assert.match(s,/refreshOpenTrades/);
 assert.match(s,/claim_traderwin_scalping_worker/);
 assert.match(s,/release_traderwin_scalping_worker/);
 assert.match(s,/manageOpen/);
 assert.match(s,/manageTradesIndependently\(/);
 assert.match(s,/const managementPromise=manageOpenTrades/);
 assert.match(s,/void managementPromise/);
 assert.doesNotMatch(s,/await managementPromise/);
 assert.doesNotMatch(s,/managementHealthy/);
 assert.match(s,/Promise\.all\(ready\.map\(async item/);
 const refresh=await readFile(new URL("../lib/scalping-trade-refresh.js",import.meta.url),"utf8");
 assert.match(s,/applyOpenTradeSnapshot\(/);
 assert.match(s,/quarantineTradeForRefresh\(/);
 assert.match(refresh,/if\(locks\.has\(id\)\)continue/);
 assert.match(refresh,/pendingRefresh\.delete\(id\)/);
 assert.match(s,/OPEN_SCALPING_POSITION_PROVIDER_MAPPING_MISSING/);
 assert.match(s,/leaseOwned&&leaseFresh&&!stopping&&!state\.lastError/);
 assert.match(s,/leaseAgeMs<=30000/);
 assert.match(s,/leaseLastRenewedAt/);
 assert.match(s,/state\.leaseOwned=leaseOwned/);
 assert.match(s,/async function shutdown\(\)/);
 assert.match(s,/await db\.rpc\("release_traderwin_scalping_worker"/);
 assert.match(s,/if\(stopping\)return;/);
 assert.match(s,/catch\(e\)\{leaseOwned=false;state\.leaseOwned=false;state\.leaseLastError=String\(e\?\.message\|\|e\)\.slice\(0,180\);closeSocket\(\);logError\(e\);scheduleReconnect\(\);\}/);
 assert.match(s,/if\(sessionError\)throw sessionError;/);
 assert.match(s,/if\(preferenceError\)throw preferenceError;/);
 assert.match(s,/if\(profileError\)throw profileError;/);
 assert.match(s,/TIGER_SCHEME_QUANTUM_SCALPING/);
 assert.match(s,/latestContiguousCandles\(candles,interval,240\)/);
 assert.match(s,/async function manageOpenTrades\(instrument,tick\)\{\s*const trades=/);


 assert.match(s,/bidAskMissingTicks:0,marketDataQuality:\{\}/);
 assert.match(s,/bidAskAvailable=payload\.bid!==null&&payload\.ask!==null/);
 assert.match(s,/status:bidAskAvailable\?"BID_ASK_READY":"SPOT_ONLY"/);
 assert.match(s,/DERIV_BID_ASK_UNAVAILABLE:/);

 assert.match(s,/const ws=new WebSocket\(ENDPOINT\);socket=ws;/);
 assert.match(s,/if\(socket!==ws\)return;/);
 assert.match(s,/old\.onmessage=null;old\.onerror=null;old\.onclose=null/);
 assert.match(s,/trade\.side==="BUY"\?tick\.bid:tick\.ask/);
 assert.match(s,/p_price:markPrice/);
 assert.match(s,/catch\(e\) \{ closeSocket\(\);logError\(e\);scheduleReconnect\(\); \}/);
 assert.match(s,/if\(msg\.error\)\{logError\(new Error\("Deriv rejected the public streaming request\."\)\);closeSocket\(\);scheduleReconnect\(\);return;\}/);
 assert.match(s,/m5\.length<25/);
 assert.match(s,/\["M15",900,60\]/);
 assert.match(s,/\["H1",3600,60\]/);
 assert.match(s,/\["H4",14400,60\]/);
 assert.match(s,/contextCandles:\{M15:h\.m15,H1:h\.h1,H4:h\.h4\}/);
 assert.match(s,/req\.kind\]\\|\\|60/);
 assert.match(s,/contextRefreshTimers\.set\(wanted\.instrument,timer\)/);
 assert.match(s,/const intervals=\{M1:60,M5:300,M15:900,H1:3600,H4:14400\}/);
 assert.match(s,/if\(kind==="M1"\)h\.current=null/);

 assert.match(s,/ticks_history:wanted\.providerSymbol,count:60,end:"latest",style:"candles",granularity,req_id:id/);
 assert.match(s,/h\.loadedM15&&h\.loadedH1&&h\.loadedH4/);
 assert.match(s,/h\.m1=latestContiguousCandles\(h\.m1,60,240\)/);
 assert.doesNotMatch(s,/proposal_open_contract|buy\s*\(|sell\s*\(/i);
});

test("scalping portfolio migration allows up to 15 positions with a 1 percent aggregate open-risk cap",async()=>{
 const sql=await readFile(new URL("../supabase/migrations/202611260002_scalping_multi_position_portfolio.sql",import.meta.url),"utf8");
 assert.match(sql,/max_open_positions between 1 and 15/);
 assert.match(sql,/least\(v_preference\.max_open_positions,v_session\.max_open_positions,15\)/);
 assert.match(sql,/v_total_risk_limit := least\(greatest\(0,v_session\.starting_balance \* 0\.01 - v_daily_loss\)/);
 assert.match(sql,/v_open_risk \+ p_risk_amount > v_total_risk_limit/);
 assert.match(sql,/drop index if exists public\.demo_paper_one_open_trade_per_user/);
 assert.match(sql,/drop index if exists public\.demo_paper_one_open_bot_trade_per_session/);
 assert.match(sql,/demo_paper_sessions_max_open_positions_check/);
 assert.match(sql,/pg_advisory_xact_lock\(hashtextextended\(p_user_id::text, 0\)\)/);
 assert.match(sql,/SCALPING_INSTRUMENT_NOT_APPROVED/);
 assert.match(sql,/a\.status='APPROVED' and a\.is_active=true/);
 assert.match(sql,/a\.approved_at is not null and a\.approved_by is not null/);
});

test("base scalping execution guard retains DEMO-only consent and daily risk protections",async()=>{
 const sql=await readFile(new URL("../supabase/migrations/202611260001_scalping_demo_execution_guard.sql",import.meta.url),"utf8");
 assert.match(sql,/open_demo_scalping_paper_trade/);
 assert.match(sql,/p_risk_pct > 0\.25/);
 assert.match(sql,/max_daily_loss_pct,1\.00/);
 assert.match(sql,/paper_execution_enabled boolean not null default false/);
 assert.match(sql,/paper_execution_enabled is not true/);
 assert.match(sql,/CURRENT_ACCOUNT_MODE_NOT_DEMO/);
 assert.match(sql,/from public\.trader_profiles/);
 assert.match(sql,/to service_role/);
 assert.match(sql,/from public, anon, authenticated/);
});

test("paper adapter requires and forwards the worker lease token to the fenced database RPC",async()=>{
 const s=await readFile(new URL("../lib/scalping-paper-adapter.js",import.meta.url),"utf8");
 assert.match(s,/typeof leaseToken !== "string" \|\| !leaseToken/);
 assert.match(s,/open_demo_scalping_paper_trade_batch_with_lease/);
 assert.match(s,/p_entries:entries/);
 assert.match(s,/p_lease_token:leaseToken/);
});
test("atomic scalping batch RPC creates up to 15 positions with portfolio-wide checks",async()=>{
 const sql=await readFile(new URL("../supabase/migrations/202611260008_scalping_atomic_batch_entries.sql",import.meta.url),"utf8");
 assert.match(sql,/open_demo_scalping_paper_trade_batch_with_lease/);
 assert.match(sql,/jsonb_array_length\(p_entries\) > 15/);
 assert.match(sql,/pg_advisory_xact_lock/);
 assert.match(sql,/SCALPING_MAX_OPEN_POSITIONS/);
 assert.match(sql,/SCALPING_TOTAL_OPEN_RISK_LIMIT/);
 assert.match(sql,/SCALPING_DAILY_LOSS_LIMIT/);
 assert.match(sql,/scalping_batch_index/);
 assert.match(sql,/to service_role/);
});
test("worker registers every trade ID returned by one atomic entry batch",async()=>{
 const source=await readFile(new URL("../services/scalping-worker/index.js",import.meta.url),"utf8");
 assert.match(source,/Array\.isArray\(opened\.trade_ids\)/);
 assert.match(source,/\.in\("id",tradeIds\)/);
 assert.match(source,/state\.paperEntries\+=Number\(opened\.opened_count\)/);
});
test("lease-fenced database entry locks and validates the live lease before opening a paper trade",async()=>{
 const sql=await readFile(new URL("../supabase/migrations/202611260003_scalping_worker_lease_fencing.sql",import.meta.url),"utf8");
 assert.match(sql,/open_demo_scalping_paper_trade_with_lease/);
 assert.match(sql,/from public\.scalping_worker_leases[\s\S]*for update/);
 assert.match(sql,/lease_token is distinct from p_lease_token/);
 assert.match(sql,/lease_until <= clock_timestamp\(\)/);
 assert.match(sql,/SCALPING_WORKER_LEASE_NOT_OWNED/);
 assert.match(sql,/return public\.open_demo_scalping_paper_trade/);
});

test("scalping position mark and exit writes are fenced by the active worker lease",async()=>{
 const sql=await readFile(new URL("../supabase/migrations/202611260004_scalping_worker_management_lease_fencing.sql",import.meta.url),"utf8");
 assert.match(sql,/mark_demo_scalping_paper_trade_with_lease/);
 assert.match(sql,/manage_demo_scalping_paper_exit_with_lease/);
 assert.match(sql,/lease_token is distinct from p_lease_token/);
 assert.match(sql,/lease_until <= clock_timestamp\(\)/);
 assert.match(sql,/trade_origin='BOT'/);
 assert.match(sql,/metadata->>'strategy'='TIGER_SCHEME_QUANTUM_SCALPING'/);
});


test("market-gated worker manages each open DEMO position independently", async () => {
 const locks=new Set(),finished=[];
 let releaseA;
 const waitA=new Promise(resolve=>{releaseA=resolve;});
 const run=manageTradesIndependently({
  trades:[{id:"A"},{id:"B"},{id:"B"}],locks,
  manage:async trade=>{if(trade.id==="A")await waitA;finished.push(trade.id);}
 });
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(finished,["B"]);
 assert.deepEqual([...locks],["A"]);
 releaseA();
 assert.equal(await run,true);
 assert.deepEqual(finished.sort(),["A","B"]);
 assert.equal(locks.size,0);
});

test("all 15 positions are evaluated in the same tick management cycle",async()=>{
 const locks=new Set(),started=[],completed=[];
 let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const trades=Array.from({length:15},(_,i)=>({id:"position-"+(i+1)}));
 const run=manageTradesIndependently({
  trades,locks,
  manage:async trade=>{started.push(trade.id);await gate;completed.push(trade.id);}
 });
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(started.length,15);
 assert.equal(locks.size,15);
 release();
 assert.equal(await run,true);
 assert.equal(completed.length,15);
 assert.equal(locks.size,0);
});
test("one position-management error is isolated from other open positions", async () => {
 const locks=new Set(),finished=[],errors=[];
 const ok=await manageTradesIndependently({
  trades:[{id:"A"},{id:"B"},{id:"C"}],locks,
  manage:async trade=>{finished.push(trade.id);if(trade.id==="B")throw new Error("isolated exit failure");},
  onError:(error,trade)=>errors.push([trade.id,error.message])
 });
 assert.equal(ok,false);
 assert.deepEqual(finished.sort(),["A","B","C"]);
 assert.deepEqual(errors,[["B","isolated exit failure"]]);
 assert.equal(locks.size,0);
});
