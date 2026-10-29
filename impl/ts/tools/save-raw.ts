// A save's records with values as plain trees, for comparing two saves.
import { SaveReader } from '../src/save-format';
import { readRecords as coreReadRecords } from '../src/save-file';
import { type SaveRecords, type ValueIO } from '../src/save-records';

export type Raw = unknown;
const rawRest = (r: SaveReader, tag: number): Raw => {
  switch (tag) {
    case 5:
      return Buffer.from(r.bytes()).toString('hex');
    case 6:
      return r.list(r => rawIO.read(r));
    case 7: {
      const m = r.byte();
      return { m, pairs: r.list(r => [r.name(), rawIO.read(r)]) };
    }
    case 8:
      return [rawIO.read(r), rawIO.read(r)];
    case 9:
      return [String(r.bigSint()), r.uint()];
    case 10: {
      const y = r.sint();
      const mo = r.uint();
      const d = r.uint();
      const t = r.optional(r => [r.uint(), r.uint(), r.uint(), r.uint()]);
      return [y, mo, d, t];
    }
    case 11:
      return r.text();
    case 12: {
      const code = r.uint();
      const display = r.name();
      // A value with code takes its home from it.
      const home = code === 0 ? r.name() : undefined;
      return { code, display, home, captures: rawIO.read(r) };
    }
    case 13:
      return { object: r.uint() };
    default:
      throw new Error(`bad value tag ${tag}`);
  }
};
export const rawIO: ValueIO<Raw> = {
  read: r => {
    const tag = r.byte();
    if (tag === 4) {
      const m = r.byte();
      return { m, t: r.text() };
    }
    if (tag === 0) {
      return null;
    }
    if (tag === 1) {
      return r.bool();
    }
    if (tag === 2 || tag === 3) {
      const d = { neg: r.bool(), c: String(r.wideUint(128)), e: r.sint() };
      return tag === 2 ? { n: d } : { q: d, u: r.name() };
    }
    return { tag, v: rawRest(r, tag) };
  },
  write: () => {
    throw new Error('read only');
  },
};

export const readRecords = <V>(
  bytes: Uint8Array,
  io: ValueIO<V>,
): SaveRecords<V> => {
  const { header: _, texts: __, ...records } = coreReadRecords(bytes, io);
  return records;
};
