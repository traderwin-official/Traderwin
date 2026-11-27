import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dashboard exposes signed-in account mode and account risk settings", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /href="\/onboarding\.html"[^>]*>[\s\S]*?Account &amp; Risk/);
  assert.match(html, /accountLink\.textContent=\(data\.session\.user\.email\|\|"My Account"\)\+" · "\+selectedAccountMode/);
  assert.match(html, /aria-label","Open account mode and risk settings"/);
});


test("account mode profile reads are scoped to the authenticated user and selected mode", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /async function loadModeProfile\(\)[\s\S]*?client\.auth\.getUser\(\)/);
  assert.match(html, /from\("bot_mode_profiles"\)[\s\S]*?eq\("user_id",auth\.user\.id\)\.eq\("account_mode",profileMode\.value\)/);
});


test("dashboard exposes the isolated browser-only practice sandbox", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /href="\/demo-sandbox\.html"/);
  assert.match(html, /Standalone virtual practice · illustrative prices/);
});
