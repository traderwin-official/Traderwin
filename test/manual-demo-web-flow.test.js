import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("website DEMO session starts from the selected instrument without bot settings", async () => {
  const route = await readFile(new URL("../handlers/bots/demo/control.js", import.meta.url), "utf8");
  assert.match(route, /requestedInstrument=String\(b\.instrument/);
  assert.match(route, /let selectedStrategy="MANUAL"/);
  assert.match(route, /executionMode==="AUTO"/);
  assert.match(route, /config_snapshot:.*executionMode==="AUTO"/);
  assert.match(route, /from\("bot_settings"\)/);
});

test("DEMO dashboard timeframe selector supports M5 M15 H1 H4 and sends selection to session API", async () => {
  const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const route = await readFile(new URL("../handlers/bots/demo/control.js", import.meta.url), "utf8");
  assert.match(page, /id="demoTimeframe"/);
  for (const timeframe of ["M5", "M15", "H1", "H4"]) assert.match(page, new RegExp('value="' + timeframe + '"'));
  assert.match(page, /timeframe:document\.getElementById\("demoTimeframe"\)\.value/);
  assert.match(page, /intervalByTimeframe=\{M5:"5",M15:"15",H1:"60",H4:"240"\}/);
  assert.match(route, /requestedTimeframe=String\(b\.timeframe\|\|"M15"\)/);
  assert.match(route, /timeframe=requestedTimeframe/);
  assert.match(route, /latest\.timeframe!==timeframe/);
});

test("consolidated DEMO upgrade persists the bot timeframe and grants owner-only column writes", async () => {
  const sql = await readFile(new URL("../supabase/manual/DEMO_TERMINAL_PRODUCTION_UPGRADE.sql", import.meta.url), "utf8");
  const patch = await readFile(new URL("../supabase/manual/DEMO_TIMEFRAME_SETTINGS_UPGRADE.sql", import.meta.url), "utf8");
  assert.match(sql, /add column if not exists timeframe text not null default 'M15'/);
  assert.match(patch, /add column if not exists timeframe text not null default 'M15'/);
  assert.match(patch, /bot_settings_timeframe_check/);
  assert.match(sql, /bot_settings_timeframe_check/);
  assert.match(sql, /check \(timeframe in \('M5','M15','H1','H4'\)\)/);
  assert.match(sql, /grant insert\(user_id,broker,instrument,account_mode,strategy,max_risk_per_trade_pct,timeframe\)/);
  assert.match(sql, /grant update\(broker,instrument,account_mode,strategy,max_risk_per_trade_pct,timeframe\)/);
});

test("manual website DEMO entries use the session risk limits and no external bot settings", async () => {
  const route = await readFile(new URL("../handlers/bots/demo/trade.js", import.meta.url), "utf8");
  assert.match(route, /from\("demo_paper_sessions"\)/);
  assert.match(route, /Math\.min\(Number\(profile\.max_risk_per_trade_pct\),Number\(session\.risk_per_trade_pct\)\)/);
  assert.match(route, /open_demo_manual_partial_trade/);
  assert.doesNotMatch(route, /from\("bot_settings"\)/);
});

test("instrument approval page uses the authenticated server admin API", async () => {
  const page = await readFile(new URL("../admin-instruments.html", import.meta.url), "utf8");
  assert.match(page, /api\/admin\/instruments/);
  assert.match(page, /Owner-approved for initial website DEMO trading/);
  assert.match(page, /Approve selected instrument/);
  assert.match(page, /getSession\(\)/);
  assert.doesNotMatch(page, /service_role|SUPABASE_SERVICE_ROLE_KEY/);
});

test("manual DEMO quote checks enforce stop-loss and take-profit using an atomic virtual close", async () => {
  const route = await readFile(new URL("../handlers/bots/demo/mark.js", import.meta.url), "utf8");
  assert.match(route, /stopHit/);
  assert.match(route, /targetHit/);
  assert.match(route, /close_demo_paper_trade/);
  assert.match(route, /p_reason:reason/);
});
 
test("dashboard keeps website DEMO trading separate and links to the standalone bot storefront", async () => {
  const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const shop = await readFile(new URL("../bot-shop.html", import.meta.url), "utf8");
  assert.match(page, /Website DEMO Trading/);
  assert.match(page, /id="demoExecutionMode"/);
  assert.match(page, /Auto-select best validated strategy/);
    assert.match(page, /action:"START"/);
      assert.match(page, /bot-shop/);
  assert.match(shop, /TIGER SCHEME AI BOT/);
  assert.match(shop, /STANDALONE EXPERT ADVISOR/);
  assert.match(shop, /Purchases and M-Pesa checkout remain disabled/);
});
