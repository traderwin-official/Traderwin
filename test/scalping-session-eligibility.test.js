import test from "node:test";
import assert from "node:assert/strict";
import {scalpingSessionPermissions} from "../lib/scalping-session-eligibility.js";

const session = (overrides = {}) => ({
  broker: "DERIV",
  instrument: "XAUUSD",
  status: "RUNNING",
  config_snapshot: {account_mode: "DEMO"},
  ...overrides
});
const preference = (overrides = {}) => ({
  enabled: true,
  paper_execution_enabled: true,
  account_mode: "DEMO",
  execution: "WEBSITE_PAPER_ONLY",
  ...overrides
});
const profile = (account_mode = "DEMO") => ({account_mode});

test("only fully opted-in DEMO sessions can open new scalping paper positions", () => {
  assert.deepEqual(
    scalpingSessionPermissions({session: session(), preference: preference(), profile: profile(), brokerConnectionVerified: true}),
    {entryEnabled: true, manageOpen: false, include: true}
  );
  for (const prefs of [
    preference({enabled: false}),
    preference({paper_execution_enabled: false}),
    preference({account_mode: "REAL"}),
    preference({execution: "MONITOR_ONLY"})
  ]) {
    const result = scalpingSessionPermissions({session: session(), preference: prefs, profile: profile()});
    assert.equal(result.entryEnabled, false);
    assert.equal(result.include, false);
  }
  assert.equal(
    scalpingSessionPermissions({session: session(), preference: preference(), profile: profile("REAL"), brokerConnectionVerified: true}).entryEnabled,
    false
  );
});

test("existing DEMO positions remain eligible for management after pause, opt-out, stop, or account-mode change", () => {
  const cases = [
    {session: session(), preference: preference({enabled: false}), profile: profile(), brokerConnectionVerified: false, hasOpenTrade: true},
    {session: session(), preference: preference({paper_execution_enabled: false}), profile: profile(), hasOpenTrade: true},
    {session: session({status: "STOPPED"}), preference: null, profile: profile(), hasOpenTrade: true},
    {session: session(), preference: preference({account_mode: "REAL"}), profile: profile("REAL"), brokerConnectionVerified: false, hasOpenTrade: true}
  ];
  for (const input of cases) {
    assert.deepEqual(
      scalpingSessionPermissions(input),
      {entryEnabled: false, manageOpen: true, include: true}
    );
  }
});

test("sessions without an open position are excluded when new-entry consent is absent", () => {
  const result = scalpingSessionPermissions({
    session: session({status: "STOPPED"}),
    preference: preference({enabled: false}),
    profile: profile("REAL"),
    brokerConnectionVerified: false,
    hasOpenTrade: false
  });
  assert.deepEqual(result, {entryEnabled: false, manageOpen: false, include: false});
});

test("a disconnected or expired Deriv authorization cannot start new scalping entries", () => {
  for (const brokerConnectionVerified of [false, undefined]) {
    const result = scalpingSessionPermissions({
      session: session(), preference: preference(), profile: profile(),
      brokerConnectionVerified
    });
    assert.equal(result.entryEnabled, false);
    assert.equal(result.include, false);
  }
});

test("a verified connection is required for new entries but not for protecting an existing position", () => {
  const result = scalpingSessionPermissions({
    session: session(), preference: preference(), profile: profile(),
    brokerConnectionVerified: false, hasOpenTrade: true
  });
  assert.deepEqual(result, {entryEnabled: false, manageOpen: true, include: true});
});
