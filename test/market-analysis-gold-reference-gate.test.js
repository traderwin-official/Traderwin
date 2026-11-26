import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("market analyst wires the verified XAUS comparison into the final XAUUSD gate", async () => {
  const handler = await readFile(new URL("../handlers/analysis/market.js", import.meta.url), "utf8");
  assert.match(handler, /compareGoldReference\(\{ brokerMid: quoteFresh \? mid : null, reference: goldReference \}\)/);
  assert.match(handler, /independentReferenceRequired: instrument === "XAUUSD"/);
  assert.match(handler, /independentReferenceStatus: instrument === "XAUUSD"\s*\? \(goldReferenceComparison\?\.status \|\| "UNKNOWN"\) : "NOT_APPLICABLE"/);
  assert.match(handler, /marketIntelligence: marketIntelligence/);
});

test("gold reference gate is research-only and does not authorize order execution", async () => {
  const gate = await readFile(new URL("../lib/market-intelligence.js", import.meta.url), "utf8");
  assert.match(gate, /INDEPENDENT_REFERENCE_DIVERGENCE/);
  assert.match(gate, /INDEPENDENT_REFERENCE_NOT_VERIFIED/);
  assert.match(gate, /executionAuthorized: false/);
});
