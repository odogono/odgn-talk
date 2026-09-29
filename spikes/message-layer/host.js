// Runs each check on a fresh instance and prints what happened.
import { readFileSync } from "node:fs";
import { makeWasi } from "../go-wasm/host/wasi.js";

const bytes = readFileSync(new URL("./out/spike.wasm", import.meta.url));
const mod = new WebAssembly.Module(bytes);

function fresh(hostFns = {}) {
  const lines = [];
  const wasi = makeWasi((fd, l) => lines.push(`fd${fd}: ${l}`));
  let inst;
  const host = {
    op: (x) => x * 3,
    reenter: (x) => inst.exports.inner(x) + 1,
    emit: (p, n) => lines.push("emit " + new TextDecoder().decode(new Uint8Array(inst.exports.memory.buffer, p, n))),
    ...hostFns,
  };
  inst = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi.imports, host });
  wasi.setMemory(inst.exports.memory);
  inst.exports._initialize();
  return { e: inst.exports, lines };
}

function check(name, f) {
  const { e, lines } = fresh();
  let out;
  try { out = "returned " + JSON.stringify(f(e)); } catch (err) { out = "threw " + (err.message ?? err); }
  console.log(`## ${name}\n${out}\n${lines.slice(0, 4).join("\n")}\n`);
}

check("1 export blocks on a channel", (e) => e.block_chan());
check("1b instance after that", (e) => { try { e.block_chan(); } catch {} return e.call_op(2); });
check("2 goroutine started by an export, between exports", (e) => {
  e.spawn(); const a = e.ticks_now(); const b = e.ticks_now(); const c = e.yield_some(5); const d = e.ticks_now();
  return { afterSpawn: a, nextExport: b, afterYield5: c, after: d };
});
check("4 synchronous import (immediate Operation)", (e) => e.call_op(4));
check("4b reentrant export from inside an import", (e) => e.call_reenter(4));
check("5 goroutine-per-Run parked across exports", (e) => {
  const s = e.start_goroutine_run(); const r = e.answer_goroutine_run(21); return { state: s, result: r };
});
check("6 plain-data Run: pump, answer, pump", (e) => {
  e.deliver(5); const p1 = e.pump(); const p2 = e.pump(); e.answer(p1, 37); const p3 = e.pump();
  return { firstPump: p1, pumpAgainNoInput: p2, afterAnswer: p3 };
});
check("7 frame through linear memory", (e) => {
  const msg = new TextEncoder().encode('{"m":"deliver"}');
  const p = e.alloc(msg.length); new Uint8Array(e.memory.buffer, p, msg.length).set(msg);
  const r = e.frame(msg.length); const ptr = Number(r >> 32n), len = Number(r & 0xffffffffn);
  return new TextDecoder().decode(new Uint8Array(e.memory.buffer, ptr, len));
});
