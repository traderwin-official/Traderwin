import test from "node:test";
import assert from "node:assert/strict";
import { enforceRateLimit } from "../lib/cloudflare-mpesa.js";
import { onRequestPost as memberStkPush } from "../functions/api/payments/mpesa/stk-push.js";
import { onRequestGet as memberPaymentStatus } from "../functions/api/payments/mpesa/status.js";
import { onRequestPost as mpesaCallback } from "../functions/api/payments/mpesa/bot-shop-callback.js";
import { onRequestPost as callbackAlias } from "../functions/api/payments/mpesa/callback.js";
import { onRequestGet as botShopCatalog, onRequestPost as botShopCheckout } from "../functions/api/bot-shop.js";
import { onRequestGet as botShopStatus } from "../functions/api/bot-shop-status.js";
import { MpesaRateLimiter } from "../workers/mpesa-rate-limiter/index.js";

const req = (url, method = "GET", headers = {}, body = undefined) =>
  new Request(url, { method, headers, body });

test("member M-Pesa checkout fails closed until server configuration is present", async () => {
  const response = await memberStkPush({
    request: req("https://example.test/api/payments/mpesa/stk-push", "POST", {}, "{}"),
    env: {}
  });
  assert.equal(response.status, 503);
});

test("member payment status validates the order reference before database access", async () => {
  const response = await memberPaymentStatus({
    request: req("https://example.test/api/payments/mpesa/status?orderId=bad"),
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-only" }
  });
  assert.equal(response.status, 400);
});

test("unified Daraja callback fails closed when credentials are absent", async () => {
  const response = await mpesaCallback({
    request: req("https://example.test/api/payments/mpesa/bot-shop-callback", "POST", {}, "{}"),
    env: {}
  });
  assert.equal(response.status, 503);
});

test("legacy callback route re-exports the unified Pages handler", () => {
  assert.equal(callbackAlias, mpesaCallback);
});

test("bot shop catalog fails closed when Supabase is not configured", async () => {
  const response = await botShopCatalog({ request: req("https://example.test/api/bot-shop"), env: {} });
  assert.equal(response.status, 503);
});

test("bot shop checkout fails closed until payment and encryption settings exist", async () => {
  const response = await botShopCheckout({
    request: req("https://example.test/api/bot-shop", "POST", {}, "{}"),
    env: {}
  });
  assert.equal(response.status, 503);
});

test("bot shop status rejects malformed order references", async () => {
  const response = await botShopStatus({
    request: req("https://example.test/api/bot-shop-status?orderId=nope"),
    env: {}
  });
  assert.equal(response.status, 400);
});

test("rate limiting is mandatory and fails closed when the service binding is absent", async () => {
  const result = await enforceRateLimit({
    env: {}, request: req("https://example.test"), scope: "test", key: "user-1", limit: 3
  });
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 503);
});

test("rate limiting returns 429 when the bound service denies a request", async () => {
  const env = {
    MPESA_RATE_LIMITER_TOKEN: "test-token",
    MPESA_RATE_LIMITER: {
      fetch: async () => Response.json({ allowed: false, retryAfterSeconds: 17 })
    }
  };
  const result = await enforceRateLimit({
    env, request: req("https://example.test"), scope: "test", key: "user-1", limit: 3
  });
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 429);
  assert.equal(result.response.headers.get("Retry-After"), "17");
});

test("rate limiter durable object enforces a fixed window and resets after the window", async () => {
  const store = new Map();
  const ctx = { storage: { kv: {
    get: (key) => store.get(key),
    put: (key, value) => store.set(key, value)
  } } };
  const limiter = new MpesaRateLimiter(ctx);
  const call = (now) => limiter.fetch(new Request("https://rate-limit.internal/counter", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 2, windowSeconds: 60, now })
  }));

  assert.equal((await (await call(1000000)).json()).allowed, true);
  assert.equal((await (await call(1000001)).json()).allowed, true);
  const denied = await call(1000002);
  assert.equal((await denied.json()).allowed, false);
  assert.equal((await (await call(1060000)).json()).allowed, true);
});
