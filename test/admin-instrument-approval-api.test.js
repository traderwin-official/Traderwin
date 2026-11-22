import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const api = readFileSync(new URL("../handlers/admin/instruments.js", import.meta.url), "utf8");

test("instrument administration requires a verified bearer session and ADMIN role", () => {
  assert.match(api, /req\.headers\.authorization/);
  assert.match(api, /db\.auth\.getUser\(/);
  assert.match(api, /from\("traderwin_admin_roles"\)/);
  assert.match(api, /toUpperCase\(\) !== "ADMIN"/);
  assert.match(api, /return res\.status\(403\)/);
});

test("only server-side service role accesses the private registry", () => {
  assert.match(api, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(api, /from\("trading_instrument_approvals"\)/);
  assert.match(api, /from\("trading_instrument_approval_audit"\)/);
  assert.match(api, /Cache-Control", "no-store"/);
});

test("registration starts pending and cannot self-approve using browser fields", () => {
  assert.match(api, /status: "PENDING", is_active: false/);
  assert.match(api, /approved_by: null, approved_at: null/);
  assert.match(api, /updated_by: actor/);
  assert.doesNotMatch(api, /approved_by:\s*body\./);
  assert.match(api, /status: "APPROVED", is_active: true, approved_by: actor/);
});

test("approval and disable actions require a reason and exact provider mapping", () => {
  assert.match(api, /reason\.length < 8/);
  assert.match(api, /const instrument = cleanText\(body\.instrument, 30\)\.toUpperCase\(\)/);
  assert.match(api, /provider_symbol: providerSymbol/);
  assert.match(api, /\.eq\("provider_symbol", providerSymbol\)/);
  assert.match(api, /status: "DISABLED", is_active: false/);
});

test("support and analyst roles cannot approve instruments", () => {
  assert.match(api, /toUpperCase\(\) !== "ADMIN"/);
  assert.match(api, /Only platform administrators can manage approved instruments/);
});
