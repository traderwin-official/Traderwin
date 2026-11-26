import test from "node:test";
import assert from "node:assert/strict";
import { getDerivDisconnectScalpingPatch } from "../lib/deriv-disconnect.js";

test("disconnect revokes both signal-feed and automatic paper-entry consent", () => {
  assert.deepEqual(getDerivDisconnectScalpingPatch("2026-11-27T00:00:00.000Z"), {
    enabled: false,
    paper_execution_enabled: false,
    updated_at: "2026-11-27T00:00:00.000Z"
  });
});
