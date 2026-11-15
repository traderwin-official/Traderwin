import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("DEMO worker is cron-secret protected and uses a database lease", async () => {
  const source = await readFile(new URL("../api/cron/demo-auto-worker.js", import.meta.url), "utf8");
  assert.match(source, /CRON_SECRET/);
  assert.ok(source.includes("authorization !=="));
  assert.ok(source.includes("CRON_SECRET"));
  assert.match(source, /claim_traderwin_demo_worker/);
  assert.match(source, /release_traderwin_demo_worker/);
  assert.match(source, /p_lease_seconds: 120/);
  assert.match(source, /maxDuration: 25/);
  assert.match(source, /CRON_SECRET.length < 32/);
  assert.match(source, /MANUAL_POSITION_NOT_MANAGED/);
  assert.match(source, /realOrdersSent: 0/);
});

test("DEMO worker only queries running DEMO sessions and Deriv broker settings", async () => {
  const source = await readFile(new URL("../api/cron/demo-auto-worker.js", import.meta.url), "utf8");
  assert.match(source, /\.eq\("status", "RUNNING"\)/);
  assert.match(source, /\.eq\("account_mode", "DEMO"\)/);
  assert.match(source, /String\(settings\.broker\)\.toUpperCase\(\) !== "DERIV"/);
  assert.match(source, /kill_switch_active/);
  assert.match(source, /emergency\?\.kill_switch_active && !openTrade/);
  assert.match(source, /SESSION_PAUSED_NO_OPEN_POSITION/);
  assert.match(source, /\.in\("status", \["RUNNING", "PAUSED", "RISK_LOCKED"\]\)/);
});

test("worker migration adds atomic lease, open and close functions", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611120016_demo_auto_worker.sql", import.meta.url), "utf8");
  assert.match(sql, /claim_traderwin_demo_worker/);
  assert.match(sql, /open_demo_auto_trade/);
  assert.match(sql, /close_demo_auto_trade/);
  assert.match(sql, /worker_last_candle_as_of/);
  assert.match(sql, /kill_switch_active = true/);
  assert.match(sql, /v_daily_limit := v_session.starting_balance/);
  assert.match(sql, /p_quote_source is null/);
  assert.match(sql, /MANUAL_TRADE_NOT_MANAGED/);
  assert.match(sql, /AUTO_OPEN/);
  assert.match(sql, /AUTO_ENTRY_BLOCKED/);
  assert.match(sql, /trade_source/);
  assert.match(sql, /demo_bot_one_open_trade_per_user/);
  assert.match(sql, /set status =/);
  assert.match(sql, /Africa\/Nairobi/);
  assert.match(sql, /to service_role/);
});

test("Supabase Cron schedule stores the worker secret in Vault and calls the endpoint every minute", async () => {
  const setup = await readFile(new URL("../docs/DEMO_WORKER_SCHEDULING.md", import.meta.url), "utf8");
  assert.match(setup, /vault\.create_secret/);
  assert.match(setup, /vault\.decrypted_secrets/);
  assert.match(setup, /cron\.schedule/);
  assert.match(setup, /\* \* \* \* \*/);
  assert.match(setup, /net\.http_get/);
  assert.match(setup, /Authorization/);
});

test("risk-locked sessions remain in the DEMO worker queue for open-position protection", async () => {
  const source = await readFile(new URL("../api/cron/demo-auto-worker.js", import.meta.url), "utf8");
  const decision = await readFile(new URL("../lib/demo-auto-decision.js", import.meta.url), "utf8");
  assert.match(source, /\["PAUSED", "RISK_LOCKED"\]\.includes\(session\.status\) && !openTrade/);
  assert.match(source, /\.in\("status", \["RUNNING", "PAUSED", "RISK_LOCKED"\]\)/);
  assert.match(decision, /session\.status === "RISK_LOCKED" && !openTrade/);
});

test("daily-loss migration counts partial realizations and keeps risk-locked open positions manageable", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611160001_demo_daily_loss_partial_realizations.sql", import.meta.url), "utf8");
  assert.match(sql, /demo_daily_realized_loss/);
  assert.match(sql, /realized_pnl_this_stage/);
  assert.match(sql, /p_exclude_trade_id/);
  assert.match(sql, /'TP1','TP2','TP3','STOP_LOSS','AUTO_CLOSE','MANUAL_CLOSE'/);
  assert.match(sql, /status in \('RUNNING','PAUSED'\)/);
  assert.match(sql, /to service_role/);
});

test("manual DEMO close delegates balance, cumulative P&L and daily risk updates to one atomic RPC", async () => {
  const route = await readFile(new URL("../api/bots/demo/close.js", import.meta.url), "utf8");
  const sql = await readFile(new URL("../supabase/migrations/202611160001_demo_daily_loss_partial_realizations.sql", import.meta.url), "utf8");
  assert.match(route, /rpc\("close_demo_paper_trade"/);
  assert.match(route, /normalise\(quote\.instrument\).*normalise\(trade\.symbol\)/s);
  assert.doesNotMatch(route, /from\("demo_bot_trades"\)\s*\.update/);
  assert.match(sql, /create or replace function public\.close_demo_paper_trade/);
  assert.match(sql, /'action','MANUAL_CLOSE'/);
  assert.match(sql, /realized_pnl_total/);
  assert.match(sql, /demo_daily_realized_loss\(p_user_id,v_day_start,null\)/);
});
