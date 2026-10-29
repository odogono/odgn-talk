// A whole save as records (ADR 0144, spec/data/save-format.toml): which
// sections come in what order, the tables later sections are checked
// against, and the checks that need only the save's bytes. Framing is
// save-format.ts's; one record's shape is save-records.ts's.
import { operationsOf } from './manifest';
import {
  invalidSave,
  readSave,
  saveSections,
  SaveReader,
  SaveWriter,
  TextTable,
  writeSave,
  type SaveHeader,
  type SaveSection,
} from './save-format';
import {
  RecordReader,
  RecordWriter,
  type FunctionRecord,
  type GroupRecord,
  type LibraryRecord,
  type ObjectRecord,
  type SaveRecords,
  type ScriptRecord,
  type Tables,
  type ValueIO,
} from './save-records';
import { skipValue } from './save-values';

type Sources = SaveRecords<unknown>['sources'];

/** The records that hold values, read once a value reader can be built. */
export type ValueRecords<V> = Omit<
  SaveRecords<V>,
  'functions' | 'group' | 'libraries' | 'objects' | 'sources'
>;

/** A save whose value-free records are read and whose structure is checked. */
export type OpenSave = SaveHeader & {
  functions: FunctionRecord[];
  group: GroupRecord;
  libraries: LibraryRecord[];
  objects: ObjectRecord[];
  /** Each Script's record, its values skipped. */
  scripts: ScriptRecord<undefined>[];
  sources: Sources;
  /** The `texts` table, in order. */
  texts: string[];
  /** The records that hold values, read with `io`. */
  values<V>(io: ValueIO<V>): ValueRecords<V>;
};

const skipping: ValueIO<undefined> = {
  read: r => {
    skipValue(r);
    return undefined;
  },
  write: () => {},
};

/** Reads each value-bearing section, after the tables it indexes. */
const valueRecords = <V>(
  section: <T>(tag: number, read: (r: RecordReader<V>) => T) => T,
  tables: Tables,
): ValueRecords<V> => {
  const calls = section(saveSections.calls, r => r.calls());
  tables.calls = calls.length;
  const scripts = section(saveSections.scripts, r => r.scripts());
  const { perScript, runs } = section(saveSections.runs, r => r.runs());
  tables.runs = runs.length;
  return {
    calls,
    scripts,
    perScript,
    runs,
    work: section(saveSections.work, r => r.work()),
    waits: section(saveSections.waits, r => r.waits()),
    inputs: section(saveSections.inputs, r => r.inputs()),
    decisions: section(saveSections.decisions, r => r.decisions()),
    ...section(saveSections.accounting, r => r.accounting()),
  };
};

/** The checks across sections that no Core's save fails. */
const check = (v: ValueRecords<unknown>) => {
  const { scripts } = v;
  const names = new Set(scripts.map(s => s.name));
  if (
    names.size !== scripts.length ||
    v.perScript.length !== scripts.length ||
    v.work.length !== scripts.length ||
    v.perScript.reduce((a, b) => a + b, 0) !== v.runs.length
  ) {
    invalidSave();
  }
  for (const script of scripts) {
    const grants = new Set(script.grants.map(g => g.name));
    if (grants.size !== script.grants.length) {
      invalidSave();
    }
    for (const grant of script.grants) {
      const declared = operationsOf(grant.declarations);
      if (
        declared.capability !== grant.capability ||
        grant.operations.some(op => !declared.operations.has(op.name))
      ) {
        invalidSave();
      }
    }
  }
};

/**
 * Reads a save's frames and its value-free records, and checks every
 * section's structure with values skipped, so a save no Core could have
 * written fails before a restore runs any Host callback. Another magic,
 * such as an old JSON save, is `invalid save`.
 */
