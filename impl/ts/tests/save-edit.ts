// Test helper: a save's records, with each value kept as its bytes, and
// those records written back as a save, so a test can change one field.
import {
  saveSections,
  SaveReader,
  SaveWriter,
  readSave,
  writeSave,
} from '../src/save-format';
import {
  RecordReader,
  RecordWriter,
  type SaveRecords,
  type ValueIO,
} from '../src/save-records';
import { skipValue } from '../src/save-values';

/** A value as its encoded bytes. */
export type RawValue = { bytes: Uint8Array };
const raw: ValueIO<RawValue> = {
  read: r => {
    const start = r.pos;
    skipValue(r);
    return { bytes: r.input.slice(start, r.pos) };
  },
  write: (w, v) => {
    w.raw(v.bytes);
  },
};
export const rawValue = (bytes: number[]): RawValue => ({
  bytes: Uint8Array.from(bytes),
});

export const recordsOf = (bytes: Uint8Array) => {
  const save = readSave(bytes);
  const tables = { calls: 0, libraries: 0, objects: 0, runs: 0 };
  const rr = (tag: number) =>
    new RecordReader(new SaveReader(save.body(tag)!), raw, tables);
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
  const records: SaveRecords<RawValue> = {
    group,
    libraries,
    objects,
    functions,
    calls,
    scripts,
    perScript,
    runs,
    work: rr(saveSections.work).work(),
    waits: rr(saveSections.waits).waits(),
    inputs: rr(saveSections.inputs).inputs(),
    decisions: rr(saveSections.decisions).decisions(),
    ...rr(saveSections.accounting).accounting(),
    sources: save.body(saveSections.sources)
      ? rr(saveSections.sources).sources()
      : undefined,
  };
  return { save, records };
};

/** A save with its records changed by `edit`, framed and digested again. */
export const editSave = (
  bytes: Uint8Array,
  edit: (records: SaveRecords<RawValue>) => void,
  header: (h: { language: string }) => void = () => {},
): Uint8Array => {
  const { save, records: x } = recordsOf(bytes);
  edit(x);
  const h = { ...save };
  header(h);
  // eslint-disable-next-line unicorn/consistent-function-scoping -- Kept beside the sections it writes.
  const body = (f: (w: RecordWriter<RawValue>) => void) => {
    const w = new SaveWriter();
    f(new RecordWriter(w, raw));
    return w.finish();
  };
  const sections = [
    [saveSections.group, body(w => w.group(x.group))],
    [saveSections.libraries, body(w => w.libraries(x.libraries))],
    [saveSections.objects, body(w => w.objects(x.objects))],
    [saveSections.functions, body(w => w.functions(x.functions))],
    [saveSections.calls, body(w => w.calls(x.calls))],
    [saveSections.scripts, body(w => w.scripts(x.scripts))],
    [saveSections.runs, body(w => w.runs(x.perScript, x.runs))],
    [saveSections.work, body(w => w.work(x.work))],
    [saveSections.waits, body(w => w.waits(x.waits))],
    [saveSections.inputs, body(w => w.inputs(x.inputs))],
    [saveSections.decisions, body(w => w.decisions(x.decisions))],
    [
      saveSections.accounting,
      body(w => w.accounting(x.discards, x.changedRoots)),
    ],
    ...(x.sources
      ? [[saveSections.sources, body(w => w.sources(x.sources!))]]
      : []),
  ] as [number, Uint8Array][];
  return writeSave(
    h,
    sections.map(([tag, b]) => ({
      tag,
      body: b,
      optional: tag === saveSections.sources,
    })),
  );
};
