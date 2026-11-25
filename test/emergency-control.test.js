import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("emergency control route requires authenticated account scope and exposes entry-stop actions only",async()=>{
 const s=await readFile(new URL("../handlers/bots/emergency/control.js",import.meta.url),"utf8");
 assert.match(s,/getUser\(/);assert.match(s,/STOP_ENTRIES/);assert.match(s,/CLEAR_STOP/);
 assert.match(s,/kill_switch_active/);assert.match(s,/does not close open positions|does not close positions/i);
 assert.doesNotMatch(s,/closePosition\s*\(/);
});
test("emergency control schema is service-role only and scoped to user/account/mode",async()=>{
 const sql=await readFile(new URL("../supabase/migrations/202611120011_bot_emergency_controls.sql",import.meta.url),"utf8");
 assert.match(sql,/unique\s*\(user_id,\s*account_mode,\s*broker,\s*broker_account_ref\)/i);
 assert.match(sql,/revoke all on public\.bot_emergency_controls from public, anon, authenticated/i);
 assert.match(sql,/enable row level security/i);
});
test("DEMO start and manual entry both enforce the persisted legacy emergency latch",async()=>{
 const start=await readFile(new URL("../handlers/bots/demo/control.js",import.meta.url),"utf8");
 const entry=await readFile(new URL("../handlers/bots/demo/pending-batches.js",import.meta.url),"utf8");
 assert.match(start,/brokerAccountRef="DEMO:"\+uid/);
 assert.match(start,/from\("bot_emergency_controls"\)/);assert.match(start,/kill_switch_active/);
 assert.match(entry,/from\("bot_emergency_controls"\)/);assert.match(entry,/session\.broker_account_ref/);
});
