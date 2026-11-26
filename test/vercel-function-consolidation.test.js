import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

test("Vercel API stays within the Hobby function limit using one catch-all entry point", async () => {
  const entries = await readdir(new URL("../api/", import.meta.url));
  assert.deepEqual(entries.filter(name => name.endsWith(".js")), ["[...path].js"]);
  assert.equal(entries.some(name => name.includes("encryption")), false);
});

test("catch-all dispatcher registers every legacy and scalping API route", async () => {
  const source = await readFile(new URL("../api/[...path].js", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import (h\d+) from ["']\.\.\/handlers\/([^"']+)["'];$/gm)];
  const routeBlock = source.match(/const ROUTES = \{([\s\S]*?)\n\};/)?.[1] || "";
  const routes = [...routeBlock.matchAll(/["'](\/api\/[^"']+)["']\s*:\s*(h\d+)/g)];
  assert.equal(imports.length, 36, "all API handlers must be imported once");
  assert.equal(routes.length, 36, "all API handlers must have one public route");
  const importedAliases = imports.map(match => match[1]).sort();
  const routedAliases = routes.map(match => match[2]).sort();
  assert.deepEqual(routedAliases, importedAliases, "each handler import must be routed exactly once");
  for (const route of [
    "/api/bots/demo/pending-batches",
    "/api/bots/demo/scalping-feed",
    "/api/bots/demo/scalping-preferences",
    "/api/admin/instruments",
    "/api/cron/demo-auto-worker"
  ]) assert.ok(routes.some(match => match[1] === route), "missing route " + route);
});
