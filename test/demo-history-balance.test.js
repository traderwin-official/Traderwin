import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("DEMO history endpoint is authenticated, read-only and returns closed trades across sessions", async () => {
  const route = await readFile(new URL("../handlers/bots/demo/history.js", import.meta.url), "utf8");
  assert.match(route, /req\.method!==\"GET\"/);
  assert.match(route, /auth\.getUser/);
  assert.match(route, /from\(\"demo_paper_sessions\"\)/);
  assert.match(route, /from\(\"demo_paper_trades\"\)/);
  assert.match(route, /order\(\"opened_at\"/);
  assert.match(route, /get_demo_paper_account_balance/);
  assert.match(route, /realizedPnl/);
  assert.doesNotMatch(route, /\.insert\(|\.update\(|\.delete\(/);
});

test("DEMO account balance carries all realized P/L into each new session", async () => {
  const route = await readFile(new URL("../handlers/bots/demo/control.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/202611240005_demo_account_balance_history.sql", import.meta.url), "utf8");
  assert.match(route, /rpc\(\"get_demo_paper_account_balance\"/);
  assert.match(route, /starting_balance:carriedBalance,current_balance:carriedBalance/);
  assert.match(migration, /10000 \+ coalesce\(sum\(realized_pnl_usd\),0\)/);
  assert.match(migration, /grant execute .*service_role/s);
});

test("DEMO dashboard shows account history and refreshes it after a manual close", async () => {
  const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(page, /id=\"demoTradeHistory\"/);
  assert.match(page, /id=\"demoHistoryRows\"/);
  assert.match(page, /\/api\/bots\/demo\/history/);
  assert.match(page, /await loadDemoTradeHistory\(\)/);
  assert.match(page, /Balance carries across sessions/);
});

test("DEMO history API is registered as an explicit Vercel route", async () => {
  const dispatcher = await readFile(new URL("../api/router.js", import.meta.url), "utf8");
  assert.match(dispatcher, /handlers\/bots\/demo\/history\.js/);
  assert.match(dispatcher, /\/api\/bots\/demo\/history/);
});


test("DEMO dashboard never presents the default balance as verified when history cannot load", async () => {
  const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(page, /id="demoVirtualBalance">Virtual balance: Loading saved account/);
  assert.match(page, /Virtual balance: Unavailable — saved account data could not be verified/);
});
