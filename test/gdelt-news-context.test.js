import test from "node:test";
import assert from "node:assert/strict";
import { getGdeltNewsContext } from "../lib/gdelt-news-context.js";

const now = Date.parse("2026-11-26T12:00:00.000Z");
const payload = { articles: [
  { title: "Gold rises as inflation fears grow", domain: "example.com", seendate: "20261126113000" },
  { title: "Central bank announces rate cut", domain: "news.test", seendate: "20261126110000" },
  { title: "Old headline", domain: "old.test", seendate: "20261124110000" },
  { title: "Future headline", domain: "future.test", seendate: "20261126130000" },
  { title: "Gold rises as inflation fears grow", domain: "duplicate.test", seendate: "20261126113000" }
] };

test("returns recent contextual headlines and cautious keyword labels", async () => {
  let requested;
  const result = await getGdeltNewsContext("XAUUSD", {
    now: () => now,
    fetchImpl: async url => {
      requested = new URL(url);
      return { ok: true, json: async () => payload };
    }
  });
  assert.equal(requested.hostname, "api.gdeltproject.org");
  assert.equal(result.status, "HEADLINES_AVAILABLE");
  assert.equal(result.articles.length, 2);
  assert.equal(result.articles[0].tone, "NEGATIVE_KEYWORDS");
  assert.equal(result.articles[1].tone, "POSITIVE_KEYWORDS");
  assert.equal(result.newsGateStatus, "UNKNOWN");
  assert.equal(result.sentiment, "CONTEXT_ONLY");
});

test("never treats empty headlines or provider errors as a clear news window", async () => {
  const empty = await getGdeltNewsContext("XAUUSD", {
    now: () => now, fetchImpl: async () => ({ ok: true, json: async () => ({ articles: [] }) })
  });
  assert.equal(empty.status, "NO_RECENT_HEADLINES");
  assert.equal(empty.newsGateStatus, "UNKNOWN");
  const failed = await getGdeltNewsContext("XAUUSD", {
    now: () => now, fetchImpl: async () => ({ ok: false, status: 503 })
  });
  assert.equal(failed.status, "UNAVAILABLE");
  assert.equal(failed.newsGateStatus, "UNKNOWN");
});

test("rejects unsupported instruments and malformed provider timestamps", async () => {
  const unsupported = await getGdeltNewsContext("R_100");
  assert.equal(unsupported.status, "UNAVAILABLE");
  const malformed = await getGdeltNewsContext("XAUUSD", {
    now: () => now,
    fetchImpl: async () => ({ ok: true, json: async () => ({ articles: [
      { title: "bad timestamp", domain: "test", seendate: "not-a-date" }
    ] }) })
  });
  assert.equal(malformed.status, "NO_RECENT_HEADLINES");
  assert.equal(malformed.articles.length, 0);
});
