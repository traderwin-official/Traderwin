import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manual = readFileSync(new URL("../handlers/bots/demo/trade.js", import.meta.url), "utf8");
const automated = readFileSync(new URL("../handlers/cron/demo-auto-worker.js", import.meta.url), "utf8");

test("manual DEMO entry checks instrument approval against initial and final Deriv provider symbols", () => {
  assert.match(manual, /import \{ loadApprovedInstrument \}/);
  assert.match(manual, /loadApprovedInstrument\(db,\{broker:"DERIV",instrument:symbol,providerSymbol:quote\.providerSymbol\}\)/);
  assert.match(manual, /loadApprovedInstrument\(db,\{broker:"DERIV",instrument:symbol,providerSymbol:finalQuote\.providerSymbol\}\)/);
  assert.ok(manual.indexOf("finalApproval=await loadApprovedInstrument") < manual.indexOf('db.rpc("open_demo_paper_trade"'));
});

test("automated DEMO entries check instrument approval after the final quote and strategy recheck", () => {
  assert.match(automated, /import \{loadApprovedInstrument\}/);
  assert.match(automated, /loadApprovedInstrument\(db,\{broker:"DERIV",instrument:decision\.symbol,providerSymbol:entryQuote\.providerSymbol\}\)/);
  assert.ok(automated.indexOf("loadApprovedInstrument(db") < automated.indexOf('db.rpc("open_demo_paper_trade"'));
  assert.match(automated, /reason:"INSTRUMENT_NOT_APPROVED"/);
});
