import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("individual demo mark endpoint cannot trigger a per-trade profit giveback close", async () => {
  const source = await readFile(new URL("../api/bots/demo/mark.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /calculateProfitProtection/);
  assert.doesNotMatch(source, /PROFIT_GIVEBACK_CLOSE/);
  assert.match(source, /scope: "PORTFOLIO"/);
  assert.match(source, /AWAITING_PORTFOLIO_MONITOR/);
});
