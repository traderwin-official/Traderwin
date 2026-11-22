import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("manual DEMO permission API requires an authenticated DEMO session and explicit booleans", async () => {
  const source = await readFile(new URL("../handlers/bots/demo/portfolio-permissions.js", import.meta.url), "utf8");
  assert.match(source, /auth\.getUser/);
  assert.match(source, /profile\.account_mode!=="DEMO"/);
  assert.match(source, /monitorManualTrades/);
  assert.match(source, /closeManualTrades/);
  assert.match(source, /body\.closeManualTrades&&!body\.monitorManualTrades/);
  assert.match(source, /manual_trade_management:body\.monitorManualTrades/);
  assert.match(source, /close_manual_trades:body\.closeManualTrades/);
  assert.match(source, /onConflict:"user_id,account_mode,broker,broker_account_ref"/);
});

test("dashboard keeps manual monitoring and manual closing as separate explicit choices", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="monitorManualTrades"/);
  assert.match(html, /id="closeManualTrades"/);
  assert.match(html, /id="saveDemoPortfolioPermissions"/);
  assert.match(html, /Allow the portfolio guard to automatically close my manual DEMO positions/);
  assert.match(html, /portfolio-permissions/);
});

test("portfolio close RPC rechecks manual permissions under a row lock and is idempotent", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611200004_demo_portfolio_close_authorization.sql", import.meta.url), "utf8");
  assert.match(sql, /close_demo_portfolio_trade/);
  assert.match(sql, /for update/);
  assert.match(sql, /manual_trade_management is not true/);
  assert.match(sql, /close_manual_trades is not true/);
  assert.match(sql, /close_managed_positions is not true/);
  assert.match(sql, /bot_trade_management is not true/);
  assert.match(sql, /p_instrument text/);
  assert.match(sql, /upper\(v_trade\.instrument\) <> upper\(p_instrument\)/);
  assert.match(sql, /portfolio_close_request_key/);
  assert.match(sql, /already_closed/);
  assert.match(sql, /to service_role/);
});
