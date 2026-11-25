import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("continuous worker is explicitly DEMO opt-in and read-only",async()=>{
 const s=await readFile(new URL("../services/scalping-worker/index.js",import.meta.url),"utf8");
 assert.match(s,/demo_scalping_preferences/);
 assert.match(s,/eq\("account_mode","DEMO"\)/);
 assert.match(s,/eq\("execution","WEBSITE_PAPER_ONLY"\)/);
 assert.match(s,/trading_instrument_approvals/);
 assert.match(s,/ticks_history:[\s\S]*granularity:60/);
 assert.match(s,/scalping_signal_events/);
 assert.doesNotMatch(s,/db\\.channel\\(|\\.send\\(\\{type:\\"broadcast\"/);
 assert.match(s,/SIGNAL_ONLY_NO_ORDERS/);
 assert.doesNotMatch(s,/open_demo_paper_trade|buy\s*\(|sell\s*\(/i);
});
