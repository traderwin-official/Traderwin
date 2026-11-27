import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("market watch cards can set one shared instrument across analysis and DEMO tools", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /function setSharedMarketContext\(instrument\)/);
  assert.match(html, /\["smartInstrument","paperSymbol","botInstrument","profileInstrument"\]\.forEach/);
  assert.match(html, /useButton\.addEventListener\("click",\(\)=>\{[\s\S]*?setSharedMarketContext\(canonical\)/);
  assert.match(html, /useButton\.disabled=!canonical/);
  assert.match(html, /function marketContextSymbol\(label\)/);
});

test("chart, analyst and DEMO timeframe controls share supported timeframe context", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /function setSharedTimeframe\(timeframe\)/);
  assert.match(html, /if\(smart\)smart\.value=tf/);
  assert.match(html, /if\(demo\)demo\.value=tf/);
  assert.match(html, /if\(bot\)bot\.value=tf/);
  assert.match(html, /smartTimeframe"\)\.addEventListener\("change"[\s\S]*?setSharedTimeframe/);
  assert.match(html, /demoTimeframe"\)\.addEventListener\("change"[\s\S]*?setSharedTimeframe/);
  assert.match(html, /timeframeByInterval[\s\S]*?setSharedTimeframe\(timeframe\)/);
});


test("shared market selection rejects unknown instruments and keeps binary contracts out of spot context", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /if\(!Object\.prototype\.hasOwnProperty\.call\(marketContextSymbols,symbol\)\)return false/);
  assert.match(html, /const canonical=marketContextSymbol\(item\[0\]\);[\s\S]*?useButton\.disabled=!canonical/);
  assert.match(html, /"Binary Options":\[\["Rise\/Fall"[\s\S]*?"Touch\/No Touch"/);
  assert.match(html, /function marketContextSymbol\(label\)[\s\S]*?hasOwnProperty\.call\(marketContextSymbols,key\)\?key:null/);
});
