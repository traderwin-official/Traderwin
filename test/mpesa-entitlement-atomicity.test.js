import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("subscription entitlement ledger permanently deduplicates every payment order", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611260011_atomic_subscription_entitlements.sql", import.meta.url), "utf8");
  assert.match(sql, /subscription_entitlement_events/);
  assert.match(sql, /payment_order_id uuid primary key/);
  assert.match(sql, /on conflict \(payment_order_id\) do nothing/);
  assert.match(sql, /ALREADY_APPLIED/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /on conflict \(user_id, service_code\) do update/);
  assert.match(sql, /auth\.role\(\) is distinct from 'service_role'/);
  assert.match(sql, /revoke all on function public\.fulfill_paid_subscription_order\(uuid\)/);
  assert.match(sql, /grant execute on function public\.fulfill_paid_subscription_order\(uuid\) to service_role/);
});

test("M-Pesa callback delegates subscription fulfilment to one atomic database transaction", async () => {
  const source = await readFile(new URL("../handlers/payments/mpesa/callback.js", import.meta.url), "utf8");
  assert.match(source, /admin\\.rpc\\(\\s*"fulfill_paid_subscription_order",\s*\{\s*p_order_id:\s*paidOrder\.id\s*\}\)/);
  assert.match(source, /Payment entitlement activation failed/);
  assert.doesNotMatch(source, /from\("user_subscriptions"\)\.upsert/);
  assert.doesNotMatch(source, /existingSubscription\?\.payment_order_id/);
});
