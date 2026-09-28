// Does an instance stay usable after many traps? Traps unwind the wasm call
// stack but not the module's own state (shadow stack pointer, heap, locks).
import { load } from "./load.js";
import { readFileSync } from "node:fs";
const dir = new URL("../out/", import.meta.url).pathname;
for (const [name, kind] of [["tiny-star", 1], ["tiny-star", 5], ["go-star", 5]]) {
  const inst = await load(new Uint8Array(readFileSync(dir + name + ".wasm")));
  let traps = 0, firstBad = null;
  for (let i = 0; i < 2000; i++) {
    try { inst.exports.try_panic(kind, 1); } catch { traps++; }
    let ok;
    try { ok = inst.exports.star_bench(0, 18) === 2584n && inst.exports.bench(3, 20000) === 5000n; } catch (e) { ok = false; firstBad ??= `${i}: ${e.message}`; }
    if (!ok) { firstBad ??= `iteration ${i}: wrong result`; break; }
  }
  console.log(JSON.stringify({ name, kind, traps, firstBad }));
}
