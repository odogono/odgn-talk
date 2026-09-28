// bun host/summarize.js — prints the Markdown tables used in the findings.
import { readFileSync } from "node:fs";
const r = (f) => JSON.parse(readFileSync(new URL(`../results/${f}.json`, import.meta.url)));
const native = readFileSync(new URL("../results/native-bench.jsonl", import.meta.url), "utf8").trim().split("\n").map(JSON.parse);
const hosts = { Bun: r("bun-bench").bench, Chromium: r("chromium-bench").bench, Firefox: r("firefox-bench").bench };
const key = (x) => `${x.suite}/${x.name}`;
const nat = Object.fromEntries(native.map((x) => [key(x), x.best]));

console.log("| Workload | native Go |" + Object.keys(hosts).flatMap((h) => ["tiny-z", "tiny-O2", "go"].map((m) => ` ${h} ${m} |`)).join(""));
console.log("|---|---:|" + "---:|".repeat(9));
for (const [suite, prefix] of [["vm", "vm"], ["star", "star"]]) {
  for (const w of ["fib", "loop", "strings", "maps"]) {
    const k = `${suite}/${w}`;
    const cells = [];
    for (const rows of Object.values(hosts)) {
      for (const m of [`tiny-${prefix}`, `tiny-${prefix}-o2`, `go-${prefix}`]) {
        const row = rows.find((x) => x.module === m && key(x) === k);
        cells.push(row ? `${Math.round(row.best)} (${(row.best / nat[k]).toFixed(1)}×)` : "–");
      }
    }
    console.log(`| ${k} | ${Math.round(nat[k])} | ${cells.join(" | ")} |`);
  }
}
console.log("\n| Module | " + Object.keys(hosts).map((h) => `${h} compile | ${h} instantiate+init`).join(" | ") + " |");
for (const m of ["tiny-vm", "tiny-star", "go-vm", "go-star"]) {
  const c = Object.values(hosts).flatMap((rows) => ["(compile)", "(instantiate+init)"].map((n) => rows.find((x) => x.module === m && x.name === n).best.toFixed(1)));
  console.log(`| ${m} | ${c.join(" | ")} |`);
}
