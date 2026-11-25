import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("scalping feed endpoint is authenticated and only returns data for an enabled running DEMO session",async()=>{
 const s=await readFile(new URL("../handlers/bots/demo/scalping-feed.js",import.meta.url),"utf8");
 assert.match(s,/auth\.getUser/);
 assert.match(s,/profile\.account_mode!==\"DEMO\"/);
 assert.match(s,/broker_account_ref.*accountRef/);
 assert.match(s,/session\\.config_snapshot/);
 assert.match(s,/WEBSITE_DEMO_AUTO_PAPER_ONLY/);
 assert.match(s,/session\.status!==\"RUNNING\"/);
 assert.match(s,/preference\.enabled!==true/);
 assert.match(s,/preference\.account_mode!==\"DEMO\"/);
 assert.match(s,/preference\.execution!==\"WEBSITE_PAPER_ONLY\"/);
 assert.match(s,/scalping_market_ticks/);
 assert.match(s,/scalping_signal_events/);
 assert.match(s,/Cache-Control/);
 assert.doesNotMatch(s,/account_mode:\s*\"REAL\"|execution:\s*\"BROKER_ORDER\"/);
});

test("dashboard renders scalping feed values using text nodes and polls only the authenticated API",async()=>{
 const s=await readFile(new URL("../index.html",import.meta.url),"utf8");
 assert.match(s,/demoScalpingFeedStatus/);
 assert.match(s,/api\/bots\/demo\/scalping-feed/);
 assert.match(s,/Authorization:\"Bearer \"\+authState\.session\.access_token/);
 assert.match(s,/scalpFeedTimer=setInterval/);
 assert.match(s,/scalpSignals\.appendChild/);
 assert.doesNotMatch(s,/scalping-market:/);
});

test("scalping worker does not broadcast private candidate signals on public Realtime topics",async()=>{
 const s=await readFile(new URL("../services/scalping-worker/index.js",import.meta.url),"utf8");
 assert.doesNotMatch(s,/db\.channel\(|\.send\(\{type:\"broadcast\"/);
 assert.match(s,/scalping_signal_events/);
 assert.match(s,/scalping_market_ticks/);
});
