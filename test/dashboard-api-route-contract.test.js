import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("every API endpoint referenced by the dashboard is registered in the server router", async () => {
  const [html, router] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../api/router.js", import.meta.url), "utf8")
  ]);

  const dashboardRoutes = new Set(
    [...html.matchAll(/["'`]((?:\\/api\\/)[^"'`\\s]*)["'`]/g)]
      .map(match => match[1].split("?")[0])
  );
  const registeredRoutes = new Set(
    [...router.matchAll(/["'](\\/api\\/[^"']+)["']\\s*:/g)]
      .map(match => match[1])
  );

  assert.ok(dashboardRoutes.size > 0, "dashboard API routes should be discovered");
  const missing = [...dashboardRoutes].filter(route => !registeredRoutes.has(route));
  assert.deepEqual(missing, [], "dashboard routes missing from api/router.js");
});
