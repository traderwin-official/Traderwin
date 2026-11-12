import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("DEMO trade entry is blocked until a trusted quote adapter is connected", async () => {
  const source = await readFile(new URL("../api/bots/demo/trade.js", import.meta.url), "utf8");
  const gate = source.indexOf("Verified live market-data feed is not connected");
  const insert = source.indexOf('.from("demo_bot_trades").insert(');
  assert.notEqual(gate, -1);
  assert.ok(insert === -1 || gate < insert);
  assert.doesNotMatch(source, /quote_source:"USER_SUPPLIED_DEMO_PRICE"/);
});

test("DEMO mark and close do not accept browser-supplied prices while feed is unavailable", async () => {
  const mark = await readFile(new URL("../api/bots/demo/mark.js", import.meta.url), "utf8");
  const close = await readFile(new URL("../api/bots/demo/close.js", import.meta.url), "utf8");
  assert.match(mark, /Verified live market-data feed is not connected/);
  assert.match(close, /Verified live market-data feed is not connected/);
});

test("DEMO ledger requires an approved source label and quote timestamp", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611120005_demo_paper_trading.sql", import.meta.url), "utf8");
  assert.match(sql, /quote_source text not null check\(quote_source in\('DERIV','MT5','VERIFIED_DATA_PROVIDER'\)\)/);
  assert.match(sql, /quote_as_of timestamptz not null/);
  assert.doesNotMatch(sql, /USER_SUPPLIED_DEMO_PRICE/);
});
