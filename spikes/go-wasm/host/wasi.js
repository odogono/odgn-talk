// A minimal wasi_snapshot_preview1 shim, identical in Bun and browsers, so
// both Hosts run the same module the same way. No files, no env, no args.
export class ExitError extends Error {
  constructor(code) { super(`proc_exit(${code})`); this.code = code; }
}

export function makeWasi(log = () => {}) {
  let memory;
  const view = () => new DataView(memory.buffer);
  const out = { 1: "", 2: "" };
  const fns = {
    fd_write(fd, iovs, n, nwritten) {
      const dv = view();
      let total = 0;
      for (let i = 0; i < n; i++) {
        const p = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
        out[fd] = (out[fd] ?? "") + new TextDecoder().decode(new Uint8Array(memory.buffer, p, len));
        total += len;
      }
      dv.setUint32(nwritten, total, true);
      let nl;
      while ((nl = out[fd].indexOf("\n")) >= 0) { log(fd, out[fd].slice(0, nl)); out[fd] = out[fd].slice(nl + 1); }
      return 0;
    },
    random_get(p, len) {
      for (let o = 0; o < len; o += 65536)
        crypto.getRandomValues(new Uint8Array(memory.buffer, p + o, Math.min(65536, len - o)));
      return 0;
    },
    clock_time_get(id, precision, p) {
      const ns = id === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.round(performance.now() * 1e6));
      view().setBigUint64(p, ns, true);
      return 0;
    },
    args_sizes_get(argc, bufsz) { view().setUint32(argc, 0, true); view().setUint32(bufsz, 0, true); return 0; },
    environ_sizes_get(c, sz) { view().setUint32(c, 0, true); view().setUint32(sz, 0, true); return 0; },
    args_get() { return 0; },
    environ_get() { return 0; },
    proc_exit(code) { throw new ExitError(code); },
    sched_yield() { return 0; },
    // Every subscription fires at once: sleeps return immediately.
    poll_oneoff(subs, events, n, nevents) {
      const dv = view();
      for (let i = 0; i < n; i++) {
        dv.setBigUint64(events + i * 32, dv.getBigUint64(subs + i * 48, true), true);
        dv.setUint16(events + i * 32 + 8, 0, true);
        dv.setUint8(events + i * 32 + 10, dv.getUint8(subs + i * 48 + 8));
      }
      dv.setUint32(nevents, n, true);
      return 0;
    },
    fd_prestat_get() { return 8; }, // EBADF: no preopened dirs
  };
  const imports = new Proxy(fns, {
    get: (t, k) => t[k] ?? (() => 52), // ENOSYS for everything else
  });
  return { imports, setMemory(m) { memory = m; } };
}
