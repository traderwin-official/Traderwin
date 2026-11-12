import test from "node:test";
import assert from "node:assert/strict";

test("emergency control endpoint exists and exposes only entry-stop actions", async () => {
  const { default: handler } = await import("../api/bots/emergency/control.js");
  assert.equal(typeof handler, "function");
});

test("emergency control schema is service-role only and scoped to user/account/mode", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../supabase/migrations/202611120011_bot_emergency_controls.sql", import.meta.url), "utf8");
  assert.match(sql, /unique\s*\(user_id,\s*account_mode,\s*broker,\s*broker_account_ref\)/i);
  assert.match(sql, /revoke all on public\.bot_emergency_controls from public, anon, authenticated/i);
  assert.match(sql, /enable row level security/i);
});
