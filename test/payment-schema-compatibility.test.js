import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const checkout = readFileSync(new URL("../handlers/payments/mpesa/stk-push.js", import.meta.url), "utf8");
const callback = readFileSync(new URL("../handlers/payments/mpesa/callback.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/202611260006_payment_schema_compatibility.sql", import.meta.url), "utf8");
const catalogueMigration = readFileSync(new URL("../supabase/migrations/202611260013_real_trading_subscription_catalogue.sql", import.meta.url), "utf8");
const entitlementMigration = readFileSync(new URL("../supabase/migrations/202611260011_atomic_subscription_entitlements.sql", import.meta.url), "utf8");

test("M-Pesa checkout writes both legacy-required and current KES amount fields", () => {
  assert.match(checkout, /service_code:\s*service\.service_code,\s*amount,\s*amount_kes:\s*amount/);
  assert.match(checkout, /currency:\s*"KES",\s*payment_method:\s*"MPESA"/);
  assert.match(checkout, /checkout_request_id:\s*stkResult\.CheckoutRequestID,\s*provider_checkout_id:\s*stkResult\.CheckoutRequestID/);
});

test("verified M-Pesa callback mirrors legacy aliases and invokes atomic subscription fulfilment", () => {
  assert.match(callback, /provider_reference:\s*receipt,\s*provider_receipt:\s*receipt/);
  assert.match(callback, /confirmed_at:\s*confirmedAt,\s*paid_at:\s*confirmedAt/);
  assert.match(callback, /admin\.rpc\(\s*"fulfill_paid_subscription_order"/);
  assert.match(entitlementMigration, /amount, currency, starts_at, ends_at, payment_order_id/);
  assert.match(entitlementMigration, /amount = excluded\.amount/);
  assert.match(entitlementMigration, /currency = excluded\.currency/);
  assert.match(callback, /amount_usd,\s*amount_kes/);
});

test("payment compatibility migration is additive and does not invent service prices", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS service_code text/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS amount_kes numeric/);
  assert.match(migration, /UPDATE public\.service_catalog[\s\S]*upper\(currency\) = 'KES'/);
  assert.match(migration, /UPDATE public\.payment_orders[\s\S]*provider_checkout_id/);
  assert.match(migration, /UPDATE public\.payment_orders[\s\S]*provider_receipt/);
  assert.doesNotMatch(migration, /INSERT INTO public\.service_catalog/i);
  assert.doesNotMatch(migration, /\b(DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM)\b/i);
});

test("service code uniqueness supports downstream entitlement foreign keys", () => {
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS service_catalog_service_code_uidx\s+ON public\.service_catalog\(service_code\);/);
  assert.doesNotMatch(migration, /service_catalog_service_code_uidx[\s\S]*?WHERE service_code IS NOT NULL/);
});


test("approved REAL subscription catalogue publishes USD 75 first month and USD 175 renewals", () => {
  assert.match(catalogueMigration, /'REAL_TRADING'/);
  assert.match(catalogueMigration, /75\.00/);
  assert.match(catalogueMigration, /175\.00/);
  assert.match(catalogueMigration, /Payment alone does not unlock broker execution/);
});
