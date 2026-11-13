import test from "node:test";
import assert from "node:assert/strict";
import { buildTakeProfitPlan, evaluateTakeProfitStage, executeTakeProfitStage } from "../lib/take-profit-manager.js";

const now = 1_800_000_000_000;
const position = {
  id: "position-1", userId: "user-1", accountMode: "DEMO", broker: "DERIV", accountRef: "demo-1",
  direction: "BUY", entryPrice: 100, initialUnits: 1, remainingUnits: 1,
  minUnits: 0.01, volumeStep: 0.01,
  targets: { tp1: 101, tp2: 102, tp3: 103 }
};
const quote = price => ({ price, source: "verified-feed", asOf: new Date(now - 500).toISOString(), maxAgeMs: 5000 });

test("builds 1R, 2R and 3R BUY targets from the stop distance", () => {
  assert.deepEqual(buildTakeProfitPlan({ direction: "BUY", entry: 100, stopLoss: 99 }).targets,
    { tp1: 101, tp2: 102, tp3: 103 });
});
test("builds correctly ordered SELL targets", () => {
  assert.deepEqual(buildTakeProfitPlan({ direction: "SELL", entry: 100, stopLoss: 101 }).targets,
    { tp1: 99, tp2: 98, tp3: 97 });
});
test("rejects invalid stop placement and non-positive SELL targets", () => {
  assert.throws(() => buildTakeProfitPlan({ direction: "BUY", entry: 100, stopLoss: 101 }));
  assert.throws(() => buildTakeProfitPlan({ direction: "SELL", entry: 1, stopLoss: 2 }));
});
test("TP1 closes 40 percent, TP2 closes 30 percent, TP3 closes all remaining", () => {
  const tp1 = evaluateTakeProfitStage({ position, quote: quote(101), now });
  assert.equal(tp1.stage, "TP1"); assert.equal(tp1.requestedUnits, 0.4);
  const after1 = { ...position, remainingUnits: 0.6 };
  const tp2 = evaluateTakeProfitStage({ position: after1, quote: quote(102), progress: { tp1: true }, now });
  assert.equal(tp2.stage, "TP2"); assert.equal(tp2.requestedUnits, 0.3);
  const after2 = { ...position, remainingUnits: 0.3 };
  const tp3 = evaluateTakeProfitStage({ position: after2, quote: quote(103), progress: { tp1: true, tp2: true }, now });
  assert.equal(tp3.stage, "TP3"); assert.equal(tp3.requestedUnits, 0.3); assert.equal(tp3.final, true);
});
test("processes only one target stage per broker-confirmed call", () => {
  const result = evaluateTakeProfitStage({ position, quote: quote(105), now });
  assert.equal(result.stage, "TP1");
});
test("supports SELL target hits", () => {
  const sell = { ...position, direction: "SELL", targets: { tp1: 99, tp2: 98, tp3: 97 } };
  assert.equal(evaluateTakeProfitStage({ position: sell, quote: quote(98.9), now }).stage, "TP1");
});
test("blocks stale, future and invalid quote data", () => {
  assert.equal(evaluateTakeProfitStage({ position, quote: { ...quote(101), asOf: new Date(now - 10000).toISOString() }, now }).reason, "STALE_QUOTE");
  assert.equal(evaluateTakeProfitStage({ position, quote: { ...quote(101), asOf: new Date(now + 1000).toISOString() }, now }).reason, "STALE_QUOTE");
  assert.equal(evaluateTakeProfitStage({ position, quote: null, now }).reason, "INVALID_QUOTE");
});
test("skips a fractional stage below broker minimum without sending a close", () => {
  const small = { ...position, initialUnits: 0.01, remainingUnits: 0.01 };
  assert.equal(evaluateTakeProfitStage({ position: small, quote: quote(101), now }).action, "SKIP_STAGE");
});
test("REAL mode requires separate live authorization", async () => {
  const real = { ...position, accountMode: "REAL", broker: "MT5", accountRef: "live-1" };
  const adapters = { closePosition: async () => { throw new Error("must not execute"); }, saveProgress: async () => ({ saved: true }) };
  const result = await executeTakeProfitStage({ scope: { userId: real.userId, accountMode: "REAL", broker: "MT5", accountRef: "live-1" }, position: real, quote: quote(101), progress: {}, adapters, now });
  assert.equal(result.reason, "REAL_EXECUTION_NOT_AUTHORIZED");
});
test("broker close must confirm exact volume before stage progress is saved", async () => {
  let saves = 0;
  const adapters = { closePosition: async () => ({ closed: true, executedUnits: 0.2 }), saveProgress: async () => { saves++; return { saved: true }; } };
  const result = await executeTakeProfitStage({ scope: { userId: position.userId, accountMode: "DEMO", broker: "DERIV", accountRef: "demo-1" }, position, quote: quote(101), progress: {}, adapters, now });
  assert.equal(result.reason, "BROKER_CLOSE_NOT_CONFIRMED"); assert.equal(saves, 0);
});
test("uses idempotency and persists progress only after confirmed partial close", async () => {
  let request, saved;
  const adapters = {
    closePosition: async (_position, args) => { request = args; return { closed: true, executedUnits: 0.4, fillPrice: 101.02, closedAt: new Date(now).toISOString() }; },
    saveProgress: async (_scope, id, state) => { saved = { id, state }; return { saved: true }; }
  };
  const result = await executeTakeProfitStage({ scope: { userId: position.userId, accountMode: "DEMO", broker: "DERIV", accountRef: "demo-1" }, position, quote: quote(101), progress: {}, adapters, now });
  assert.equal(result.status, "PARTIAL_CLOSED");
  assert.equal(request.volume, 0.4);
  assert.match(request.idempotencyKey, /tp1$/);
  assert.equal(saved.state.tp1, true);
});
test("a scope mismatch never reaches broker adapter", async () => {
  let called = false;
  const adapters = { closePosition: async () => { called = true; }, saveProgress: async () => ({ saved: true }) };
  const result = await executeTakeProfitStage({ scope: { userId: "other", accountMode: "DEMO", broker: "DERIV", accountRef: "demo-1" }, position, quote: quote(101), progress: {}, adapters, now });
  assert.equal(result.reason, "ACCOUNT_SCOPE_MISMATCH"); assert.equal(called, false);
});
