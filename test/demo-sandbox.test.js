import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../demo-sandbox.html", import.meta.url), "utf8");

test("offline DEMO sandbox is clearly labelled as simulated and browser-only", () => {
  assert.match(html, /SAFE TEST MODE — SIMULATED ONLY/);
  assert.match(html, /Browser-only practice UI/);
  assert.match(html, /No account, broker, database or payment connection/);
});

test("offline sandbox has no authentication, database, broker, payment or network calls", () => {
  for (const forbidden of [
    /supabase/i, /createClient\s*\(/, /fetch\s*\(/, /XMLHttpRequest/,
    /WebSocket/, /EventSource/, /localStorage/, /sessionStorage/,
    /deriv\.com/i, /mt5/i, /stk-push/i, /payment/i
  ]) assert.doesNotMatch(html, forbidden);
});

test("offline sandbox exposes the practice ticket, risk caps, portfolio and emergency stop", () => {
  for (const required of [
    'id="symbol"', 'id="entry"', 'id="stop"', 'id="size"',
    'perTradeCap=.0025', 'totalCap=.01', 'id="positions"',
    'id="emergency"', 'id="resume"', 'id="reset"'
  ]) assert.ok(html.includes(required), `Missing sandbox feature: ${required}`);
});
