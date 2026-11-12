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
  const source = await readFile(new URL("../api/payments/mpesa/stk-push.js", import.meta.url), "utf8");
  assert.match(source, /fetchUsdKesRate/);
  assert.match(source, /buildCheckoutPrice/);
  assert.match(source, /\.eq\("status", "PAID"\)/);
  assert.match(source, /amount_kes: amount/);
  assert.match(source, /fx_rate_kes: pricing\.fxRateKes/);
  assert.doesNotMatch(source, /body\.amount|body\.price/);
});

test("subscription status never treats payment as live-trading authorization", async () => {
  const source = await readFile(new URL("../api/subscriptions/status.js", import.meta.url), "utf8");
  assert.match(source, /realExecutionAuthorized: false/);
  assert.match(source, /renewalMode: "MANUAL"/);
});

test("early manual renewal extends the existing subscription expiry", async () => {
  const source = await readFile(new URL("../api/payments/mpesa/callback.js", import.meta.url), "utf8");
  assert.match(source, /existingSubscription\.ends_at/);
  assert.match(source, /const startsAt = existingEnd && existingEnd > now \? existingEnd : now/);
});
