import { makeWasi } from "./wasi.js";
import { importMemory, memoryLimits } from "./memory.js";

// Instantiates a reactor module. With maxPages, the Host owns the memory
// and imposes the maximum (rewriting the module first if it must).
export async function load(bytes, { maxPages, log } = {}) {
  const wasi = makeWasi(log);
  const imports = { wasi_snapshot_preview1: wasi.imports };
  let memory;
  if (maxPages !== undefined && !(bytes instanceof WebAssembly.Module)) {
    let min;
    const lim = memoryLimits(bytes);
    if (lim.imported) min = 3;
    else ({ bytes, min } = importMemory(bytes, maxPages));
    memory = new WebAssembly.Memory({ initial: min, maximum: maxPages });
    imports.env = { memory };
  }
  const t0 = performance.now();
  const module = bytes instanceof WebAssembly.Module ? bytes : await WebAssembly.compile(bytes);
  const t1 = performance.now();
  const instance = await WebAssembly.instantiate(module, imports);
  memory ??= instance.exports.memory;
  wasi.setMemory(memory);
  instance.exports._initialize?.();
  const t2 = performance.now();
  return { exports: instance.exports, memory, module, compileMs: t1 - t0, instantiateMs: t2 - t1 };
}
