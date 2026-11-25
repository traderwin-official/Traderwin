import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("admin instrument approvals use authenticated server-side authorization", async () => {
  const page = await readFile(new URL("../admin-instruments.html", import.meta.url), "utf8");
  const api = await readFile(new URL("../handlers/admin/instruments.js", import.meta.url), "utf8");
  assert.match(page, /api\/admin\/instruments/);
  assert.match(page, /getSession\(\)/);
  assert.match(page, /Owner-approved for initial website DEMO trading/);
  assert.match(api, /traderwin_admin_roles/);
  assert.match(api, /toUpperCase\(\) !== "ADMIN"/);
  assert.doesNotMatch(page, /SUPABASE_SERVICE_ROLE_KEY|service_role/i);
});

test("first DEMO approval uses exact provider symbols and is not auto-seeded", async () => {
  const migration = await readFile(new URL("../supabase/migrations/202611200006_trading_instrument_approval_registry.sql", import.meta.url), "utf8");
  const page = await readFile(new URL("../admin-instruments.html", import.meta.url), "utf8");
  assert.match(migration, /Empty registry means all instruments are denied/);
  assert.match(page, /XAUUSD\|frxXAUUSD/);
  assert.match(page, /action:"approve"/);
});
