// The TS Core's save: its Group's state as the shared save format's
// sections (ADR 0144, chapter 10). The Group gathers its state and rebuilds
// from what a restore reads; a Run's records are save-runs.ts's, wait state
// waits.ts's (ADR 0105).
import { HostError } from './errors';
import { costModel, languageVersion } from './generated/machine';
import type {
  Decision,
  Delivery,
  InputAction,
  Running,
  ScriptState,
} from './group';
import { identityOf, type Library } from './library';
import type { Code } from './machine';
import type { ObjectState } from './objects';
import type { AccountingState } from './run-accounting';
import {
  readSave,
  saveSections,
  SaveReader,
  stateFingerprint as headerFingerprint,
} from './save-format';
import { RecordReader } from './save-records';
import { skipValue } from './save-values';
import { operationsOf } from './manifest';
import type {
  DeliveryRecord,
  FunctionRecord,
  GroupRecord,
  Input,
  LibraryRecord,
  ObjectRecord,
  ScriptRecord,
  ValueIO,
  Mark,
  OpenBroadcast,
  ResumeRecord,
  Work,
} from './save-records';
import {
  deliveryNumber,
  deliveryRecord,
  limitNames,
  overrideRecord as override,
  runRecords,
  type RunPlaces,
} from './save-runs';
import {
  encodeSections,
  grantRecord,
  hexBytes,
  ValueWriter,
} from './save-state';
import type { Value } from './values';
import type { Waits } from './waits';

/** What a save reads from its Group. */
export type GroupSnapshot = {
  accounting: AccountingState;
  broadcasts: number;
  /** The roots whose work changed since the last accounting tail. */
  changedRoots: readonly number[];
  deliveries: number;
  discardedDecisions: Decision[];
  fingerprint: Uint8Array;
  inputs: readonly { action: InputAction; line: unknown; urgent?: boolean }[];
  /** Each Run's issued call numbers, by Run id. */
  issued: ReadonlyMap<string, readonly (readonly [number, number])[]>;
  lastClock: bigint | null;
  libraries: ReadonlyMap<string, Library>;
  name: string;
  objects: ReadonlyMap<string, ObjectState>;
  randomState: bigint;
  /** Each root's discarded messages, for the Group's lifetime. */
  rootDiscards: ReadonlyMap<number, number>;
  saves: number;
  scripts: readonly ScriptState[];
  sources: 'embedded' | 'external';
  /** How many waits have been set: the next wait's order. */
  waitOrder: number;
  waits: Waits<Running, ScriptState>;
};

