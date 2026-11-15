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

test("unified callback activates paid service and extends early monthly renewals atomically", async () => {
  const source = await readFile(new URL("../api/payments/mpesa/bot-shop-callback.js", import.meta.url), "utf8");
  const sql = await readFile(new URL("../supabase/migrations/202611130022_unified_mpesa_services.sql", import.meta.url), "utf8");
  assert.match(source, /fulfill_traderwin_service_payment/);
  assert.ok(sql.includes("existing_end + case"));
  assert.match(sql, /next_end/);
  assert.ok(sql.includes("on conflict(user_id,service_code) do update"));
});