export const openSave = (bytes: Uint8Array): OpenSave => {
  const save = readSave(bytes);
  const texts = new SaveReader(save.body(saveSections.texts)!);
  const textList = texts.list(r => r.text());
  texts.end();
  const sectionsOf =
    <V>(io: ValueIO<V>, tables: Tables) =>
    <T>(tag: number, read: (r: RecordReader<V>) => T): T => {
      const r = new RecordReader(
        new SaveReader(save.body(tag)!, textList),
        io,
        tables,
      );
      const out = read(r);
      r.r.end();
      return out;
    };
  const tables: Tables = { calls: 0, libraries: 0, objects: 0, runs: 0 };
  const section = sectionsOf(skipping, tables);
  const group = section(saveSections.group, r => r.group());
  const libraries = section(saveSections.libraries, r => r.libraries());
  tables.libraries = libraries.length;
  const objects = section(saveSections.objects, r => r.objects());
  tables.objects = objects.length;
  const functions = section(saveSections.functions, r => r.functions());
  const sources = save.body(saveSections.sources)
    ? section(saveSections.sources, r => r.sources())
    : undefined;
  const skipped = valueRecords(section, tables);
  check(skipped);
  if (sources && sources.length !== skipped.scripts.length) {
    invalidSave();
  }
  return {
    language: save.language,
    costModel: save.costModel,
    groupFingerprint: save.groupFingerprint,
    saveIdCounter: save.saveIdCounter,
    group,
    libraries,
    objects,
    functions,
    scripts: skipped.scripts,
    sources,
    texts: textList,
    values: io => {
      const t = { ...tables, calls: 0, runs: 0 };
      return valueRecords(sectionsOf(io, t), t);
    },
  };
};

/** Every record of a save, its values read with `io`. */
export const readRecords = <V>(
  bytes: Uint8Array,
  io: ValueIO<V>,
): SaveRecords<V> & { header: SaveHeader; texts: string[] } => {
  const save = openSave(bytes);
  return {
    header: {
      language: save.language,
      costModel: save.costModel,
      groupFingerprint: save.groupFingerprint,
      saveIdCounter: save.saveIdCounter,
    },
    texts: save.texts,
    group: save.group,
    libraries: save.libraries,
    objects: save.objects,
    functions: save.functions,
    sources: save.sources,
    ...save.values(io),
  };
};

export type SectionWriter<V> = (w: RecordWriter<V>) => void;

/**
 * Frames each section in tag order. Every section but `functions` and
 * `texts` adds to the texts table as it is written; `functions` is written
 * last, since writing values may add to it, and `texts` holds the table.
 * `texts` starts the table, for values whose texts are already numbered.
 */
export const writeSections = <V>(
  header: SaveHeader,
  io: ValueIO<V>,
  bodies: Record<
    Exclude<keyof typeof saveSections, 'sources' | 'texts'>,
    SectionWriter<V>
  > & { sources?: SectionWriter<V> },
  texts = new TextTable(),
): Uint8Array => {
  const written = new Map<number, Uint8Array>();
  const write = (body: SectionWriter<V>) => {
    const w = new SaveWriter(texts);
    body(new RecordWriter(w, io));
    return w.finish();
  };
  for (const [name, tag] of Object.entries(saveSections)) {
    const body = bodies[name as keyof typeof bodies];
    if (body && tag !== saveSections.functions) {
      written.set(tag, write(body));
    }
  }
  written.set(saveSections.functions, write(bodies.functions));
  written.set(
    saveSections.texts,
    new SaveWriter().list(texts.texts, (w, t) => w.text(t)).finish(),
  );
  const sections: SaveSection[] = [];
  for (const tag of Object.values(saveSections)) {
    const body = written.get(tag);
    if (body) {
      sections.push({ tag, body, optional: tag === saveSections.sources });
    }
  }
  return writeSave(header, sections);
};

/** A save of `records`, its values written with `io`. */
export const writeRecords = <V>(
  header: SaveHeader,
  records: SaveRecords<V>,
  io: ValueIO<V>,
  texts?: TextTable,
): Uint8Array => {
  const x = records;
  return writeSections(
    header,
    io,
    {
      group: w => w.group(x.group),
      libraries: w => w.libraries(x.libraries),
      objects: w => w.objects(x.objects),
      functions: w => w.functions(x.functions),
      calls: w => w.calls(x.calls),
      scripts: w => w.scripts(x.scripts),
      runs: w => w.runs(x.perScript, x.runs),
      work: w => w.work(x.work),
      waits: w => w.waits(x.waits),
      inputs: w => w.inputs(x.inputs),
      decisions: w => w.decisions(x.decisions),
      accounting: w => w.accounting(x.discards, x.changedRoots),
      ...(x.sources ? { sources: w => w.sources(x.sources!) } : {}),
    },
    texts,
  );
};
