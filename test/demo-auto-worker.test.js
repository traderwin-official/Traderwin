import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("DEMO worker is cron-secret protected and uses a database lease", async () => {
  const source = await readFile(new URL("../api/cron/demo-auto-worker.js", import.meta.url), "utf8");
  assert.match(source, /CRON_SECRET/);
  assert.match(source, /authorization !== `Bearer ${CRON_SECRET}`/);
  assert.match(source, /claim_traderwin_demo_worker/);
  assert.match(source, /release_traderwin_demo_worker/);
  assert.match(source, /p_lease_seconds: 120/);
  assert.match(source, /MANUAL_POSITION_NOT_MANAGED/);
  assert.match(source, /realOrdersSent: 0/);
});

test("DEMO worker only queries running DEMO sessions and Deriv broker settings", async () => {
  const source = await readFile(new URL("../api/cron/demo-auto-worker.js", import.meta.url), "utf8");
  assert.match(source, /\.eq\("status", "RUNNING"\)/);
  assert.match(source, /\.eq\("account_mode", "DEMO"\)/);
  assert.match(source, /String\(settings\.broker\)\.toUpperCase\(\) !== "DERIV"/);
  assert.match(source, /kill_switch_active/);
});

test("worker migration adds atomic lease, open and close functions", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611120016_demo_auto_worker.sql", import.meta.url), "utf8");
  assert.match(sql, /claim_traderwin_demo_worker/);
  assert.match(sql, /open_demo_auto_trade/);
  assert.match(sql, /close_demo_auto_trade/);
  assert.match(sql, /worker_last_candle_as_of/);
  assert.match(sql, /kill_switch_active = true/);
  assert.match(sql, /MANUAL_TRADE_NOT_MANAGED/);
  assert.match(sql, /trade_source/);
  assert.match(sql, /Africa\/Nairobi/);
  assert.match(sql, /to service_role/);
});

test("Vercel schedules the DEMO worker once per minute", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.crons, [{ path: "/api/cron/demo-auto-worker", schedule: "* * * * *" }]);
});
