import fs from "node:fs";
import vm from "node:vm";

const pages = ["index.html", "auth.html", "onboarding.html"];
let checked = 0;
for (const page of pages) {
  if (!fs.existsSync(page)) continue;
  const html = fs.readFileSync(page, "utf8");
  const scripts = [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)];
  scripts.forEach((match, index) => {
    new vm.Script(match[1], { filename: page + "#inline-" + (index + 1) });
    checked += 1;
  });
}
if (!checked) throw new Error("No inline scripts were found to validate.");
console.log("Validated " + checked + " inline script(s).");
