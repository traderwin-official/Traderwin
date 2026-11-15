import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyFlutterwaveWebhookSignature,
  validateFlutterwavePayment,
  verifyFlutterwaveTransaction
} from "../lib/flutterwave.js";

test("Flutterwave webhook signature comparison is exact and timing-safe", () => {
  assert.equal(verifyFlutterwaveWebhookSignature("secret-hash", "secret-hash"), true);
  assert.equal(verifyFlutterwaveWebhookSignature("wrong-hash", "secret-hash"), false);
  assert.equal(verifyFlutterwaveWebhookSignature("", "secret-hash"), false);
  assert.equal(verifyFlutterwaveWebhookSignature("secret-hash", ""), false);
});

test("only a successful exact KES payment for the generated tx_ref is accepted", () => {
  const order = { amount_kes: 2500, flutterwave_tx_ref: "TW-FLW-123" };
  assert.equal(validateFlutterwavePayment({
    status: "successful", tx_ref: "TW-FLW-123", currency: "KES", amount: 2500
  }, order), true);
  assert.equal(validateFlutterwavePayment({
    status: "successful", tx_ref: "OTHER", currency: "KES", amount: 2500
  }, order), false);
  assert.equal(validateFlutterwavePayment({
    status: "successful", tx_ref: "TW-FLW-123", currency: "USD", amount: 2500
  }, order), false);
  assert.equal(validateFlutterwavePayment({
    status: "successful", tx_ref: "TW-FLW-123", currency: "KES", amount: 2499
  }, order), false);
  assert.equal(validateFlutterwavePayment({
    status: "successful", tx_ref: "TW-FLW-123", currency: "KES", amount: 2501
  }, order), false);
  assert.equal(validateFlutterwavePayment({
    status: "failed", tx_ref: "TW-FLW-123", currency: "KES", amount: 2500
  }, order), false);
});

test("transaction verification calls Flutterwave with server-side bearer authorization", async () => {
  let request;
  const data = { id: 987, status: "successful" };
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ status: "success", data }) };
  };
  const result = await verifyFlutterwaveTransaction("987", "test-secret", fetchImpl);
  assert.deepEqual(result, data);
  assert.match(request.url, /transactions\/987\/verify$/);
  assert.equal(request.options.headers.Authorization, "Bearer test-secret");
});

test("transaction verification rejects invalid IDs and failed API responses", async () => {
  await assert.rejects(() => verifyFlutterwaveTransaction("not-an-id", "secret"), /Invalid/);
  await assert.rejects(() => verifyFlutterwaveTransaction("123", "", async () => {
    throw new Error("must not be called");
  }), /not configured/);
  await assert.rejects(() => verifyFlutterwaveTransaction("123", "secret", async () => ({
    ok: false, json: async () => ({ status: "error" })
  })), /verification failed/);
});
