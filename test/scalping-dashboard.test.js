import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
test("DEMO dashboard exposes an explicit signal-only scalping opt-in",async()=>{
 const html=await readFile(new URL("../index.html",import.meta.url),"utf8");
 assert.match(html,/id="demoScalpingPanel"/);
 assert.match(html,/id="enableDemoScalping"/);
 assert.match(html,/id="disableDemoScalping"/);
 assert.match(html,/api\/bots\/demo\/scalping-preferences/);
 assert.match(html,/This does not place any order/);
 assert.match(html,/Signal-only; no orders are placed/);
});
