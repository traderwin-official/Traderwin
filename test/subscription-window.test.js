import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSubscriptionWindow } from "../lib/subscription-window.js";

const now = Date.parse("2026-11-20T12:00:00.000Z");

test("active subscription requires a valid start and end window", () => {
  assert.deepEqual(evaluateSubscriptionWindow({
    status: "ACTIVE",
    startsAt: "2026-11-20T11:00:00.000Z",
    endsAt: "2026-12-20T11:00:00.000Z",
    now
  }), { active: true, status: "ACTIVE" });
});

test("future subscription is not active before its start", () => {
  assert.equal(evaluateSubscriptionWindow({
    status: "ACTIVE",
    startsAt: "2026-11-20T13:00:00.000Z",
    endsAt: "2026-12-20T13:00:00.000Z",
    now
  }).status, "NOT_YET_ACTIVE");
});

test("expired, missing, malformed or inverted date windows fail closed", () => {
  assert.equal(evaluateSubscriptionWindow({
    status: "ACTIVE",
    startsAt: "2026-10-01T00:00:00.000Z",
    endsAt: "2026-11-20T11:59:59.000Z",
    now
  }).status, "EXPIRED");
  assert.equal(evaluateSubscriptionWindow({ status: "ACTIVE", startsAt: null, endsAt: "2026-12-20T00:00:00.000Z", now }).active, false);
  assert.equal(evaluateSubscriptionWindow({ status: "ACTIVE", startsAt: "bad", endsAt: "2026-12-20T00:00:00.000Z", now }).status, "INVALID_SUBSCRIPTION_DATES");
  assert.equal(evaluateSubscriptionWindow({ status: "ACTIVE", startsAt: "2026-12-20T00:00:00.000Z", endsAt: "2026-11-20T00:00:00.000Z", now }).status, "INVALID_SUBSCRIPTION_DATES");
});

test("non-active payment/subscription states never become active", () => {
  for (const status of ["PENDING", "PAST_DUE", "CANCELLED", "REVOKED", null]) {
    assert.equal(evaluateSubscriptionWindow({ status, startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2027-01-01T00:00:00.000Z", now }).active, false);
  }
});
