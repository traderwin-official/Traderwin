import test from "node:test";
import assert from "node:assert/strict";
import { buildCheckoutPrice, fetchUsdKesRate } from "../lib/service-pricing.js";

const service = {
  service_code: "REAL_TRADING",
  active: true,
  price_usd: 75,
  renewal_price_usd: 175,
  price_kes: 0
};

test("REAL subscription first purchase is USD 75 converted to KES and rounded up", () => {
  const quote = buildCheckoutPrice({
    service, priorPaidCount: 0,
    fx: { rate: 130.123, source: "test", asOf: "2026-11-12T00:00:00.000Z" }
  });
  assert.equal(quote.amountUsd, 75);
  assert.equal(quote.amountKes, Math.ceil(75 * 130.123));
  assert.equal(quote.priceBasis, "FIRST_MONTH");
});

test("REAL subscription after a prior paid month uses USD 175 renewal price", () => {
  const quote = buildCheckoutPrice({
    service, priorPaidCount: 1,
    fx: { rate: 130, source: "test", asOf: "2026-11-12T00:00:00.000Z" }
  });
  assert.equal(quote.amountUsd, 175);
  assert.equal(quote.amountKes, 22750);
  assert.equal(quote.priceBasis, "RENEWAL");
});

test("fixed-KES services do not need foreign-exchange conversion", () => {
  const quote = buildCheckoutPrice({
    service: { service_code: "COURSE", active: true, price_kes: 2500 },
  });
  assert.equal(quote.amountKes, 2500);
  assert.equal(quote.amountUsd, null);
  assert.equal(quote.priceBasis, "FIXED_KES");
});

test("USD/KES quote rejects stale exchange-rate data", async () => {
  const now = 1_800_000_000_000;
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      result: "success",
      time_last_update_unix: Math.floor((now - 72 * 60 * 60 * 1000) / 1000),
      rates: { KES: 130 }
    })
  });
  await assert.rejects(fetchUsdKesRate(fetchImpl, () => now), /fresh USD\/KES/);
});

test("USD/KES quote accepts a fresh valid exchange rate", async () => {
  const now = 1_800_000_000_000;
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      result: "success",
      time_last_update_unix: Math.floor(now / 1000),
      rates: { KES: 130.5 }
    })
  });
  const fx = await fetchUsdKesRate(fetchImpl, () => now);
  assert.equal(fx.rate, 130.5);
  assert.equal(fx.source, "open.er-api.com");
});


test("standalone TIGER SCHEME lifetime bot converts USD 350 to a fixed KES checkout snapshot", () => {
  const bot = {
    product_code: "MT5_GOLD_LIFETIME",
    active: true,
    price_usd: 350,
    price_kes: null
  };
  const quote = buildCheckoutPrice({
    service: bot,
    priorPaidCount: 0,
    fx: { rate: 130.25, source: "test", asOf: "2026-11-13T00:00:00.000Z" }
  });
  assert.equal(quote.amountUsd, 350);
  assert.equal(quote.amountKes, Math.ceil(350 * 130.25));
  assert.equal(quote.priceBasis, "FIRST_MONTH");
});
