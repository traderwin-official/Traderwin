import test from "node:test";
import assert from "node:assert/strict";
import { validateDemoMarketSnapshot } from "../lib/demo/market-snapshot-validator.js";

const now = 1_800_000_000;
const base = {
  snapshot: {
    provider:"DERIV_SERVER_ADAPTER",
    instrument:"frxXAUUSD",
    dataStatus:"LIVE",
    timestampEpoch:now - 3,
    bid:2000,
    ask:2000.2
  },
  expectedInstrument:"frxXAUUSD",
  instrumentActive:true,
  nowEpoch:now
};

test("accepts a fresh server-adapter snapshot with a narrow spread", () => {
  const result = validateDemoMarketSnapshot(base);
  assert.equal(result.valid, true);
  assert.equal(result.status, "VALIDATED_DEMO_MARKET_SNAPSHOT");
  assert.equal(result.paperOnly, true);
  assert.equal(result.ageSeconds, 3);
});

for (const [name, patch, reason] of [
  ["unverified provider", { snapshot:{...base.snapshot,provider:"BROWSER_CLIENT"} }, "UNTRUSTED_PROVIDER"],
  ["inactive instrument", { instrumentActive:false }, "INSTRUMENT_NOT_ACTIVE"],
  ["wrong symbol", { snapshot:{...base.snapshot,instrument:"frxEURUSD"} }, "INSTRUMENT_MISMATCH"],
  ["delayed feed", { snapshot:{...base.snapshot,dataStatus:"DELAYED"} }, "LIVE_DATA_REQUIRED"],
  ["stale quote", { snapshot:{...base.snapshot,timestampEpoch:now-60} }, "MARKET_DATA_STALE"],
  ["future quote", { snapshot:{...base.snapshot,timestampEpoch:now+10} }, "MARKET_TIMESTAMP_FROM_FUTURE"],
  ["crossed market", { snapshot:{...base.snapshot,bid:2001,ask:2000} }, "INVALID_BID_ASK"],
  ["zero price", { snapshot:{...base.snapshot,bid:0} }, "INVALID_BID_ASK"],
  ["wide spread", { snapshot:{...base.snapshot,bid:1990,ask:2010} }, "SPREAD_TOO_WIDE"]
]) {
  test("blocks " + name, () => {
    const result = validateDemoMarketSnapshot({ ...base, ...patch });
    assert.equal(result.valid, false);
    assert.equal(result.reason, reason);
  });
}

test("rejects invalid freshness configuration", () => {
  const result = validateDemoMarketSnapshot({ ...base, maxAgeSeconds:0 });
  assert.equal(result.reason, "INVALID_VALIDATION_INPUT");
});