/** A Group's save bytes. */
export const encodeGroup = (g: GroupSnapshot): Uint8Array => {
  const objectIndex = new Map<ObjectState, number>();
  for (const o of g.objects.values()) {
    objectIndex.set(o, objectIndex.size);
  }
  const libraryCodes = new Map<Code, number>();
  const libraryList = [...g.libraries.values()];
  const scriptUnits = new Map(g.scripts.map(s => [s.name, s.loaded.units]));
  const places: RunPlaces = {
    scriptUnits: name => scriptUnits.get(name),
    library: code => {
      if (!libraryCodes.size) {
        for (const s of g.scripts) {
          for (const unit of s.loaded.units) {
            collectLibraries(unit, libraryList, libraryCodes);
          }
        }
      }
      return libraryCodes.get(code);
    },
    object: o => (o ? objectIndex.get(o) : undefined),
  };
  const values = new ValueWriter(objectIndex, places);
  const ref = (o: ObjectState | null | undefined) =>
    o ? objectIndex.get(o) : undefined;
  const runs = runRecords(g, places);
  const delivery = (d: Delivery): DeliveryRecord<Value> =>
    deliveryRecord(d, ref);
  return encodeSections(
    {
      language: languageVersion,
      costModel: costModel.version,
      groupFingerprint: g.fingerprint,
      saveIdCounter: g.saves,
    },
    values,
    {
      group: w =>
        w.group({
          name: g.name,
          clock: clockOf(g.lastClock ?? 0n),
          deliveries: g.deliveries,
          broadcasts: g.broadcasts,
          timers: g.waitOrder,
          runOrder: g.accounting.next,
          chargeCounter: 0,
          randomState: g.randomState,
          issued: [...g.issued]
            .sort(([a], [b]) => compareBytes(a, b))
            .map(([run, ranges]) => ({
              run,
              ranges: ranges.map(([first, last]) => ({
                first,
                last,
                eligible: false,
              })),
            })),
        }),
      libraries: w =>
        w.libraries(
          libraryList.map(l => ({
            name: l.name,
            version: l.version,
            identity: l.identity,
          })),
        ),
      objects: w =>
        w.objects(
          [...g.objects.values()].map(o => ({
            kind: o.handle.kind.name,
            id: o.handle.id,
            parent: ref(o.parent),
            disposed: o.disposed,
            ownerOf:
              o.owner !== null &&
              g.scripts.some(s => s.name === o.owner && s.owner === o)
                ? o.owner
                : undefined,
          })),
        ),
      calls: w => w.calls(runs.calls),
      scripts: w =>
        w.scripts(
          g.scripts.map(s => ({
            name: s.name,
            identity: hexBytes(s.units[0]!.identity),
            extensions: s.units.slice(1).map(u => hexBytes(u.identity)),
            limits: limitNames.map(n => s.limits[n]),
            grants: [...s.grants].map(([name, grant]) =>
              grantRecord(
                name,
                grant,
                s.revoked.has(name),
                s.disabled.has(name),
              ),
            ),
            owner: ref(s.owner),
            objects: Object.entries(s.objects).map(([name, o]) => ({
              name,
              object: ref(o.value.asObjectRef()!.handle as ObjectState),
            })),
            variableNames: s.loaded.variableNames,
            variables: s.loaded.variables,
            definitions: s.loaded.units.flatMap(u => u.definitions),
            runs: s.runs,
            fuelTotal: s.fuelTotal,
            allocTotal: s.allocTotal,
            faults: s.faults,
            debt: s.debt,
            stopped: s.stopped ? (s.stopReason ?? '') : undefined,
          })),
        ),
      runs: w => w.runs(runs.perScript, runs.runs),
      work: w =>
        w.work(
          g.scripts.map(s =>
            s.queue.map((item): Work<Value> =>
              'run' in item
                ? { k: 'run', run: runs.index.get(item)! }
                : { k: 'message', delivery: delivery(item) },
            ),
          ),
        ),
      waits: w => w.waits(runs.waits),
      inputs: w =>
        w.inputs(g.inputs.map(x => inputRecord(x.action, delivery, ref))),
      decisions: w => w.decisions(decisionRecords(g)),
      accounting: w => {
        w.accounting(
          [...g.rootDiscards]
            .sort(([a], [b]) => a - b)
            .map(([root, discarded]) => ({ root, discarded })),
          g.changedRoots,
        );
      },
      ...(g.sources === 'embedded'
        ? {
            sources: w =>
              w.sources(
                g.scripts.map(s => ({
                  source: s.units[0]!.source,
                  extensions: s.units.slice(1).map(u => u.source),
                })),
              ),
          }
        : {}),
    },
  );
};

const compareBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const clockOf = (us: bigint) => {
  let seconds = us / 1_000_000n;
  let micros = us % 1_000_000n;
  if (micros < 0n) {
    micros += 1_000_000n;
    seconds -= 1n;
  }
  return { seconds, micros: Number(micros) };
};

const collectLibraries = (
  unit: Code,
  libraries: readonly Library[],
  out: Map<Code, number>,
) => {
  for (const [name, code] of unit.libraries) {
    if (out.has(code) || code.stdlib) {
      continue;
    }
    const at = libraries.findIndex(l => l.name === name);
    if (at >= 0) {
      out.set(code, at);
    }
    collectLibraries(code, libraries, out);
  }
};

