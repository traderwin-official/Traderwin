import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

test("Vercel API stays within the Hobby function limit using one entry point", async () => {
  const entries = await readdir(new URL("../api/", import.meta.url));
  assert.deepEqual(entries.filter(name => name.endsWith(".js")), ["router.js"]);
  assert.equal(entries.some(name => name.includes("encryption")), false);
});

test("router registers every legacy and scalping API route", async () => {
  const source = await readFile(new URL("../api/router.js", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import (h\d+) from ["']\.\.\/handlers\/([^"']+)["'];$/gm)];
  const routeBlock = source.match(/const ROUTES = \{([\s\S]*?)\n\};/)?.[1] || "";
  const routes = [...routeBlock.matchAll(/["'](\/api\/[^"']+)["']\s*:\s*(h\d+)/g)];
  assert.equal(imports.length, 36, "all API handlers must be imported once");
  assert.equal(routes.length, 36, "all API handlers must have one public route");
  assert.deepEqual(routes.map(match => match[2]).sort(), imports.map(match => match[1]).sort());
  const handlerFiles = (await readdir(new URL("../handlers/", import.meta.url), {recursive:true}))
    .filter(path => path.endsWith(".js")).map(path => "handlers/" + path).sort();
  assert.deepEqual(imports.map(match => match[2]).sort(), handlerFiles, "every handler file must be reachable through the router");
  assert.match(source, /req\.query\?\.__vercel_route/);
  for (const route of [
    "/api/bots/demo/pending-batches",
    "/api/bots/demo/scalping-feed",
    "/api/bots/demo/scalping-preferences",
    "/api/admin/instruments",
    "/api/cron/demo-auto-worker"
  ]) assert.ok(routes.some(match => match[1] === route), "missing route " + route);
});

test("Vercel rewrite sends every API path and preserves the route suffix for dispatch", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.rewrites, [{
    source: "/api/:path*",
    destination: "/api/router?__vercel_route=:path*"
  }]);
});
