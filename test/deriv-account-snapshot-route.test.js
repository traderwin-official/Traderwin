import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { encryptToken, decryptToken } from "../lib/encryption.js";

test("decrypts only authenticated AES-256-GCM token envelopes", () => {
  const previous = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
  try {
    const encrypted = encryptToken("deriv-secret-access-token");
    assert.equal(decryptToken(encrypted), "deriv-secret-access-token");
    const parts = encrypted.split(":");
    parts[2] = (parts[2][0] === "0" ? "1" : "0") + parts[2].slice(1);
    assert.throws(() => decryptToken(parts.join(":")));
    assert.throws(() => decryptToken("not-an-envelope"));
  } finally {
    if (previous === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = previous;
  }
});

test("Deriv account snapshot route is authenticated, selected-DEMO scoped and read-only", async () => {
  const route = await readFile(new URL("../api/deriv/account-snapshot.js", import.meta.url), "utf8");
  assert.match(route, /auth\.getUser/);
  assert.match(route, /encrypted_access_token/);
  assert.match(route, /demo_account_id/);
  assert.match(route, /\/trading\/v1\/options\/accounts/);
  assert.match(route, /\/otp/);
  assert.match(route, /ws\/demo/);
  assert.match(route, /balance: 1/);
  assert.match(route, /portfolio: 1/);
  assert.match(route, /real_trading_enabled: false/);
  assert.match(route, /execution_authorized: false/);
  assert.doesNotMatch(route, /buy: 1|sell: 1|proposal:/);
});
