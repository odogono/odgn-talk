// Rewrites a module that defines its own memory into one that imports
// env.memory, so the Host can create that memory with a maximum of its
// choosing. Works for any toolchain's output, including standard Go's.
function leb(bytes, pos) {
  let result = 0, shift = 0, b;
  do { b = bytes[pos++]; result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return [result >>> 0, pos];
}
function uleb(n) {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}
const str = (s) => [...uleb(s.length), ...new TextEncoder().encode(s)];

export function sections(bytes) {
  const list = [];
  let pos = 8;
  while (pos < bytes.length) {
    const id = bytes[pos];
    const [size, start] = leb(bytes, pos + 1);
    list.push({ id, start, end: start + size, headerStart: pos });
    pos = start + size;
  }
  return list;
}

// Returns the memory limits a module declares or imports, in 64 KiB pages.
export function memoryLimits(bytes) {
  const secs = sections(bytes);
  const mem = secs.find((s) => s.id === 5);
  if (mem) {
    let [count, p] = leb(bytes, mem.start);
    const flags = bytes[p++];
    const [min, p2] = leb(bytes, p);
    const max = flags & 1 ? leb(bytes, p2)[0] : undefined;
    return { imported: false, min, max };
  }
  return { imported: true };
}

export function importMemory(bytes, maxPages) {
  const secs = sections(bytes);
  const mem = secs.find((s) => s.id === 5);
  if (!mem) throw new Error("module already imports its memory");
  const { min } = memoryLimits(bytes);
  const entry = [...str("env"), ...str("memory"), 0x02, 0x01, ...uleb(min), ...uleb(maxPages)];
  const imp = secs.find((s) => s.id === 2);
  const parts = [bytes.subarray(0, 8)];
  let inserted = false;
  const emit = (id, body) => parts.push(new Uint8Array([id, ...uleb(body.length)]), body);
  for (const s of secs) {
    if (s.id === 5) continue;
    if (s.id === 2) {
      const [count, p] = leb(bytes, s.start);
      emit(2, new Uint8Array([...uleb(count + 1), ...bytes.subarray(p, s.end), ...entry]));
      inserted = true;
      continue;
    }
    if (!inserted && s.id !== 0 && s.id > 2) {
      emit(2, new Uint8Array([...uleb(1), ...entry]));
      inserted = true;
    }
    parts.push(bytes.subarray(s.headerStart, s.end));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { bytes: out, min };
}
