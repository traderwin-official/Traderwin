import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getDerivDisconnectScalpingPatch } from "../lib/deriv-disconnect.js";

test("disconnect revokes both signal-feed and automatic paper-entry consent", () => {
  assert.deepEqual(getDerivDisconnectScalpingPatch("2026-11-27T00:00:00.000Z"), {
    enabled: false,
    paper_execution_enabled: false,
    updated_at: "2026-11-27T00:00:00.000Z"
  });
});


test("fresh Deriv OAuth authorization resets prior scalping consent before saving the token", () => {
  const callback = readFileSync(new URL("../handlers/deriv/callback.js", import.meta.url), "utf8");
  const reset = callback.indexOf('.from("demo_scalping_preferences")');
  const save = callback.indexOf('.from("deriv_connections")');
  assert.notEqual(reset, -1);
  assert.notEqual(save, -1);
  assert.ok(reset < save, "old automation consent must be revoked before the new broker token is saved");
  assert.match(callback, /getDerivDisconnectScalpingPatch\(\)/);
  assert.match(callback, /if \(preferenceResetError\)/);
});
