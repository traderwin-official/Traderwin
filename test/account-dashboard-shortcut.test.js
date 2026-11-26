import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dashboard exposes signed-in account mode and account risk settings", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /href="\/onboarding\.html"[^>]*>[\s\S]*?Account &amp; Risk/);
  assert.match(html, /accountLink\.textContent=\(data\.session\.user\.email\|\|"My Account"\)\+" · "\+selectedAccountMode/);
  assert.match(html, /aria-label","Open account mode and risk settings"/);
});
