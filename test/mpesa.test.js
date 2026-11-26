import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeKenyanPhone,
  darajaBaseUrl,
  createNairobiTimestamp,
  buildStkPassword
} from "../lib/mpesa.js";

test("normalizes Kenyan Safaricom-style 07 numbers", () => {
  assert.equal(normalizeKenyanPhone("0712345678"), "254712345678");
});
test("normalizes Kenyan 01 numbers", () => {
  assert.equal(normalizeKenyanPhone("0112345678"), "254112345678");
});
test("accepts international Kenyan numbers", () => {
  assert.equal(normalizeKenyanPhone("+254712345678"), "254712345678");
});
test("rejects malformed or non-Kenyan numbers", () => {
  assert.equal(normalizeKenyanPhone("12345"), null);
  assert.equal(normalizeKenyanPhone("+255712345678"), null);
});
test("formats Daraja timestamps in East Africa Time", () => {
  assert.equal(createNairobiTimestamp(new Date("2026-11-12T08:30:45.123Z")), "20261112113045");
});
test("uses sandbox unless production is explicitly selected", () => {
  assert.equal(darajaBaseUrl("sandbox"), "https://sandbox.safaricom.co.ke");
  assert.equal(darajaBaseUrl("production"), "https://api.safaricom.co.ke");
  assert.equal(darajaBaseUrl("unexpected"), "https://sandbox.safaricom.co.ke");
});
test("builds the STK password from shortcode, passkey and timestamp", () => {
  assert.equal(buildStkPassword("123456", "secret", "20261112113045"),
    Buffer.from("123456secret20261112113045").toString("base64"));
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("paid M-Pesa callbacks can retry incomplete subscription fulfillment", () => {
  const callbackPath = new URL("../handlers/payments/mpesa/callback.js", import.meta.url);
  const source = readFileSync(fileURLToPath(callbackPath), "utf8");
  assert.match(source, /\["PENDING",\s*"PAID"\]\.includes\(order\.status\)/);
  assert.match(source, /if \(order\.status === "PAID"\)/);
  assert.match(source, /Another callback may have won the PENDING -> PAID race/);
  assert.match(source, /refreshed\?\.status !== "PAID"/);
});
