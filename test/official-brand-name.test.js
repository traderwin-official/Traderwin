import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pages = ["index.html", "auth.html", "onboarding.html", "README.md"];

for (const page of pages) {
  test(`${page} uses the official Young Tiger Forex Platform name`, async () => {
    const content = await readFile(new URL(`../${page}`, import.meta.url), "utf8");
    assert.match(content, /Young Tiger Forex Platform/i);
    assert.doesNotMatch(content, /Young Tiger FX/i);
    if (page === "index.html") {
      assert.ok(content.includes("YOUNG TIGER <span>FOREX PLATFORM</span>"));
      assert.ok(!content.includes("YOUNG TIGER <span>FX</span>"));
    }
  });
}
