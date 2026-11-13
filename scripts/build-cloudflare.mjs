import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const output = resolve(root, "dist");
const publicFiles = ["index.html", "auth.html", "onboarding.html", "bot-shop.html"];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of publicFiles) {
  await cp(resolve(root, file), resolve(output, file));
}

console.log(`Cloudflare static output prepared: ${publicFiles.join(", ")}`);