const resumeOfSettlement = (action: InputAction): ResumeRecord<Value> => {
  switch (action.k) {
    case 'answer':
      return { k: 'answer', value: action.value, fuel: action.fuel };
    case 'fail':
      return action.error
        ? {
            k: 'failed',
            failure: {
              code: action.error.code,
              message: action.error.message || undefined,
              data:
                action.error.data === undefined
                  ? undefined
                  : (action.error.data as Value),
            },
          }
        : { k: 'broken', detail: action.detail };
    default:
      return { k: 'none' };
  }
};

const inputRecord = (
  action: InputAction,
  delivery: (d: Delivery) => DeliveryRecord<Value>,
  ref: (o: ObjectState | null | undefined) => number | undefined,
): Input<Value> => {
  switch (action.k) {
    case 'answer':
    case 'fail':
      return { k: 'settle', id: action.id, with: resumeOfSettlement(action) };
    case 'settle': {
      const s = action.settlement;
      return 'answer' in s
        ? {
            k: 'settlement',
            id: action.id,
            how: 0,
            with: { k: 'answer', value: s.answer, fuel: 0 },
          }
        : 'fail' in s
          ? {
              k: 'settlement',
              id: action.id,
              how: 1,
              with: resumeOfSettlement({
                k: 'fail',
                id: action.id,
                error: s.fail,
              }),
            }
          : {
              k: 'settlement',
              id: action.id,
              how: 'reissue' in s ? 2 : 3,
              with: { k: 'none' },
            };
    }
    case 'delivery':
      return {
        k: 'deliver',
        script: typeof action.to === 'string' ? action.to : '',
        delivery: delivery(action.delivery),
      };
    case 'set-parent':
      return {
        k: 'set parent',
        object: ref(action.child),
        parent: ref(action.up),
      };
    case 'dispose':
      return { k: 'dispose', object: ref(action.state) };
    case 'broadcast':
      return {
        k: 'broadcast',
        id: deliveryNumber(action.id),
        message: action.m.name,
        args: action.m.args ?? [],
        decision: !!action.decision,
        limits: override(action.m.limits ?? {}),
      };
    case 'revoke':
      return { k: 'revoke', script: action.name, grant: action.grant };
    case 'cancel-run':
      return { k: 'cancel run', run: action.id };
    case 'rewind-run':
      return { k: 'rewind run', run: action.id };
    case 'stop':
      return { k: 'stop', script: action.name, reason: action.reason };
    case 'cancel-delivery':
      return action.id.startsWith('b')
        ? { k: 'cancel broadcast', broadcast: deliveryNumber(action.id) }
        : { k: 'cancel delivery', delivery: deliveryNumber(action.id) };
    case 'refusal':
      throw new Error('A save never holds a queued refusal');
  }
};

const markOf = (
  r: NonNullable<Decision['ballots'][number]['result']>,
): Mark<Value> =>
  r.veto
    ? {
        script: r.veto.script,
        run: r.veto.run,
        reason: r.veto.reason,
        outcome: 'vetoed',
      }
    : {
        script: r.undecided!.script,
        run: r.undecided!.run ?? '',
        reason: undefined,
        outcome: r.undecided!.outcome,
      };

const decisionRecords = (g: GroupSnapshot) => {
  const open = new Map<string, Decision>();
  const visit = (d: Delivery | undefined) => {
    const decision = d?.ballot?.decision;
    if (decision?.broadcast && !decision.settled) {
      open.set(decision.id, decision);
    }
  };
  for (const s of g.scripts) {
    for (const item of s.queue) {
      visit('run' in item ? item.delivery : item);
    }
    for (const r of [...s.suspended, ...s.parked]) {
      visit(r.delivery);
    }
  }
  for (const x of g.inputs) {
    if (x.action.k === 'delivery') {
      visit(x.action.delivery);
    }
  }
  const records: OpenBroadcast<Value>[] = [...open.values()]
    .sort((a, b) => deliveryNumber(a.id) - deliveryNumber(b.id))
    .map(d => ({
      id: deliveryNumber(d.id),
      parts: d.ballots.map(b => ({
        delivery: deliveryNumber(b.delivery),
        part: !b.result
          ? { k: 'none' }
          : b.result.veto
            ? { k: 'vetoed', mark: markOf(b.result) }
            : b.result.undecided
              ? { k: 'undecided', mark: markOf(b.result) }
              : { k: 'allowed' },
      })),
    }));
  const deferred = g.discardedDecisions.flatMap(d =>
    d.ballots.map(b => ({
      id: deliveryNumber(b.delivery ?? (d.broadcast ? undefined : d.id)),
      broadcast: d.broadcast ? deliveryNumber(d.id) : 0,
      mark: b.result ? markOf(b.result) : undefined,
    })),
  );
  return { open: records, deferred };
};

