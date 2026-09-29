// The same crossings in Bun, for scale.
import { readFileSync } from "node:fs";
import { makeWasi } from "../go-wasm/host/wasi.js";
const mod = new WebAssembly.Module(readFileSync(new URL("./out/spike.wasm", import.meta.url)));
const wasi = makeWasi();
const inst = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi.imports, host: { op: (x) => x * 3, reenter: (x) => x, emit() {} } });
wasi.setMemory(inst.exports.memory); inst.exports._initialize();
for (const [name, f] of [["inner", () => inst.exports.inner(4)], ["call_op", () => inst.exports.call_op(4)]]) {
  for (let i = 0; i < 10000; i++) f();
  const n = 200000, t = performance.now();
  for (let i = 0; i < n; i++) f();
  console.log(`${name}: ${((performance.now() - t) * 1000 / n).toFixed(3)} µs per call (Bun)`);
}
