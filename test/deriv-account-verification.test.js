import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Deriv OAuth requests the trade scope required for account verification", async () => {
  const source = await readFile(new URL("../api/deriv/start.js", import.meta.url), "utf8");
  assert.match(source, /searchParams\.set\("scope", "trade"\)/);
});

test("Deriv callback verifies accounts and token expiry before saving a connection", async () => {
  const source = await readFile(new URL("../api/deriv/callback.js", import.meta.url), "utf8");
  assert.match(source, /\/trading\/v1\/options\/accounts/);
  assert.match(source, /demoAccount/);
  assert.match(source, /token_expires_at: tokenExpiresAt/);
  assert.match(source, /demo_account_id: String\(demoAccount\.account_id\)/);
});

test("Deriv connection status requires a verified demo account and unexpired token", async () => {
  const source = await readFile(new URL("../api/deriv/status.js", import.meta.url), "utf8");
  assert.match(source, /demo_account_id && tokenValid/);
  assert.match(source, /realAccountId/);
});

test("Deriv account verification migration adds separate demo and real account IDs", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611120015_deriv_account_verification.sql", import.meta.url), "utf8");
  assert.match(sql, /demo_account_id text/);
  assert.match(sql, /real_account_id text/);
  assert.match(sql, /token_expires_at timestamptz/);
});
