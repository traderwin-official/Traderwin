import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("website DEMO session starts from the selected instrument without bot settings", async () => {
  const route = await readFile(new URL("../handlers/bots/demo/control.js", import.meta.url), "utf8");
  assert.match(route, /requestedInstrument=String\(b\.instrument/);
  assert.match(route, /strategy:"MANUAL"/);
  assert.match(route, /config_snapshot:.*WEBSITE_PAPER_ONLY/);
  assert.doesNotMatch(route, /from\("bot_settings"\)/);
});

test("manual website DEMO entries use the session risk limits and no external bot settings", async () => {
  const route = await readFile(new URL("../handlers/bots/demo/trade.js", import.meta.url), "utf8");
  assert.match(route, /from\("demo_paper_sessions"\)/);
  assert.match(route, /Math\.min\(Number\(profile\.max_risk_per_trade_pct\),Number\(session\.risk_per_trade_pct\)\)/);
  assert.match(route, /p_trade_origin:"MANUAL"/);
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
  assert.match(page, /action:"START",instrument:document\\.getElementById\\("paperSymbol"\\)/);
  assert.match(page, /href="\\/bot-shop\\.html"/);
  assert.match(shop, /TIGER SCHEME AI BOT/);
  assert.match(shop, /STANDALONE EXPERT ADVISOR/);
  assert.match(shop, /Purchases and M-Pesa checkout remain disabled/);
});
