import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("REAL subscription migration stores the agreed first and renewal prices", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611120014_usd_subscription_pricing.sql", import.meta.url), "utf8");
  assert.match(sql, /'REAL_TRADING'/);
  assert.match(sql, /75\.00, 175\.00/);
  assert.match(sql, /amount_usd/);
  assert.match(sql, /fx_rate_kes/);
  assert.match(sql, /payment_orders_one_pending_service_per_user/);
});

test("M-Pesa checkout calculates KES server-side from the service catalogue and paid history", async () => {
  const source = await readFile(new URL("../handlers/payments/mpesa/stk-push.js", import.meta.url), "utf8");
  assert.match(source, /fetchUsdKesRate/);
  assert.match(source, /buildCheckoutPrice/);
  assert.match(source, /\.eq\("status", "PAID"\)/);
  assert.match(source, /amount_kes: amount/);
  assert.match(source, /fx_rate_kes: pricing\.fxRateKes/);
  assert.doesNotMatch(source, /body\.amount|body\.price/);
});

test("subscription status never treats payment as live-trading authorization", async () => {
  const source = await readFile(new URL("../handlers/subscriptions/status.js", import.meta.url), "utf8");
  assert.match(source, /realExecutionAuthorized: false/);
  assert.match(source, /renewalMode: "MANUAL"/);
  assert.match(source, /evaluateSubscriptionWindow/);
  assert.match(source, /startsAt: data\?\.starts_at/);
  assert.match(source, /endsAt: data\?\.ends_at/);
  assert.match(source, /message: entitlement\.active/);
  assert.doesNotMatch(source, /message: active/);
});

test("subscription renewals are applied atomically from the paid-order ledger", async () => {
  const source = await readFile(new URL("../handlers/payments/mpesa/callback.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/202611260011_atomic_subscription_entitlements.sql", import.meta.url), "utf8");
  assert.match(source, /fulfill_paid_subscription_order/);
  assert.match(migration, /v_subscription\.ends_at > v_now/);
  assert.match(migration, /v_ends_at := v_starts_at \+ interval '1 month'/);
  assert.match(migration, /on conflict \(payment_order_id\) do nothing/);
});
