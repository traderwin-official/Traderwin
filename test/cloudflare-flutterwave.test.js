import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost as createFlutterwaveCheckout } from "../functions/api/payments/flutterwave/create.js";
import {
  onRequestPost as flutterwaveWebhook,
  onRequestGet as flutterwaveReturn
} from "../functions/api/payments/flutterwave/complete.js";

test("Pages checkout rejects an unconfigured payment service without touching Supabase", async () => {
  const response = await createFlutterwaveCheckout({
    request: new Request("https://example.pages.dev/api/payments/flutterwave/create", { method: "POST" }),
    env: {}
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/i);
});

test("Pages checkout requires a bearer session before creating an order", async () => {
  const response = await createFlutterwaveCheckout({
    request: new Request("https://example.pages.dev/api/payments/flutterwave/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceCode: "MEMBERSHIP" })
    }),
    env: {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-only-placeholder",
      FLW_SECRET_KEY: "test-only-placeholder",
      FLW_REDIRECT_URL: "https://example.pages.dev/api/payments/flutterwave/complete"
    }
  });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /sign in/i);
});

test("Pages webhook rejects invalid signatures before reading payment configuration", async () => {
  const response = await flutterwaveWebhook({
    request: new Request("https://example.pages.dev/api/payments/flutterwave/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "verif-hash": "wrong" },
      body: JSON.stringify({ event: "charge.completed", data: { tx_ref: "TS-FLW-x", id: 123 } })
    }),
    env: { FLW_SECRET_HASH: "expected" }
  });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /signature/i);
});

test("Pages payment return rejects missing transaction references", async () => {
  const response = await flutterwaveReturn({
    request: new Request("https://example.pages.dev/api/payments/flutterwave/complete"),
    env: {}
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /reference/i);
});

test("Pages payment return reports missing server configuration without exposing secrets", async () => {
  const response = await flutterwaveReturn({
    request: new Request("https://example.pages.dev/api/payments/flutterwave/complete?tx_ref=TS-FLW-x&transaction_id=123"),
    env: {}
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/i);
});
