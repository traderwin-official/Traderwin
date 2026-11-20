import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Deriv OAuth requests trading and account-management scopes", async () => {
  const source = await readFile(new URL("../api/deriv/start.js", import.meta.url), "utf8");
  assert.match(source, /searchParams\.set\("scope", "trade account_manage"\)/);
});

test("Deriv callback verifies, sanitizes and stores the complete account list", async () => {
  const source = await readFile(new URL("../api/deriv/callback.js", import.meta.url), "utf8");
  assert.match(source, /\/trading\/v1\/options\/accounts/);
  assert.match(source, /normalizeVerifiedDerivAccounts\(accountsPayload\)/);
  assert.match(source, /selectUnambiguousAccountId\(accounts, "demo"\)/);
  assert.match(source, /demo_account_id: demoAccountId/);
  assert.match(source, /real_account_id: realAccountId/);
  assert.match(source, /accounts,/);
  assert.match(source, /requested_scopes: \["trade", "account_manage"\]/);
  assert.doesNotMatch(source, /eligible\.find\(account/);
});

test("Deriv connection status requires a selected verified DEMO account and unexpired token", async () => {
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

test("Deriv OAuth callback uses shared AES-GCM encryption and bounded upstream requests", async () => {
  const source = await readFile(new URL("../api/deriv/callback.js", import.meta.url), "utf8");
  assert.ok(source.includes('import { encryptToken } from "../../lib/encryption.js"'));
  assert.match(source, /AbortSignal\.timeout\(15000\)/);
  assert.match(source, /tokenResponse\.json\(\)\.catch\(\(\) => \(\{\}\)\)/);
  assert.match(source, /typeof tokenData\.access_token !== "string"/);
  assert.ok(source.includes("stage,\n      name:"));
  assert.equal(source.includes("function encryptToken("), false);
});
