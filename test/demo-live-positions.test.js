import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("DEMO live positions endpoint is authenticated, read-only and prices open positions from verified Deriv quotes", async () => {
  const route = await readFile(new URL("../handlers/bots/demo/positions.js", import.meta.url), "utf8");
  assert.match(route, /req\.method !== "GET"/);
  assert.match(route, /auth\.getUser/);
  assert.match(route, /from\("demo_paper_trades"\)/);
  assert.match(route, /eq\("status", "OPEN"\)/);
  assert.match(route, /getDerivPublicQuote/);
  assert.match(route, /getDerivQuoteToUsd/);
  assert.match(route, /calculatePaperPnl/);
  assert.match(route, /trade_origin === "BOT" \? "AUTOMATIC" : "MANUAL"/);
  assert.doesNotMatch(route, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
});

test("DEMO live positions UI filters MANUAL and AUTOMATIC and never implies REAL broker execution", async () => {
  const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(page, /id="livePositionsMonitor"/);
  assert.match(page, /data-position-filter="MANUAL"/);
  assert.match(page, /data-position-filter="AUTOMATIC"/);
  assert.match(page, /\/api\/bots\/demo\/positions/);
  assert.match(page, /DEMO PAPER ONLY/);
  assert.match(page, /refreshLivePositions/);
});

test("DEMO live positions endpoint is registered as an explicit Vercel route", async () => {
  const dispatcher = await readFile(new URL("../api/router.js", import.meta.url), "utf8");
  assert.match(dispatcher, /handlers\/bots\/demo\/positions\.js/);
  assert.match(dispatcher, /\/api\/bots\/demo\/positions/);
});
