import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import router from "../api/router.js";

test("Vercel API stays within the Hobby function limit using one catch-all entry point", async () => {
  const entries = await readdir(new URL("../api/", import.meta.url));
  assert.deepEqual(entries.filter(name => name.endsWith(".js")), ["router.js"]);
  assert.equal(entries.some(name => name.includes("encryption")), false);
});

test("catch-all dispatcher registers every legacy and scalping API route", async () => {
  const source = await readFile(new URL("../api/router.js", import.meta.url), "utf8");
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

test("Vercel rewrite sends every API path to the single router function", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.rewrites, [{
    source: "/api/:path*",
    destination: "/api/router?__vercel_route=:path*"
  }]);
});

test("rewritten scalping API path reaches its authenticated handler", async () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  const response = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  try {
    await router({ method:"GET", query:{__vercel_route:"bots/demo/scalping-feed"}, headers:{} }, response);
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.error, "Sign in is required.");
    assert.equal(response.headers["Cache-Control"], "no-store");
  } finally {
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});
