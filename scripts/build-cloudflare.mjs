import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const out = path.join(root, "dist");
const excluded = new Set([".git", ".github", "node_modules", "dist", "api", "lib", "supabase", "docs", "test", "tests", "scripts"]);
const entries = await readdir(root, { withFileTypes: true });
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// Publish only HTML entry pages and explicitly approved static asset folders.
// Server code, SQL migrations, tests and project metadata must never be web assets.
for (const entry of entries) {
  if (entry.isFile() && entry.name.endsWith(".html")) {
    await cp(path.join(root, entry.name), path.join(out, entry.name));
  }
  if (entry.isDirectory() && ["assets", "images", "css", "js", "fonts"].includes(entry.name)) {
    await cp(path.join(root, entry.name), path.join(out, entry.name), { recursive: true });
  }
}
for (const file of ["favicon.ico", "robots.txt", "manifest.webmanifest"]) {
  try { await cp(path.join(root, file), path.join(out, file)); } catch {}
}
console.log("Tiger Scheme static Pages bundle created at dist/. API routes are intentionally not included yet.");
