import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("emergency control route requires authenticated account scope and exposes entry-stop actions only", async () => {
  const source = await readFile(new URL("../api/bots/emergency/control.js", import.meta.url), "utf8");
  assert.match(source, /getUser\(/);
  assert.match(source, /STOP_ENTRIES/);
  assert.match(source, /CLEAR_STOP/);
  assert.match(source, /kill_switch_active/);
  assert.match(source, /does not close open positions|does not close positions/i);
  assert.doesNotMatch(source, /closePosition\s*\(/);
});

test("emergency control schema is service-role only and scoped to user/account/mode", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611120011_bot_emergency_controls.sql", import.meta.url), "utf8");
  assert.match(sql, /unique\s*\(user_id,\s*account_mode,\s*broker,\s*broker_account_ref\)/i);
  assert.match(sql, /revoke all on public\.bot_emergency_controls from public, anon, authenticated/i);
  assert.match(sql, /enable row level security/i);
});

test("DEMO bot start and paper-entry endpoints both enforce the persisted emergency latch", async () => {
  const startRoute = await readFile(new URL("../api/bots/demo/control.js", import.meta.url), "utf8");
  const entryRoute = await readFile(new URL("../api/bots/demo/trade.js", import.meta.url), "utf8");
  assert.match(entryRoute, /select\("broker,instrument,account_mode,max_risk_per_trade_pct"\)/);
  for (const source of [startRoute, entryRoute]) {
    assert.match(source, /from\("bot_emergency_controls"\)/);
    assert.match(source, /kill_switch_active/);
    assert.ok(source.includes("DEMO:${uid}"));
  }
});
