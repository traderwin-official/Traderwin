import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("DEMO dashboard separates the read-only scalping feed from automatic paper execution",async()=>{
 const html=await readFile(new URL("../index.html",import.meta.url),"utf8");
 assert.match(html,/id="demoScalpingPanel"/);
 assert.match(html,/id="enableDemoScalping"/);
 assert.match(html,/id="disableDemoScalping"/);
 assert.match(html,/id="enableDemoScalpingPaper"/);
 assert.match(html,/id="disableDemoScalpingPaper"/);
 assert.match(html,/api\/bots\/demo\/scalping-preferences/);
 assert.match(html,/Feed access is read-only/);
 assert.match(html,/[Aa]utomatic paper trading is a separate opt-in/);
 assert.match(html,/This does not place any order/);
 assert.match(html,/No Deriv broker orders or REAL trades are sent/);
});
