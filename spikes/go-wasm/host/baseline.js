// Linear memory of each module straight after _initialize, and after one
// small Starlark call (which allocates the interpreter's first objects).
import { load } from "./load.js";
import { readFileSync } from "node:fs";
const dir = new URL("../out/", import.meta.url).pathname;
for (const name of ["tiny-vm", "tiny-star", "tiny-star-stack64k", "go-vm", "go-star"]) {
  const inst = await load(new Uint8Array(readFileSync(dir + name + ".wasm")));
  const init = inst.memory.buffer.byteLength / 2 ** 20;
  inst.exports.bench(0, 10);
  if (name.includes("star")) inst.exports.star_bench(0, 10);
  console.log(JSON.stringify({ name, afterInitMiB: init, afterFirstCallMiB: inst.memory.buffer.byteLength / 2 ** 20 }));
}
