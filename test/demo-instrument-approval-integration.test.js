import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manual = readFileSync(new URL("../handlers/bots/demo/pending-batches.js", import.meta.url), "utf8");
const automated = readFileSync(new URL("../handlers/cron/demo-auto-worker.js", import.meta.url), "utf8");

test("manual DEMO pending batches check instrument approval before and after the final quote refresh", () => {
  assert.match(manual, /import \{ loadApprovedInstrument \}/);
  assert.match(manual, /loadApprovedInstrument\(db,\{broker:"DERIV",instrument:symbol,providerSymbol:quote\.providerSymbol\}\)/);
  assert.equal((manual.match(/loadApprovedInstrument\(db,\{broker:"DERIV",instrument:symbol,providerSymbol:quote\.providerSymbol\}\)/g)||[]).length, 2);
  assert.ok(manual.indexOf("approval=await loadApprovedInstrument") < manual.indexOf('db.rpc("open_demo_manual_partial_trade"'));
});

test("automated DEMO entries check instrument approval after the final quote and strategy recheck", () => {
  assert.match(automated, /import \{loadApprovedInstrument\}/);
  assert.match(automated, /loadApprovedInstrument\(db,\{broker:"DERIV",instrument:decision\.symbol,providerSymbol:entryQuote\.providerSymbol\}\)/);
  assert.ok(automated.indexOf("loadApprovedInstrument(db") < automated.indexOf('db.rpc("open_demo_paper_trade"'));
  assert.match(automated, /reason:"INSTRUMENT_NOT_APPROVED"/);
});