/**
 * A Group's State Fingerprint: its save's, without the source mode or the
 * Trace save id counter (ADR 0142).
 */
export const stateFingerprint = (g: Omit<GroupSnapshot, 'sources'>) =>
  headerFingerprint(encodeGroup({ ...g, sources: 'external' }));

/** A save's State Fingerprint, without restoring it. */
export const saveStateFingerprint = (bytes: Uint8Array): Uint8Array =>
  readSave(bytes).stateFingerprint;

export const compareNames = (a: string, b: string) =>
  a < b ? -1 : a > b ? 1 : 0;
export const hexOf = (bytes: Uint8Array) =>
  [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

export { identityOf, saveSections };

/** A save as a restore's first pass reads it: everything but its values. */
export type DecodedSave = {
  costModel: number;
  functions: FunctionRecord[];
  group: GroupRecord;
  groupFingerprint: Uint8Array;
  language: string;
  libraries: LibraryRecord[];
  objects: ObjectRecord[];
  /** A section's reader, for the second pass. */
  reader(tag: number): SaveReader;
  saveIdCounter: number;
  scripts: ScriptRecord<undefined>[];
  sources: { extensions: string[]; source: string }[] | undefined;
};

const skipping: ValueIO<undefined> = {
  read: r => {
    skipValue(r);
    return undefined;
  },
  write: () => {},
};

/**
 * Reads a save's frames and the sections a restore needs before it can
 * load code: the Group's counters, Libraries, objects, functions, Scripts
 * and sources. Another magic, such as an old JSON save, is `invalid save`.
 */
export const decodeSave = (bytes: Uint8Array): DecodedSave => {
  const save = readSave(bytes);
  const tables = { calls: 0, libraries: 0, objects: 0, runs: 0 };
  const reader = (tag: number) => new SaveReader(save.body(tag)!);
  const section = <T>(
    tag: number,
    read: (r: RecordReader<undefined>) => T,
  ): T => {
    const r = new RecordReader(reader(tag), skipping, tables);
    const out = read(r);
    r.r.end();
    return out;
  };
  const group = section(saveSections.group, r => r.group());
  const libraries = section(saveSections.libraries, r => r.libraries());
  tables.libraries = libraries.length;
  const objects = section(saveSections.objects, r => r.objects());
  tables.objects = objects.length;
  const functions = section(saveSections.functions, r => r.functions());
  const scripts = section(saveSections.scripts, r => r.scripts());
  const sources = save.body(saveSections.sources)
    ? section(saveSections.sources, r => r.sources())
    : undefined;
  // Every other section's structure, so a save no Core could have written
  // fails before any Host callback runs.
  tables.calls = section(saveSections.calls, r => r.calls()).length;
  const { perScript, runs } = section(saveSections.runs, r => r.runs());
  tables.runs = runs.length;
  const work = section(saveSections.work, r => r.work());
  section(saveSections.waits, r => r.waits());
  section(saveSections.inputs, r => r.inputs());
  section(saveSections.decisions, r => r.decisions());
  section(saveSections.accounting, r => r.accounting());
  const names = new Set(scripts.map(s => s.name));
  if (
    names.size !== scripts.length ||
    perScript.length !== scripts.length ||
    work.length !== scripts.length ||
    perScript.reduce((a, b) => a + b, 0) !== runs.length
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
  if (sources && sources.length !== scripts.length) {
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
    scripts,
    sources,
    reader,
  };
};

export const invalidSave = (): never => {
  throw new HostError('invalid save');
};
