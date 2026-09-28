// bun host/run-bun.js <part...>   parts: sizes bench panics recursion memcap instances
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import * as suite from "./suite.js";

const dir = new URL("../out/", import.meta.url).pathname;
const fetchBytes = async (name) => new Uint8Array(readFileSync(dir + name + ".wasm"));
const workloads = JSON.parse(readFileSync(new URL("../workloads.json", import.meta.url)));
const parts = process.argv.slice(2);
const results = {};
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });

const KiB = (n) => +(n / 1024).toFixed(1);
if (parts.includes("sizes")) {
  results.sizes = readdirSync(dir).filter((f) => f.endsWith(".wasm")).sort().map((f) => {
    const b = readFileSync(dir + f);
    return {
      module: f, rawKiB: KiB(b.length), gzipKiB: KiB(gzipSync(b, { level: 9 }).length),
      brotliKiB: KiB(brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length),
    };
  });
  console.table(results.sizes);
}
const BENCH = ["tiny-vm", "tiny-vm-o2", "go-vm", "tiny-star", "tiny-star-o2", "go-star"];
if (parts.includes("bench")) {
  results.bench = await suite.bench(fetchBytes, BENCH, workloads, (r) => console.log(JSON.stringify(r)));
  console.table(results.bench.map((r) => ({ ...r, best: r.best.toFixed(2), median: r.median.toFixed(2) })));
}
if (parts.includes("panics")) {
  results.panics = [];
  for (const m of ["tiny-star", "tiny-star-trap", "go-star"]) {
    const r = await suite.panics(fetchBytes, m);
    results.panics.push(...r.rows);
    results.panicLogs = [...(results.panicLogs ?? []), ...r.logs.map((l) => m + " " + l)];
  }
  console.table(results.panics);
  console.log(results.panicLogs.join("\n"));
}
if (parts.includes("recursion")) {
  results.recursion = [await suite.recursion(fetchBytes, "tiny-star"), await suite.recursion(fetchBytes, "go-star")];
  console.table(results.recursion);
}
if (parts.includes("memcap")) {
  results.memcap = [];
  for (const [m, pages] of [["tiny-star", 1024], ["go-star", 1024], ["tiny-star", undefined], ["go-star", undefined], ["tiny-star-importmem", 512], ["tiny-star-importmem", 2048]]) {
    results.memcap.push(await suite.memcap(fetchBytes, m, pages, 1500));
    Bun.gc(true);
  }
  console.table(results.memcap);
}
if (parts.includes("instances")) {
  results.instances = [];
  for (const [m, n] of [["tiny-star-stack64k", 3000], ["tiny-star", 3000], ["go-star", 3000]]) {
    const rss0 = process.memoryUsage().rss;
    const r = await suite.instances(fetchBytes, m, n);
    const rss = process.memoryUsage().rss - rss0;
    delete r.keep;
    results.instances.push({ ...r, rssDeltaMiB: +(rss / 2 ** 20).toFixed(1) });
    Bun.gc(true);
  }
  console.table(results.instances);
}
results.env = { bun: Bun.version, platform: process.platform, arch: process.arch };
writeFileSync(new URL(`../results/bun-${parts.join("-")}.json`, import.meta.url), JSON.stringify(results, null, 2));
