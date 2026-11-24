import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("manual DEMO entries require three ordered targets and allocations totaling 100 percent", async () => {
  const route = await readFile(new URL("../handlers/bots/demo/trade.js", import.meta.url), "utf8");
  assert.match(route, /tp1=num\(b\.tp1\),tp2=num\(b\.tp2\),tp3=num\(b\.tp3\)/);
  assert.match(route, /Math\.round\(\(tp1Percent\+tp2Percent\+tp3Percent\)\*100\)!==10000/);
  assert.match(route, /validTargets\(finalQuote\.quote,direction\)/);
  assert.match(route, /open_demo_manual_partial_trade/);
  assert.match(route, /profile\.account_mode!=="DEMO"/);
  assert.doesNotMatch(route, /buy\(|sell\(|placeOrder|sendBrokerOrder/i);
});

test("manual partial-exit migration enforces percentages and service-role-only DEMO RPCs", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611240002_manual_demo_partial_exits.sql", import.meta.url), "utf8");
  assert.match(sql, /tp1_percent numeric\(5,2\) not null default 40/);
  assert.match(sql, /round\(tp1_percent \+ tp2_percent \+ tp3_percent, 2\) = 100/);
  assert.match(sql, /create or replace function public\.open_demo_manual_partial_trade/);
  assert.match(sql, /Three positive target allocations must total exactly 100 percent/);
  assert.match(sql, /create or replace function public\.manage_demo_manual_partial_exit/);
  assert.match(sql, /v_trade\.trade_origin <> 'MANUAL'/);
  assert.match(sql, /v_permission\.auto_exit_manual_brackets is not true/);
  assert.match(sql, /v_qty := v_trade\.remaining_quantity/);
  assert.match(sql, /p_stage = 'STOP_LOSS'/);
  assert.match(sql, /to service_role/);
  assert.match(sql, /from public, anon, authenticated/);
});

test("scheduled manual DEMO worker processes SL and each configured TP stage only after explicit opt-in", async () => {
  const worker = await readFile(new URL("../handlers/cron/demo-auto-worker.js", import.meta.url), "utf8");
  assert.match(worker, /eq\("auto_exit_manual_brackets",true\)/);
  assert.match(worker, /eq\("trade_origin","MANUAL"\)/);
  assert.match(worker, /tp1_price,tp2_price,tp3_price,tp1_percent,tp2_percent,tp3_percent/);
  assert.match(worker, /manage_demo_manual_partial_exit/);
  assert.match(worker, /p_stage:"STOP_LOSS"/);
  assert.match(worker, /stages=\["TP1","TP2","TP3"\]/);
  assert.match(worker, /getDerivPublicQuote\(trade\.instrument\)/);
  assert.match(worker, /realOrdersSent:0/);
});

test("manual DEMO mark route cannot invoke automatic partial exits without the dedicated permission", async () => {
  const route = await readFile(new URL("../handlers/bots/demo/mark.js", import.meta.url), "utf8");
  assert.match(route, /auto_exit_manual_brackets/);
  assert.match(route, /if\(t\.trade_origin==="MANUAL"&&autoExitAllowed\)/);
  assert.match(route, /manage_demo_manual_partial_exit/);
});

test("dashboard exposes target prices and configurable percentages with a live 100 percent check", async () => {
  const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const id of ["paperTp1", "paperTp2", "paperTp3", "paperTp1Percent", "paperTp2Percent", "paperTp3Percent"]) {
    assert.match(page, new RegExp('id="' + id + '"'));
  }
  assert.match(page, /updateAllocationStatus/);
  assert.match(page, /Math\.round\(total\*100\)===10000/);
  assert.match(page, /stop-loss closes whatever remains/);
});

test("DEMO positions expose T1 T2 T3 allocation and completion state", async () => {
  const route = await readFile(new URL("../handlers/bots/demo/positions.js", import.meta.url), "utf8");
  const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(route, /tp1_price,tp2_price,tp3_price,tp1_percent,tp2_percent,tp3_percent,tp1_done,tp2_done,tp3_done/);
  assert.match(route, /targets: \[1,2,3\]\.map/);
  assert.match(page, /Targets \(T1 \/ T2 \/ T3\)/);
  assert.match(page, /target\.done\?" ✓":""/);
});
