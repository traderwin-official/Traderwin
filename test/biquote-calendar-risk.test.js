import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBiQuoteCalendarRisk,
  getBiQuoteCalendarRiskStatus,
  resetBiQuoteCalendarRiskCacheForTests
} from "../lib/biquote-calendar-risk.js";

const now = Date.parse("2026-11-26T12:00:00.000Z");
const event = (overrides = {}) => ({
  name: "US CPI",
  currency: "USD",
  countryCode: "US",
  importance: "high",
  time: new Date(now + 5 * 60_000).toISOString(),
  timeMode: "exact",
  source: "mql5",
  ...overrides
});

test("matching high-impact exact release triggers a conservative blackout window", () => {
  const result = evaluateBiQuoteCalendarRisk({ events: [event()], instrument: "XAUUSD", now });
  assert.equal(result.status, "BLACKOUT");
  assert.equal(result.reason, "HIGH_IMPACT_CALENDAR_EVENT_WINDOW");
  assert.equal(result.events[0].currency, "USD");
});

test("exposes upcoming instrument-relevant macro events without falsely activating blackout", () => {
  const upcoming = event({ time: new Date(now + 2 * 60 * 60_000).toISOString(), name: "US CPI inflation release" });
  const result = evaluateBiQuoteCalendarRisk({ events: [upcoming], instrument: "XAUUSD", now });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.events.length, 0);
  assert.equal(result.upcomingEvents.length, 1);
  assert.equal(result.upcomingEvents[0].category, "INFLATION");
  assert.equal(result.upcomingEvents[0].impact, "HIGH");
  assert.equal(result.upcomingEvents[0].currency, "USD");
});

test("macro context scores USD rate and inflation events as highly relevant to gold without inferring direction", () => {
  const result = evaluateBiQuoteCalendarRisk({
    events: [event({ name: "Federal Reserve interest rate decision", time: new Date(now + 2 * 60 * 60_000).toISOString() })],
    instrument: "XAUUSD",
    now
  });
  assert.equal(result.upcomingEvents[0].category, "MONETARY_POLICY");
  assert.equal(result.upcomingEvents[0].relevance.score, 100);
  assert.equal(result.upcomingEvents[0].relevance.level, "HIGH");
  assert.equal(result.upcomingEvents[0].relevance.currencyRole, "QUOTE");
  assert.equal(result.upcomingEvents[0].relevance.interpretation, "RELEVANCE_ONLY_NO_DIRECTION_INFERRED");
});

test("macro context distinguishes lower-sensitivity event categories without changing blackout semantics", () => {
  const result = evaluateBiQuoteCalendarRisk({
    events: [event({ name: "US housing starts", time: new Date(now + 2 * 60 * 60_000).toISOString() })],
    instrument: "EURUSD",
    now
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.upcomingEvents[0].category, "HOUSING");
  assert.equal(result.upcomingEvents[0].relevance.level, "LOW");
});

test("nonmatching currency does not create a false instrument-specific blackout", () => {
  const result = evaluateBiQuoteCalendarRisk({ events: [event({ currency: "JPY", countryCode: "JP" })], instrument: "EURUSD", now });
  assert.equal(result.status, "UNKNOWN");
});

test("currency crosses only match their own currencies, not unrelated USD releases", () => {
  const unrelatedUsd = evaluateBiQuoteCalendarRisk({
    events: [event({ currency: "USD", countryCode: "US" })],
    instrument: "GBPJPY",
    now
  });
  assert.equal(unrelatedUsd.status, "UNKNOWN");
  const relevantJpy = evaluateBiQuoteCalendarRisk({
    events: [event({ currency: "JPY", countryCode: "JP" })],
    instrument: "GBPJPY",
    now
  });
  assert.equal(relevantJpy.status, "BLACKOUT");
});

test("date-only and tentative high-impact rows block the matching UTC day", () => {
  const result = evaluateBiQuoteCalendarRisk({
    events: [event({ time: "2026-11-26T00:00:00.000Z", timeMode: "date" })],
    instrument: "GBPUSD",
    now
  });
  assert.equal(result.status, "BLACKOUT");
});

test("old releases outside the configured event window are ignored", () => {
  const result = evaluateBiQuoteCalendarRisk({
    events: [event({ time: new Date(now - 60 * 60_000).toISOString() })],
    instrument: "EURUSD",
    now
  });
  assert.equal(result.status, "UNKNOWN");
});

test("empty, malformed and incomplete calendars never report CLEAR", () => {
  assert.equal(evaluateBiQuoteCalendarRisk({ events: [], instrument: "XAUUSD", now }).status, "UNKNOWN");
  assert.equal(evaluateBiQuoteCalendarRisk({ events: {}, instrument: "XAUUSD", now }).status, "UNKNOWN");
  assert.equal(evaluateBiQuoteCalendarRisk({ events: [event({ importance: "medium" })], instrument: "XAUUSD", now }).status, "UNKNOWN");
});

test("invalid dates and unsafe configuration fail closed", () => {
  assert.equal(evaluateBiQuoteCalendarRisk({ events: [event({ time: "bad" })], instrument: "XAUUSD", now }).status, "UNKNOWN");
  assert.equal(evaluateBiQuoteCalendarRisk({ events: [event()], instrument: "XAUUSD", now, beforeMinutes: 999 }).status, "UNKNOWN");
});

test("HTTP, content-type and request failures return UNKNOWN", async () => {
  resetBiQuoteCalendarRiskCacheForTests();
  const bad = await getBiQuoteCalendarRiskStatus({
    instrument: "XAUUSD", now,
    fetchImpl: async () => ({ ok: false, headers: { get: () => "application/json" } })
  });
  assert.equal(bad.status, "UNKNOWN");
  resetBiQuoteCalendarRiskCacheForTests();
  const type = await getBiQuoteCalendarRiskStatus({
    instrument: "XAUUSD", now,
    fetchImpl: async () => ({ ok: true, headers: { get: () => "text/html" } })
  });
  assert.equal(type.status, "UNKNOWN");
  resetBiQuoteCalendarRiskCacheForTests();
  const failure = await getBiQuoteCalendarRiskStatus({
    instrument: "XAUUSD", now,
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(failure.status, "UNKNOWN");
});

test("valid provider response is evaluated and cached", async () => {
  resetBiQuoteCalendarRiskCacheForTests();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, headers: { get: () => "application/json; charset=utf-8" }, json: async () => [event()] };
  };
  const first = await getBiQuoteCalendarRiskStatus({ instrument: "XAUUSD", now, fetchImpl });
  const second = await getBiQuoteCalendarRiskStatus({ instrument: "XAUUSD", now: now + 1000, fetchImpl });
  assert.equal(first.status, "BLACKOUT");
  assert.equal(second.status, "BLACKOUT");
  assert.equal(calls, 1);
});
