// The measurements, shared by the Bun and browser runners. Each takes a
// fetchBytes(name) so the same code reads files in Bun and fetches in a page.
import { load } from "./load.js";

const errText = (e) => (e instanceof Error ? `${e.constructor.name}: ${e.message}` : `thrown ${typeof e}: ${String(e)}`).slice(0, 160);

const PAGE = 65536;
const health = (x) => {
  try { return x.bench(0, 20) === 6765n ? "ok" : "wrong result"; } catch (e) { return "dead: " + errText(e); }
};

export async function bench(fetchBytes, modules, workloads, progress) {
  const rows = [];
  for (const name of modules) {
    const inst = await load(await fetchBytes(name));
    rows.push({ module: name, name: "(compile)", best: inst.compileMs, median: inst.compileMs });
    rows.push({ module: name, name: "(instantiate+init)", best: inst.instantiateMs, median: inst.instantiateMs });
    const suites = name.includes("star") ? [["vm", "bench"], ["star", "star_bench"]] : [["vm", "bench"]];
    for (const [suite, fn] of suites) {
      for (const [k, [wname, n]] of workloads[suite].entries()) {
        const f = inst.exports[fn];
        const result = f(k, n);
        const ms = [];
        for (let i = 0; i < workloads.reps; i++) {
          const t = performance.now();
          f(k, n);
          ms.push(performance.now() - t);
        }
        ms.sort((a, b) => a - b);
        rows.push({ module: name, suite, name: wname, n, result: String(result), best: ms[0], median: ms[ms.length >> 1] });
        progress?.(rows.at(-1));
      }
    }
  }
  return rows;
}

const PANICS = ["panic(\"boom\")", "VM divide by zero", "VM index out of range", "nil map write", "nil pointer deref", "Go recursion 10M deep"];

// For each panic kind: does recover() catch it, and is the instance usable
// afterwards? Then the same without recover (the panic escapes to the Host).
export async function panics(fetchBytes, name) {
  const rows = [];
  const logs = [];
  for (const rec of [1, 0]) {
    for (const [kind, label] of PANICS.entries()) {
      const inst = await load(await fetchBytes(name), { log: (fd, l) => logs.push(`${label}: ${l}`) });
      let outcome;
      try {
        outcome = inst.exports.try_panic(kind, rec) === 1 ? "recovered" : "no panic";
      } catch (e) {
        outcome = "trap → " + errText(e);
      }
      const after = health(inst.exports);
      let again = "";
      if (after === "ok") {
        try { again = inst.exports.try_panic(0, 1) === 1 ? "recover still works" : "?"; } catch (e) { again = "trap: " + errText(e); }
      }
      rows.push({ module: name, recover: !!rec, panic: label, outcome, healthAfter: after, again });
    }
  }
  return { rows, logs: logs.slice(0, 40) };
}

// How deep can plain Go recursion go before something breaks? Bisects on
// fresh instances, since a trap can leave an instance damaged.
export async function recursion(fetchBytes, name) {
  const module = await WebAssembly.compile(await fetchBytes(name));
  let error = "";
  const ok = async (n) => {
    const inst = await load(module);
    try { return inst.exports.recurse(n) === BigInt(n); } catch (e) { error = errText(e); return false; }
  };
  let lo = 1, hi = 1 << 24;
  while (hi - lo > Math.max(16, lo / 100)) {
    const mid = Math.floor((lo + hi) / 2);
    if (await ok(mid)) lo = mid; else hi = mid;
  }
  return { module: name, maxDepth: lo, failsAt: hi, error };
}

// Grow the heap 1 MiB at a time until something gives. maxPages undefined
// means no Host-imposed cap (the engine's own limit applies; we stop at
// stopMiB to avoid exhausting the machine).
export async function memcap(fetchBytes, name, maxPages, stopMiB = 1024) {
  const logs = [];
  let inst;
  try {
    inst = await load(await fetchBytes(name), { maxPages, log: (fd, l) => logs.push(l) });
  } catch (e) {
    return { module: name, maxPages, outcome: "load failed → " + errText(e) };
  }
  let held = 0, outcome = `reached ${stopMiB} MiB without failing`;
  const t = performance.now();
  try {
    while (held < stopMiB) held = inst.exports.hold(1);
  } catch (e) {
    outcome = "trap → " + errText(e);
  }
  const ms = performance.now() - t;
  const memMiB = inst.memory.buffer.byteLength / 2 ** 20;
  const after = health(inst.exports);
  let afterRelease = "";
  if (after === "ok") {
    try { inst.exports.release(); afterRelease = health(inst.exports) + `, held ${inst.exports.hold(1)} MiB`; } catch (e) { afterRelease = "trap: " + errText(e); }
  }
  return { module: name, maxMiB: maxPages ? (maxPages * PAGE) / 2 ** 20 : "none", heldMiB: held, memoryMiB: memMiB, outcome, healthAfter: after, afterRelease, ms: Math.round(ms), stderr: logs.slice(0, 3).join(" | ") };
}

// Many instances of one module: time per instance, and how many fit.
export async function instances(fetchBytes, name, count) {
  const bytes = await fetchBytes(name);
  const module = await WebAssembly.compile(bytes);
  const list = [];
  const t = performance.now();
  let error = "";
  try {
    for (let i = 0; i < count; i++) list.push(await load(module));
  } catch (e) {
    error = errText(e);
  }
  const ms = performance.now() - t;
  const linear = list.reduce((n, i) => n + i.memory.buffer.byteLength, 0) / 2 ** 20;
  return { module: name, requested: count, created: list.length, msPerInstance: +(ms / list.length).toFixed(3), linearMemoryMiB: +linear.toFixed(1), error, keep: list };
}
