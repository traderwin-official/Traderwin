import test from "node:test";
import assert from "node:assert/strict";
import { monitorPortfolio } from "../lib/portfolio-monitor.js";

const scope = { userId: "u1", accountMode: "DEMO", broker: "DERIV", accountRef: "d1" };
const positions = [
  { id: "p1", userId: "u1", accountMode: "DEMO", broker: "DERIV", accountRef: "d1", source: "BOT", status: "OPEN", profitUsd: 60 },
  { id: "p2", userId: "u1", accountMode: "DEMO", broker: "DERIV", accountRef: "d1", source: "BOT", status: "OPEN", profitUsd: 20 }
];
function adapters(overrides = {}) {
  const calls = { saved: [], closed: [] };
  return {
    calls,
    loadSnapshot: async () => ({ positions: positions.map((p, i) => ({ ...p, profitUsd: i === 0 ? 60 : 21 })), source: "verified-test-feed", asOf: new Date(1_000_000).toISOString(), maxAgeMs: 10_000 }),
    loadState: async () => ({ peakProfitUsd: 100, includedPositionIds: ["p1", "p2"], membershipVersion: 4 }),
    loadPermissions: async () => ({ manageManualTrades: false, closeManagedPositions: true }),
    saveState: async (_scope, state, expected) => { calls.saved.push({ state, expected }); return { saved: true }; },
    closePosition: async (position, request) => { calls.closed.push({ id: position.id, request }); return { closed: true }; },
    ...overrides
  };
}

test("fresh DEMO snapshot calculates and persists portfolio state without closing above floor", async () => {
  const a = adapters();
  const result = await monitorPortfolio(scope, a, { now: 1_005_000 });
  assert.equal(result.status, "MONITORED");
  assert.equal(result.calculation.currentProfitUsd, 81);
  assert.equal(result.calculation.protectedFloorUsd, 80);
  assert.equal(a.calls.saved.length, 1);
  assert.equal(a.calls.closed.length, 0);
});

test("stale data fails closed before persistence or close", async () => {
  const a = adapters({ loadSnapshot: async () => ({ positions, source: "feed", asOf: new Date(1).toISOString(), maxAgeMs: 100 }) });
  const result = await monitorPortfolio(scope, a, { now: 1_000_000 });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "STALE_MARKET_DATA");
  assert.equal(a.calls.saved.length, 0);
});

test("position scope mismatch blocks portfolio processing", async () => {
  const a = adapters({ loadSnapshot: async () => ({ positions: [...positions, { ...positions[0], id: "other", accountRef: "d2" }], source: "feed", asOf: new Date(1_000_000).toISOString(), maxAgeMs: 10000 }) });
  const result = await monitorPortfolio(scope, a, { now: 1_000_001 });
  assert.equal(result.reason, "POSITION_SCOPE_MISMATCH");
});

test("optimistic persistence conflict requests retry and never closes", async () => {
  const a = adapters({ saveState: async () => ({ saved: false }) });
  const result = await monitorPortfolio(scope, a, { now: 1_005_000 });
  assert.equal(result.status, "RETRY");
  assert.equal(a.calls.closed.length, 0);
});

test("manual close permission is required before any close operation", async () => {
  const a = adapters({
    loadSnapshot: async () => ({ positions: positions.map(p => ({ ...p, profitUsd: 30 })), source: "feed", asOf: new Date(1_000_000).toISOString(), maxAgeMs: 10000 }),
    loadState: async () => ({ peakProfitUsd: 100, includedPositionIds: ["p1", "p2"], membershipVersion: 4 }),
    loadPermissions: async () => ({ manageManualTrades: false, closeManagedPositions: false })
  });
  const result = await monitorPortfolio(scope, a, { now: 1_005_000 });
  assert.equal(result.status, "CLOSE_BLOCKED");
  assert.equal(result.reason, "CLOSE_PERMISSION_NOT_GRANTED");
  assert.equal(a.calls.closed.length, 0);
});

test("REAL positions require separate real-execution authorization", async () => {
  const realScope = { ...scope, accountMode: "REAL" };
  const realPositions = positions.map(p => ({ ...p, accountMode: "REAL", profitUsd: 30 }));
  const a = adapters({
    loadSnapshot: async () => ({ positions: realPositions, source: "feed", asOf: new Date(1_000_000).toISOString(), maxAgeMs: 10000 }),
    loadState: async () => ({ peakProfitUsd: 100, includedPositionIds: ["p1", "p2"], membershipVersion: 4 }),
    isRealExecutionAuthorized: async () => false
  });
  const result = await monitorPortfolio(realScope, a, { now: 1_005_000 });
  assert.equal(result.status, "CLOSE_BLOCKED");
  assert.equal(result.reason, "REAL_EXECUTION_NOT_AUTHORIZED");
  assert.equal(a.calls.closed.length, 0);
});

test("partial broker close failures are reported per position", async () => {
  const a = adapters({
    loadSnapshot: async () => ({ positions: positions.map(p => ({ ...p, profitUsd: 30 })), source: "feed", asOf: new Date(1_000_000).toISOString(), maxAgeMs: 10000 }),
    loadState: async () => ({ peakProfitUsd: 100, includedPositionIds: ["p1", "p2"], membershipVersion: 4 }),
    closePosition: async p => ({ closed: p.id === "p1" })
  });
  const result = await monitorPortfolio(scope, a, { now: 1_005_000 });
  assert.equal(result.status, "PARTIAL_CLOSE");
  assert.deepEqual(result.retryPositionIds, ["p2"]);
});

test("REAL execution gate is checked only after a valid trailing trigger", async () => {
  const realScope = { ...scope, accountMode: "REAL" };
  const realPositions = positions.map(p => ({ ...p, accountMode: "REAL", profitUsd: 30 }));
  const a = adapters({
    loadSnapshot: async () => ({ positions: realPositions, source: "feed", asOf: new Date(1_000_000).toISOString(), maxAgeMs: 10000 }),
    loadState: async () => ({ peakProfitUsd: 100, includedPositionIds: ["p1", "p2"], membershipVersion: 4 }),
    isRealExecutionAuthorized: async () => true
  });
  const result = await monitorPortfolio(realScope, a, { now: 1_005_000 });
  assert.equal(result.status, "CLOSE_REQUESTED");
  assert.equal(a.calls.closed.length, 2);
});
