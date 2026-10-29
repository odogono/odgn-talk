// A save's records with values as plain trees, for comparing two saves.
import { readSave, saveSections, SaveReader } from '../src/save-format';
import {
  RecordReader,
  type SaveRecords,
  type ValueIO,
} from '../src/save-records';

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
  const save = readSave(bytes);
  const names = new SaveReader(save.body(saveSections.texts)!).list(r =>
    r.text(),
  );
  const at = (tag: number) => new SaveReader(save.body(tag)!, names);
  const tables = { calls: 0, libraries: 0, objects: 0, runs: 0 };
  const rr = (tag: number) => new RecordReader(at(tag), io, tables);
  const group = rr(saveSections.group).group();
  const libraries = rr(saveSections.libraries).libraries();
  tables.libraries = libraries.length;
  const objects = rr(saveSections.objects).objects();
  tables.objects = objects.length;
  const functions = rr(saveSections.functions).functions();
  const calls = rr(saveSections.calls).calls();
  tables.calls = calls.length;
  const scripts = rr(saveSections.scripts).scripts();
  const { perScript, runs } = rr(saveSections.runs).runs();
  tables.runs = runs.length;
  const work = rr(saveSections.work).work();
  const waits = rr(saveSections.waits).waits();
  const inputs = rr(saveSections.inputs).inputs();
  const decisions = rr(saveSections.decisions).decisions();
  const { discards, changedRoots } = rr(saveSections.accounting).accounting();
  const sources = save.body(saveSections.sources)
    ? rr(saveSections.sources).sources()
    : undefined;
  return {
    group,
    libraries,
    objects,
    functions,
    calls,
    scripts,
    perScript,
    runs,
    work,
    waits,
    inputs,
    decisions,
    discards,
    changedRoots,
    sources,
  };
};
