import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("DEMO control requires the validated strategy and supported timeframe before starting", async () => {
  const source = await readFile(new URL("../api/bots/demo/control.js", import.meta.url), "utf8");
  assert.match(source, /s\.strategy!=="MULTI_CONFIRMATION_V1"/);
  assert.match(source, /\["M5","M15","H1","H4"\]/);
  assert.match(source, /unattended DEMO auto worker currently supports Deriv only/);
});

test("DEMO status returns the authenticated user's worker heartbeat", async () => {
  const source = await readFile(new URL("../api/bots/demo/control.js", import.meta.url), "utf8");
  assert.match(source, /demo_bot_worker_heartbeats/);
  assert.match(source, /\.eq\("user_id",uid\)/);
  assert.match(source, /workerHeartbeat:workerHeartbeat\|\|null/);
});

test("dashboard exposes timeframe, validated strategy and worker health", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="botTimeframe"/);
  assert.match(html, /value="MULTI_CONFIRMATION_V1"/);
  assert.match(html, /id="demoWorkerHealth"/);
  assert.match(html, /showDemoWorkerHealth\(r\.workerHeartbeat\)/);
});
