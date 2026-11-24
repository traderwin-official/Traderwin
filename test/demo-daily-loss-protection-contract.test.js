import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("daily DEMO limit is fixed at 20% of the Nairobi day-opening account balance", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611240004_daily_equity_loss_protection.sql", import.meta.url), "utf8");
  assert.match(sql, /date_trunc\('day',now\(\) at time zone 'Africa\/Nairobi'\)/);
  assert.match(sql, /round\(v_opening\*0\.20,2\)/);
  assert.match(sql, /v_equity <= greatest\(0,v_opening-v_threshold\)/);
  assert.match(sql, /check \(max_daily_loss_pct=20\)/);
  assert.match(sql, /on conflict\(user_id,trading_day\) do nothing/);
  assert.match(sql, /10000 \+ coalesce\(sum\(realized_pnl_usd\),0\)/);
  assert.ok(sql.indexOf("update public.demo_paper_sessions set max_daily_loss_pct=20;") < sql.indexOf("add constraint demo_paper_sessions_daily_loss_fixed_20"));
});

test("daily account equity includes current-day realized P/L and all floating P/L", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611240004_daily_equity_loss_protection.sql", import.meta.url), "utf8");
  assert.match(sql, /sum\(realized_pnl_delta_usd\)/);
  assert.match(sql, /v_opening\+v_realized\+v_floating/);
  assert.match(sql, /p_floating_pnl_usd numeric/);
  assert.match(sql, /demo_paper_realized_events/);
  assert.match(sql, /last_valuation_at=now\(\)/);
  assert.match(sql, /limit_reached_at=case/);
  assert.doesNotMatch(sql, /evaluate_demo_daily_loss_guard\(new\.user_id,0\)/);
});

test("daily-loss close defaults to BOT positions and requires explicit manual close permissions", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611240004_daily_equity_loss_protection.sql", import.meta.url), "utf8");
  assert.match(sql, /v_trade\.trade_origin='MANUAL'/);
  assert.match(sql, /manual_trade_management is not true/);
  assert.match(sql, /close_manual_trades is not true/);
  assert.match(sql, /close_managed_positions is not true/);
  assert.match(sql, /v_trade\.trade_origin='BOT'/);
  assert.doesNotMatch(sql, /BOT_CLOSE_PERMISSION_NOT_GRANTED/);
  assert.match(sql, /Daily account protection always closes automated DEMO positions/);
  assert.match(sql, /close_demo_paper_trade\(/);
  assert.match(sql, /daily_loss_close_key/);
});

test("worker values accounts before new BOT entries and blocks entries without a fresh user check", async () => {
  const worker = await readFile(new URL("../handlers/cron/demo-auto-worker.js", import.meta.url), "utf8");
  assert.match(worker, /runDemoDailyLossProtection/);
  assert.match(worker, /DAILY_EQUITY_GUARD_UNAVAILABLE/);
  assert.match(worker, /userGuard\.status!=="ERROR"/);
  assert.ok(worker.indexOf("try{dailyLossProtection=await runDemoDailyLossProtection") < worker.indexOf("results=await Promise.all"));
});

test("manual DEMO entry checks the same daily guard before calling the atomic open RPC", async () => {
  const route = await readFile(new URL("../handlers/bots/demo/trade.js", import.meta.url), "utf8");
  assert.match(route, /runDemoDailyLossProtection\(db,\{userIds:\[uid\]/);
  assert.match(route, /DAILY_LOSS_LIMIT_REACHED/);
  assert.ok(route.indexOf("const dailyGuard=await runDemoDailyLossProtection") < route.indexOf('db.rpc("open_demo_paper_trade"'));
});

test("daily BOT closes use a fresh verified Deriv quote and the dedicated permission-gated RPC", async () => {
  const adapter = await readFile(new URL("../lib/demo-portfolio-adapters.js", import.meta.url), "utf8");
  assert.match(adapter, /async closeDailyLossPosition/);
  assert.match(adapter, /getDerivPublicQuote/);
  assert.match(adapter, /getDerivQuoteToUsd/);
  assert.match(adapter, /db\.rpc\("close_demo_daily_loss_trade"/);
});

test("all DEMO trade insertion paths require a fresh valuation and no sticky daily lock", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611240004_daily_equity_loss_protection.sql", import.meta.url), "utf8");
  assert.match(sql, /before insert on public\.demo_paper_trades/);
  assert.match(sql, /last_valuation_at < now\(\)-interval '60 seconds'/);
  assert.match(sql, /limit_reached_at is not null/);
  assert.match(sql, /create or replace function public\.open_demo_paper_trade/);
  assert.doesNotMatch(sql, /v_daily_loss := greatest/);
  assert.match(sql, /v_session\.max_open_positions/);
  assert.match(sql, /TOTAL_OPEN_RISK_LIMIT/);
  assert.match(sql, /BOT_POSITION_EXISTS/);
});

test("daily valuation queue advances verified marks so later accounts are not starved", async () => {
  const runner = await readFile(new URL("../lib/demo-daily-loss-protection-runner.js", import.meta.url), "utf8");
  assert.match(runner, /mark_demo_paper_trade/);
  assert.match(runner, /p_quote_as_of:position\.quoteAsOf/);
  assert.match(runner, /p\.source==="BOT"\s*\|\|/);
  assert.match(runner, /permissions\.closeManualTrades/);
});
