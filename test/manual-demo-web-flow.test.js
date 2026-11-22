import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("website DEMO session starts from the selected instrument without bot settings", async () => {
  const route = await readFile(new URL("../api/bots/demo/control.js", import.meta.url), "utf8");
  assert.match(route, /requestedInstrument=String\(b\.instrument/);
  assert.match(route, /strategy:"MANUAL"/);
  assert.match(route, /config_snapshot:.*WEBSITE_PAPER_ONLY/);
  assert.doesNotMatch(route, /from\("bot_settings"\)/);
});

test("manual website DEMO entries use the session risk limits and no external bot settings", async () => {
  const route = await readFile(new URL("../api/bots/demo/trade.js", import.meta.url), "utf8");
  assert.match(route, /from\("demo_paper_sessions"\)/);
  assert.match(route, /Math\.min\(Number\(profile\.max_risk_per_trade_pct\),Number\(session\.risk_per_trade_pct\)\)/);
  assert.match(route, /p_trade_origin:"MANUAL"/);
  assert.doesNotMatch(route, /from\("bot_settings"\)/);
});

test("public dashboard presents website manual DEMO trading, not a standalone bot storefront", async () => {
  const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(page, /Website DEMO Trading/);
  assert.match(page, /action:"START",instrument:document\.getElementById\("paperSymbol"\)/);
  assert.doesNotMatch(page, /Buy Standalone Bot|bot-shop\.html/);
});
