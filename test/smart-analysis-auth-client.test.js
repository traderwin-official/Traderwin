import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Smart Analyst uses the authenticated Supabase client exposed by the auth bootstrap", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf('const smartButton=document.getElementById("runSmartAnalysis");');
  const end = html.indexOf("// DERIV PUBLIC LIVE MARKET FEED", start);
  assert.notEqual(start, -1, "Smart Analyst handler should exist");
  assert.ok(end > start, "Smart Analyst handler should have a bounded source section");
  const handler = html.slice(start, end);
  assert.match(handler, /window\.traderwinAuth/);
  assert.doesNotMatch(handler, /\bclient\.auth/);
});
