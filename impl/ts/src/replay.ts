import { MOCK_ARGUMENTS, type SessionHost } from './session';
// Browser-safe Trace replay shared by corpus tooling and the debugger.
// Only the supplied source reader performs I/O. Replay events add no Trace lines.
import { readDisplayText } from './readers';
import { Stubs, hostFailure, type Stub } from './session/stubs';
import { replacementLibraries } from './library';
import type { DebugPause } from './debug';
import type { PumpResult } from './group';
import corpus from '../../../spec/data/corpus.toml';
import {
  compileLibrary,
  defineCapability,
  clockCapability,
  consoleCapability,
  calendarCapability,
  localeCapability,
  timerCapability,
  defineObjectKind,
  type HostObject,
  shape,
  ScriptError,
  type Call,
  type FieldShape,
  type Grant,
  type GrantDecls,
  type CapabilityDef,
  type Operation,
  type Shape,
  type ScopeDecl,
  type SegmentContext,
  type EffectResult,
  HostError,
  LoadError,
  type Library,
  newGroup,
  restore,
  NotImplementedError,
  parseInstant,
  readDisplay,
  map,
  nothing,
  type Limits,
  type Group,
  type Value,
} from './index';

type RecordSpec = {
  ids?: string[];
  input: boolean;
  key?: { filled?: boolean; key: string }[];
  name: string;
};
const records = new Map<string, RecordSpec>(
  (corpus.record as RecordSpec[]).map(r => [r.name, r]),
);

/** A case uses a Host Input this Core doesn't implement yet. */
export class DeferredCaseError extends Error {
  override name = 'DeferredCaseError';
}

type Parsed = {
  fields: Map<string, string>;
  ids: string[];
  input: boolean;
  name: string;
};

/** A Trace line's record: its name, ids and key=value fields, by corpus.toml's keys. */
export const parseRecord = (line: string): Parsed => {
  const input = line.startsWith('> ');
  const body = input ? line.slice(2) : line;
  const space = body.indexOf(' ');
  const name = space < 0 ? body : body.slice(0, space);
  const rest = space < 0 ? '' : body.slice(space + 1);
  const keys = new Set((records.get(name)?.key ?? []).map(k => k.key));
  // Field markers occur only outside display Values. Host text may itself
  // contain known keys, and maps, lists and Function Values can nest them.
  const starts: [number, string][] = [];
  let quoted = false;
  let depth = 0;
  for (let at = 0; at < rest.length; at++) {
    const c = rest[at]!;
    if (quoted) {
      if (c === '\\') {
        at++;
      } else if (c === '"') {
        quoted = false;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if ('[{<'.includes(c)) {
      depth++;
    } else if (']}>'.includes(c)) {
      depth--;
    } else if (depth === 0 && (at === 0 || rest[at - 1] === ' ')) {
      const candidate = /^[a-z][a-z-]*=/.exec(rest.slice(at));
      if (candidate) {
        const key = candidate[0].slice(0, -1);
        if (keys.has(key)) {
          starts.push([at, key]);
        }
      }
    }
  }
  const head = starts.length
    ? rest.slice(0, starts[0]![0]).trim()
    : rest.trim();
  const ids = head ? head.split(' ') : [];
  const fields = new Map<string, string>();
  starts.forEach(([at, key], i) => {
    const end = i + 1 < starts.length ? starts[i + 1]![0] - 1 : rest.length;
    fields.set(key, rest.slice(at + key.length + 1, end));
  });
  return { name, ids, fields, input };
};

/**
 * Whether the Core's line matches the case's. A Host Input line may leave out
 * its `filled` keys and the ids the Core assigns.
 */
export const same = (expected: string, actual: string): boolean => {
  if (expected === actual) {
    return true;
  }
  if (!expected.startsWith('> ') || !actual.startsWith('> ')) {
    return false;
  }
  const e = parseRecord(expected);
  const a = parseRecord(actual);
  if (
    e.name !== a.name ||
    (e.ids.length && e.ids.join(' ') !== a.ids.join(' '))
  ) {
    return false;
  }
  const filled = new Set(
    (records.get(a.name)?.key ?? []).filter(k => k.filled).map(k => k.key),
  );
  for (const [key, value] of a.fields) {
    if (
      e.fields.get(key) !== value &&
      !(filled.has(key) && !e.fields.has(key))
    ) {
      return false;
    }
  }
  return [...e.fields.keys()].every(key => a.fields.has(key));
};

type ShapeSpec =
  | string
  | { quantity: string }
  | { unitKind: string }
  | { list: ShapeSpec }
  | { object: string }
  | { oneOf: ShapeSpec[] }
  | { optional: ShapeSpec }
  | {
      map: { key: string; optional?: boolean; shape: ShapeSpec }[];
      open?: boolean;
    };
type OperationSpec = {
  args?: ShapeSpec[];
  capability: string;
  cost?: { alloc?: number; fuel?: number };
  errors?: {
    code: string;
    fields?: { key: string; optional?: boolean; shape: ShapeSpec }[];
  }[];
  maxPending?: number;
  mode: 'immediate' | 'suspending' | 'fire-and-forget';
  name: string;
  result?: ShapeSpec;
  scope?: ScopeDecl;
  segmentBound?: boolean;
};
type ObjectRefSpec = { id: string; kind: string };
export type Setup = {
  /** Each Library's source file, or with `text`, the source itself. */
  libraries?: {
    name: string;
    source: string;
    text?: string;
    version: string;
  }[];
  objectKinds?: {
    name: string;
    parentKinds?: string[];
    props?: {
      getCost?: { alloc?: number; fuel: number };
      name: string;
      readOnly?: boolean;
      setCost?: { alloc?: number; fuel: number };
      shape?: ShapeSpec;
    }[];
  }[];
  objects?: { id: string; kind: string; props?: Record<string, string> }[];
  operations?: OperationSpec[];
  scripts?: {
    grants?: Record<
      string,
      { binding?: string; capability?: string; ops: string[] | 'all' }
    >;
    grantsAsUsed?: boolean;
    limits?: Partial<Limits>;
    name: string;
    objects?: Record<string, ObjectRefSpec>;
    owner?: ObjectRefSpec;
    /** Its source file, or with `text`, the source itself. */
    source: string;
    text?: string;
  }[];
  standard?: {
    capability: string;
    costs: Record<string, { alloc?: number; fuel?: number }>;
  }[];
};

const rememberFunctions = (value: Value, functions: Map<string, Value>) => {
  const work = [value];
  while (work.length) {
    const current = work.pop()!;
    if (current.kind === 'function') {
      functions.set(current.toString(), current);
      for (const [, value] of current.asFunction()!.captures) {
        work.push(value);
      }
    } else if (current.kind === 'list') {
      for (const value of valuesOf(current)) {
        work.push(value);
      }
    } else if (current.kind === 'map') {
      for (const [, value] of current.entries()) {
        work.push(value);
      }
    }
  }
};

// A value in the display form, or a deferral for a kind this Core can't read yet.
const read = (
  text: string,
  resolve?: (kind: string, id: string) => HostObject | undefined,
  resolveFunction?: (display: string) => Value | undefined,
): Value => {
  try {
    return readDisplay(text, resolve, resolveFunction);
  } catch (error) {
    throw new DeferredCaseError(
      `a value it can't read yet, ${text}: ${(error as Error).message}`,
    );
  }
};
const kinds: Record<string, Shape> = {
  any: shape.any,
  value: shape.value,
  nothing: shape.nothing,
  boolean: shape.bool,
  number: shape.number,
  text: shape.text,
  bytes: shape.bytes,
  instant: shape.instant,
  'civil date': shape.civilDate,
  range: shape.range,
  pattern: shape.pattern,
  function: shape.function,
};
// A Shape as case.toml writes it (chapter 11, The setup).
const shapeOf = (s: ShapeSpec): Shape => {
  if (typeof s === 'string') {
    const k = kinds[s];
    if (!k) {
      throw new Error(`Unknown Shape ${s}`);
    }
    return k;
  }
  if ('quantity' in s) {
    return shape.quantityOf(s.quantity);
  }
  if ('unitKind' in s) {
    return shape.quantityKind(s.unitKind);
  }
  if ('object' in s) {
    // Declarations name Object Kinds, including forward references in properties.
    return { k: 'object', kind: s.object };
  }
  if ('list' in s) {
    return shape.listOf(shapeOf(s.list));
  }
  if ('oneOf' in s) {
    return shape.oneOf(...s.oneOf.map(shapeOf));
  }
  if ('optional' in s) {
    return shape.optional(shapeOf(s.optional));
  }
  if ('map' in s) {
    const fields: Record<string, FieldShape> = Object.fromEntries(
      s.map.map(f => [
        f.key,
        f.optional
          ? { shape: shapeOf(f.shape), optional: true as const }
          : shapeOf(f.shape),
      ]),
    );
    return s.open ? shape.openMap(fields) : shape.map(fields);
  }
  throw new DeferredCaseError('Host Objects');
};

const fireStub = (
  stubs: Stubs,
  key: string,
  call: Call<unknown>,
  crossing: (id: string) => void,
  recorded?: Stub,
) => {
  try {
    stubs.take(key, call, false, recorded);
  } finally {
    crossing(call.id);
  }
};

const startStub = (
  stubs: Stubs,
  key: string,
  call: Call<unknown>,
  calls: Map<string, Call<unknown>>,
  crossing: (id: string) => void,
  recorded?: Stub,
) => {
  try {
    stubs.start(key, call, recorded);
    calls.set(call.id, call);
  } finally {
    crossing(call.id);
  }
};

// The runner's Host functions (chapter 11, Stubs): an immediate call takes
// the next Stub for its Operation, and a fire-and-forget one takes one if
// there is one.
const capabilitiesOf = (
  setup: Setup,
  stubs: Stubs,
  calls: Map<string, Call<unknown>>,
  crossing: (id: string) => void,
  receive: (value: Value) => void,
  recordedCall: (call: Call<unknown>) => Stub | undefined,
  lifecycle: (
    context: SegmentContext<unknown>,
    phase: 'begin' | 'commit' | 'rollback',
  ) => EffectResult,
): Map<string, ReturnType<typeof defineCapability>> => {
  const byCapability = new Map<string, OperationSpec[]>();
  for (const op of setup.operations ?? []) {
    byCapability.set(op.capability, [
      ...(byCapability.get(op.capability) ?? []),
      op,
    ]);
  }
  const out = new Map<string, ReturnType<typeof defineCapability>>();
  for (const [name, ops] of byCapability) {
    const operations: Record<string, Operation<unknown>> = {};
    for (const op of ops) {
      const key = `${name}.${op.name}`;
      const base = {
        args: (op.args ?? []).map(shapeOf),
        ...(op.scope === undefined ? {} : { scope: op.scope }),
        ...(op.segmentBound === undefined
          ? {}
          : { segmentBound: op.segmentBound }),
        cost: { fuel: op.cost?.fuel ?? 0, alloc: op.cost?.alloc ?? 0 },
        ...(op.result === undefined ? {} : { result: shapeOf(op.result) }),
        ...(op.errors
          ? {
              errors: op.errors.map(e => ({
                code: e.code,
                fields: Object.fromEntries(
                  (e.fields ?? []).map(f => [
                    f.key,
                    f.optional
                      ? { shape: shapeOf(f.shape), optional: true as const }
                      : shapeOf(f.shape),
                  ]),
                ),
              })),
            }
          : {}),
      };
      operations[op.name] =
        op.mode === 'suspending'
          ? {
              ...base,
              mode: 'suspending',
              ...(op.maxPending === undefined
                ? {}
                : { maxPendingMs: op.maxPending }),
              // Only a Stub's charge; `answer` and `fail` lines settle it.
              start: (call, ...args) => {
                args.forEach(receive);
                startStub(
                  stubs,
                  key,
                  call,
                  calls,
                  crossing,
                  recordedCall(call),
                );
              },
            }
          : op.mode === 'immediate'
            ? {
                ...base,
                mode: 'immediate',
                do: (call, ...args) => {
                  args.forEach(receive);
                  try {
                    return stubs.take(key, call, true, recordedCall(call));
                  } finally {
                    crossing(call.id);
                  }
                },
              }
            : {
                ...base,
                mode: 'fire-and-forget',
                fire: (call, ...args) => {
                  args.forEach(receive);
                  fireStub(stubs, key, call, crossing, recordedCall(call));
                },
              };
    }
    out.set(
      name,
      defineCapability(
        name,
        operations,
        ops.some(op => op.segmentBound)
          ? {
              begin: context => lifecycle(context, 'begin'),
              commit: context => lifecycle(context, 'commit'),
              rollback: context => lifecycle(context, 'rollback'),
            }
          : undefined,
      ),
    );
  }
  for (const standard of setup.standard ?? []) {
    const { capability } = standard;
    if (out.has(capability)) {
      throw new HostError(
        'invalid value',
        `Duplicate Capability ${capability}`,
      );
    }
    const costs = Object.fromEntries(
      Object.entries(standard.costs ?? {}).map(([name, cost]) => [
        name,
        {
          fuel: cost.fuel ?? 0,
          ...(cost.alloc === undefined ? {} : { alloc: cost.alloc }),
        },
      ]),
    );
    if (capability === 'clock') {
      const clock = clockCapability(costs);
      const op = clock.operations.get('now')!;
      if (op.mode === 'immediate') {
        out.set(
          capability,
          defineCapability('clock', {
            now: {
              ...op,
              do: call => {
                try {
                  return op.do({ ...call, binding: undefined });
                } finally {
                  crossing(call.id);
                }
              },
            },
          }),
        );
      }
    } else if (capability === 'timer') {
      out.set(
        capability,
        timerCapability(
          {
            schedule: call =>
              fireStub(
                stubs,
                'timer.schedule',
                call,
                crossing,
                recordedCall(call),
              ),
            cancel: call =>
              fireStub(
                stubs,
                'timer.cancel',
                call,
                crossing,
                recordedCall(call),
              ),
          },
          costs,
        ),
      );
    } else if (capability === 'calendar') {
      const answer = (operation: string, call: Call<string>): Value => {
        try {
          return stubs.take(
            `calendar.${operation}`,
            call,
            true,
            recordedCall(call),
          );
        } finally {
          crossing(call.id);
        }
      };
      out.set(
        capability,
        calendarCapability(
          {
            today: call => answer('today', call),
            now: call => answer('now', call),
            toCivil: call => answer('toCivil', call),
            toInstant: call => answer('toInstant', call),
            offset: call => answer('offset', call),
            zone: call => answer('zone', call),
          },
          costs,
        ),
      );
    } else if (capability === 'locale') {
      const answer = (operation: string, call: Call<string>): Value => {
        try {
          return stubs.take(
            `locale.${operation}`,
            call,
            true,
            recordedCall(call),
          );
        } finally {
          crossing(call.id);
        }
      };
      out.set(
        capability,
        localeCapability(
          {
            compare: call => answer('compare', call),
            rank: call => answer('rank', call),
            upper: call => answer('upper', call),
            lower: call => answer('lower', call),
            numberSymbols: call => answer('numberSymbols', call),
            monthNames: call => answer('monthNames', call),
            dayNames: call => answer('dayNames', call),
            tag: call => answer('tag', call),
          },
          costs,
        ),
      );
    } else if (capability === 'console') {
      out.set(
        capability,
        consoleCapability(
          {
            write: (call, value) => {
              receive(value);
              fireStub(
                stubs,
                'console.write',
                call,
                crossing,
                recordedCall(call),
              );
            },
            read: call =>
              startStub(
                stubs,
                'console.read',
                call,
                calls,
                crossing,
                recordedCall(call),
              ),
          },
          costs,
        ),
      );
    } else {
      throw new DeferredCaseError(`the Standard Capability ${capability}`);
    }
  }
  return out;
};

const valuesOf = (list: Value): Value[] =>
  Array.from({ length: list.length }, (_, i) => list.index(i + 1));

const operationDeclarations = (
  capabilities: ReadonlyMap<string, CapabilityDef<unknown>>,
): GrantDecls => {
  const declarations: Record<
    string,
    Record<string, { args: Shape[]; mode: OperationSpec['mode'] }>
  > = Object.create(null);
  for (const [name, capability] of capabilities) {
    declarations[name] = Object.fromEntries(
      [...capability.operations].map(([operation, op]) => [
        operation,
        { args: op.args ?? [], mode: op.mode },
      ]),
    );
  }
  return declarations;
};

// Every Library case.toml names, compiled once each Library it imports is, so
// in any order; one that never compiles keeps its LoadError.
const compileLibraries = (
  readSource: (file: string) => string,
  setup: Setup,
  declarations: GrantDecls,
): Map<string, Library | LoadError> => {
  const out = new Map<string, Library | LoadError>();
  let pending = setup.libraries ?? [];
  while (pending.length) {
    const failed: typeof pending = [];
    for (const library of pending) {
      try {
        const done = [...out.values()].filter(
          (l): l is Library => !(l instanceof LoadError),
        );
        out.set(
          library.name,
          compileLibrary(
            {
              ...library,
              source: library.text ?? readSource(library.source),
            },
            done,
            declarations,
          ),
        );
      } catch (error) {
        if (!(error instanceof LoadError)) {
          throw error;
        }
        out.set(library.name, error);
        failed.push(library);
      }
    }
    if (failed.length === pending.length) {
      break;
    }
    pending = failed;
  }
  return out;
};

const isCrossing = (line: string) => /^(call|prop|effect) /.test(line);

/** Replay a case's Host Inputs, giving the Trace the Core wrote. */
const driveReplay = function* (
  readSource: (file: string) => string,
  setup: Setup,
  lines: readonly string[],
  {
    restoreBetweenPumps = false,
    configureDebug,
    trace = [],
    incremental = false,
  }: {
    configureDebug?: (group: Group) => void;
    incremental?: boolean;
    restoreBetweenPumps?: boolean;
    trace?: string[];
  } = {},
): Generator<
  ReplayEvent | ReplayReady,
  string[],
  ReplayAction | string | undefined
> {
  let hidden = false;
  const hiddenTrace: string[] = [];
  const adopted = new Set<string>();
  const saveNames = new Map<string, string>();
  let visibleSaves = 0;
  const writeTrace = (line: string) => {
    if (hidden) {
      hiddenTrace.push(line);
      return;
    }
    if (restoreBetweenPumps && line.startsWith('> settle ')) {
      const r = parseRecord(line);
      if (r.fields.get('how') === 'adopt' && adopted.delete(r.ids[0]!)) {
        return;
      }
    }
    if (restoreBetweenPumps && line.startsWith('> save ')) {
      const actual = parseRecord(line).ids[0]!;
      const visible = `s${++visibleSaves}`;
      saveNames.set(actual, visible);
      line = `> save ${visible}`;
    } else if (restoreBetweenPumps && line.startsWith('> restore ')) {
      const actual = parseRecord(line).fields.get('from')!;
      line = line.replace(
        `from=${actual}`,
        `from=${saveNames.get(actual) ?? actual}`,
      );
    }
    trace.push(line);
  };
  const functions = new Map<string, Value>();
  const receive = (value: Value) => rememberFunctions(value, functions);
  let group = newGroup({ name: 'case', trace: writeTrace });
  configureDebug?.(group);
  const landedLines = new Set<number>();
  // A Stop or CancelRun after a crossing is made from that Host function,
  // rather than a second time by the outer replay loop (chapter 11).
  const atCrossings = new Map<string, Parsed[][]>();
  const crossingLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!isCrossing(lines[i]!)) {
      continue;
    }
    const record = parseRecord(lines[i]!);
    const key =
      record.name === 'call'
        ? record.ids[0]!
        : record.name === 'effect'
          ? `${record.ids[0]}.${record.fields.get('grant')}.${record.fields.get('phase')}`
          : `${record.fields.get('object')}:${record.fields.get('name')}:${record.fields.get('op')}`;
    const inputs: Parsed[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j]!;
      if (!line || line.startsWith('#')) {
        j++;
        continue;
      }
      // Finalization publishes scope/Segment/Run records before landing inputs
      // queued by its Host callback. Keep those inputs at the last crossing.
      if (!line.startsWith('> ')) {
        if (isCrossing(line) || line.startsWith('pumped ')) {
          break;
        }
        j++;
        continue;
      }
      if (!line.startsWith('> stop ') && !line.startsWith('> cancel-run ')) {
        break;
      }
      if (parseRecord(line).fields.has('pc')) {
        break;
      }
      inputs.push(parseRecord(line));
      crossingLines.add(j++);
    }
    const queue = atCrossings.get(key) ?? [];
    queue.push(inputs);
    atCrossings.set(key, queue);
  }
  const crossing = (key: string) => {
    for (const r of atCrossings.get(key)?.shift() ?? []) {
      if (r.name === 'stop') {
        group
          .script(r.ids[0]!)!
          .stop(readDisplay(r.fields.get('reason')!).asText()!);
      } else {
        group.script(r.ids[0]!.split('/r')[0]!)!.cancelRun(r.ids[0]!);
      }
    }
  };
  // The Host Objects case.toml lists, made before the first Host Input, with
  // their properties' values, which the runner's Get reads and Set writes.
  const made = new Map<string, HostObject>();
  const props = new Map<string, Map<string, Value>>();
  const resolveObject = (kind: string, id: string) => made.get(`${kind} ${id}`);
  const value = (text: string) =>
    read(text, resolveObject, display => functions.get(display));
  const objectOf = (o: ObjectRefSpec): HostObject => {
    const found = resolveObject(o.kind, o.id);
    if (!found) {
      throw new Error(`case.toml has no object ${o.kind} ${o.id}`);
    }
    return found;
  };
  const propertyRecords = new Map<string, Parsed[]>();
  const propertyFailure = (record: Parsed): void => {
    if (!record.fields.has('error')) {
      return;
    }
    const error = value(record.fields.get('error')!);
    if (!error.entries().length) {
      throw new Error('The recorded property call fails');
    }
    throw hostFailure(error);
  };
  for (const line of lines) {
    if (!line.startsWith('prop ')) {
      continue;
    }
    const record = parseRecord(line);
    const key = `${record.fields.get('object')}:${record.fields.get('name')}:${record.fields.get('op')}`;
    propertyRecords.set(key, [...(propertyRecords.get(key) ?? []), record]);
  }
  const kinds = new Map(
    (setup.objectKinds ?? []).map(k => [
      k.name,
      defineObjectKind<null>({
        name: k.name,
        ...(k.parentKinds ? { parentKinds: k.parentKinds } : {}),
        props: Object.fromEntries(
          (k.props ?? []).map(p => [
            p.name,
            {
              ...(p.shape === undefined ? {} : { shape: shapeOf(p.shape) }),
              ...(p.getCost ? { getCost: p.getCost } : {}),
              ...(p.setCost ? { setCost: p.setCost } : {}),
              get: (o: HostObject<null>) => {
                crossing(`${o.value}:${p.name}:get`);
                const record = propertyRecords
                  .get(`${o.value}:${p.name}:get`)
                  ?.shift();
                if (record) {
                  propertyFailure(record);
                }
                if (record) {
                  return record.fields.has('value')
                    ? value(record.fields.get('value')!)
                    : nothing;
                }
                return (
                  props.get(`${o.kind.name} ${o.id}`)?.get(p.name) ?? nothing
                );
              },
              ...(p.readOnly
                ? {}
                : {
                    set: (o: HostObject<null>, v: Value) => {
                      const record = propertyRecords
                        .get(`${o.value}:${p.name}:set`)
                        ?.shift();
                      try {
                        if (record) {
                          propertyFailure(record);
                        }
                        props.get(`${o.kind.name} ${o.id}`)!.set(p.name, v);
                      } finally {
                        crossing(`${o.value}:${p.name}:set`);
                      }
                    },
                  }),
            },
          ]),
        ),
      }),
    ]),
  );
  for (const o of setup.objects ?? []) {
    const kind = kinds.get(o.kind);
    if (!kind) {
      throw new Error(`case.toml has no Object Kind ${o.kind}`);
    }
    const handle = group.object(kind, o.id, null);
    made.set(`${o.kind} ${o.id}`, handle);
  }
  for (const o of setup.objects ?? []) {
    const handle = made.get(`${o.kind} ${o.id}`)!;
    props.set(
      `${handle.kind.name} ${handle.id}`,
      new Map(
        Object.entries(o.props ?? {}).map(([name, text]) => [
          name,
          value(text),
        ]),
      ),
    );
  }
  const messageOf = (r: Parsed) => ({
    name: r.fields.get('message')!,
    args: r.fields.has('args') ? valuesOf(value(r.fields.get('args')!)) : [],
    limits: r.fields.has('limits')
      ? Object.fromEntries(
          value(r.fields.get('limits')!)
            .entries()
            .map(([k, v]) => [k, Number(v.asDecimal()!.toString())]),
        )
      : undefined,
  });
  const stubs = new Stubs();
  const recordedCalls = new Map<string, Parsed[]>();
  const acknowledged = new Set<string>();
  const recordedEffects = new Map<string, EffectResult[]>();
  for (const line of lines) {
    if (line.startsWith('call ')) {
      const r = parseRecord(line);
      recordedCalls.set(r.ids[0]!, [
        ...(recordedCalls.get(r.ids[0]!) ?? []),
        r,
      ]);
    } else if (line.startsWith('scope ')) {
      const r = parseRecord(line);
      if (['opened', 'closed'].includes(r.fields.get('action')!)) {
        acknowledged.add(r.ids[0]!);
      }
    } else if (line.startsWith('effect ')) {
      const r = parseRecord(line);
      const key = `${r.ids[0]}.${r.fields.get('grant')}.${r.fields.get('phase')}`;
      recordedEffects.set(key, [
        ...(recordedEffects.get(key) ?? []),
        { status: r.fields.get('status') as EffectResult['status'] },
      ]);
    }
  }
  let malformed: Error | undefined;
  const lifecycle = (
    context: SegmentContext<unknown>,
    phase: 'begin' | 'commit' | 'rollback',
  ): EffectResult => {
    const grant = `${context.scriptName}.${context.grantName}`;
    const recorded = recordedEffects
      .get(`${context.segmentId}.${context.grantName}.${phase}`)
      ?.shift();
    const result = stubs.takeEffect(grant, phase) ?? recorded;
    if (!result) {
      malformed = new Error(`No lifecycle Stub for ${grant} phase=${phase}`);
      throw malformed;
    }
    crossing(`${context.segmentId}.${context.grantName}.${phase}`);
    return result;
  };
  const recordedCall = (call: Call<unknown>): Stub | undefined => {
    const r = recordedCalls.get(call.id)?.shift();
    if (!r) {
      return undefined;
    }
    return {
      charge: Number(r.fields.get('charged') ?? 0),
      ...(r.fields.has('result')
        ? { value: value(r.fields.get('result')!) }
        : {}),
      ...(r.fields.has('error')
        ? acknowledged.has(call.id)
          ? { malformed: true }
          : { error: value(r.fields.get('error')!) }
        : {}),
    };
  };
  // Each suspending call in flight, which `answer` and `fail` lines settle.
  const calls = new Map<string, Call<unknown>>();
  const capabilities = capabilitiesOf(
    setup,
    stubs,
    calls,
    crossing,
    receive,
    recordedCall,
    lifecycle,
  );
  const declarations = operationDeclarations(capabilities);
  const compiled = compileLibraries(readSource, setup, declarations);
  // A mailbox refusal is written before the accepted inputs still waiting
  // for the Pump. Replay those first so the same depth check can refuse it.
  const order: number[] = [];
  let refused: number[] = [];
  for (const [index, line] of lines.entries()) {
    let following = index + 1;
    while (
      following < lines.length &&
      (!lines[following] || lines[following]!.startsWith('#'))
    ) {
      following++;
    }
    const next = lines[following];
    if (line.startsWith('> ') && next === 'refused code="mailbox full"') {
      refused.push(index);
      continue;
    }
    if (line.startsWith('> pump ')) {
      order.push(...refused);
      refused = [];
    }
    order.push(index);
  }
  order.push(...refused);
  let registered = new Map<string, Library>();
  const saved = new Map<string, Uint8Array>();
  const bound = new Map<string, Record<string, Grant<unknown>>>();
  for (let cursor = 0; ; cursor++) {
    if (cursor === order.length) {
      if (!incremental) {
        break;
      }
      const input = yield {
        state: 'ready',
        group,
        callIds: [...calls.keys()],
        saveIds: [...saved.keys()],
      };
      if (input === undefined) {
        break;
      }
      if (!input.startsWith('> ')) {
        throw new Error('Expected a concrete Host Input');
      }
      order.push(lines.length);
      lines = [...lines, input];
    }
    const index = order[cursor]!;
    const line = lines[index]!;
    if (crossingLines.has(index) || landedLines.has(index)) {
      continue;
    }
    if (!line.startsWith('> ')) {
      continue;
    }
    const r = parseRecord(line);
    const hostInputIndex = lines
      .slice(0, index)
      .filter(l => l.startsWith('> ')).length;
    yield { state: 'input', hostInputIndex, group };
    try {
      switch (r.name) {
        case 'load': {
          const script = setup.scripts?.find(s => s.name === r.ids[0]);
          if (!script) {
            throw new Error(`case.toml has no Script ${r.ids[0]}`);
          }
          const grants: Record<string, Grant<unknown>> = Object.create(null);
          for (const [granted, g] of Object.entries(script.grants ?? {})) {
            const capability = capabilities.get(g.capability ?? granted);
            if (!capability) {
              throw new DeferredCaseError(
                `the Standard Capability ${g.capability ?? granted}`,
              );
            }
            grants[granted] = capability.grant(
              g.ops,
              g.binding ?? (capability.name === 'locale' ? 'und' : undefined),
            );
          }
          bound.set(script.name, grants);
          group.load({
            grants,
            grantsAsUsed: script.grantsAsUsed,
            name: script.name,
            source: script.text ?? readSource(script.source),
            limits: script.limits,
            objects: Object.fromEntries(
              Object.entries(script.objects ?? {}).map(([name, o]) => [
                name,
                objectOf(o),
              ]),
            ),
            ...(script.owner ? { owner: objectOf(script.owner) } : {}),
          });
          break;
        }
        case 'add-library': {
          const l = compiled.get(r.ids[0] ?? '');
          if (!l) {
            throw new Error(`case.toml has no Library ${r.ids[0]}`);
          }
          if (l instanceof LoadError) {
            throw l;
          }
          group.addLibrary(l);
          registered.set(l.name, l);
          break;
        }
        case 'reload':
          group
            .script(r.ids[0]!)!
            .reload(
              readDisplayText(r.fields.get('source')!),
              r.fields.get('carry') === 'yes'
                ? 'carry variables'
                : 'reset variables',
            );
          break;
        case 'extend':
          group
            .script(r.ids[0]!)!
            .extend(readDisplayText(r.fields.get('source')!));
          break;
        case 'replace-library': {
          const name = r.ids[0]!;
          const previous = registered.get(name)!;
          const library = compileLibrary(
            {
              name,
              version: previous.version,
              source: readDisplayText(r.fields.get('source')!),
            },
            [...registered.values()],
            declarations,
          );
          group.replaceLibrary(
            library,
            r.fields.get('carry') === 'yes'
              ? 'carry variables'
              : 'reset variables',
          );
          registered = replacementLibraries(registered, library);
          break;
        }
        case 'set-parent': {
          const parent = r.fields.get('parent');
          group.setParent(
            value(r.fields.get('object')!).asObject()!,
            parent ? value(parent).asObject() : undefined,
          );
          break;
        }
        case 'dispose':
          group.dispose(value(r.fields.get('object')!).asObject()!);
          break;
        case 'call-value': {
          const m = messageOf(r);
          group.call(value(r.fields.get('fn')!), m.args, { limits: m.limits });
          break;
        }
        case 'deliver':
        case 'request':
        case 'decide': {
          const named = r.fields.get('to') ?? '';
          // A Delivery to a Host Object routes to its nearest Owning Script.
          const object = named.startsWith('<object ')
            ? value(named).asObject()!
            : null;
          const to = object ? null : group.script(named);
          if (!object && !to) {
            throw new DeferredCaseError(`a Delivery to ${named}`);
          }
          const message = messageOf(r);
          if (object) {
            if (r.name === 'deliver') {
              group.deliver(object, message);
            } else if (r.name === 'decide') {
              group.decide(object, message);
            } else {
              group.request(object, message);
            }
          } else if (r.name === 'deliver') {
            to!.deliver(message);
          } else if (r.name === 'decide') {
            to!.decide(message);
          } else {
            to!.request(message);
          }
          break;
        }
        case 'decide-broadcast':
          group.decideBroadcast(messageOf(r));
          break;
        case 'broadcast':
          group.broadcast(messageOf(r));
          break;
        case 'cancel-delivery':
          group.cancelDelivery(r.ids[0]!);
          break;
        case 'cancel-run':
          group.script(r.ids[0]!.split('/r')[0]!)!.cancelRun(r.ids[0]!);
          break;
        case 'stop':
          group
            .script(r.ids[0]!)!
            .stop(value(r.fields.get('reason')!).asText()!);
          break;
        case 'revoke':
          group.script(r.ids[0]!)!.revoke(r.fields.get('grant')!);
          break;
        case 'save': {
          const bytes = group.save();
          saved.set(parseRecord(trace.at(-1)!).ids[0]!, bytes);
          break;
        }
        case 'restore': {
          const from = r.fields.get('from') ?? [...saved.keys()].at(-1)!;
          const ids = (field: string) =>
            (r.fields.get(field) ?? '[]')
              .slice(1, -1)
              .split(', ')
              .filter(Boolean);
          const unbound = new Set(ids('unbound'));
          const withheld = new Set(ids('withheld'));
          const disposed = r.fields.has('disposed')
            ? valuesOf(value(r.fields.get('disposed')!)).map(v => v.toString())
            : [];
          const restored = restore(saved.get(from)!, {
            name: 'case',
            trace: writeTrace,
            libraries: [...registered.values()].filter(
              l => !withheld.has(l.name),
            ),
            grants: (script, name) =>
              unbound.has(`${script}.${name}`)
                ? undefined
                : bound.get(script)?.[name],
            resolve: (kind, id) => {
              const handle = made.get(`${kind} ${id}`);
              return !handle || disposed.includes(handle.value.toString())
                ? undefined
                : { native: handle.native };
            },
            onMismatch:
              r.fields.get('mismatch') === 'variables-only'
                ? 'variables only'
                : 'reject',
          });
          if (restoreBetweenPumps) {
            // A restore rewinds the visible Save counter as well as the Core's
            // counter, which may include hidden successful or refused attempts.
            visibleSaves = Number(from.slice(1));
          }
          group = restored.group;
          configureDebug?.(group);
          registered = new Map(
            [...registered].filter(([name]) => !withheld.has(name)),
          );
          for (const [key, handle] of made) {
            made.set(key, group.objectById(handle.kind.name, handle.id)!);
          }
          break;
        }
        case 'settle': {
          const id = r.ids[0]!;
          const how = r.fields.get('how');
          const error =
            how === 'fail' ? value(r.fields.get('error')!) : nothing;
          const call = group.settle(
            id,
            how === 'answer'
              ? { answer: value(r.fields.get('value')!) }
              : how === 'fail'
                ? {
                    fail: new ScriptError(
                      error.get('code').asText()!,
                      error.get('message').asText() ?? '',
                      map(
                        error
                          .entries()
                          .filter(
                            ([key]) => key !== 'code' && key !== 'message',
                          ),
                      ),
                    ),
                  }
                : how === 'adopt'
                  ? { adopt: true }
                  : { reissue: true },
          );
          if (call) {
            calls.set(id, call);
          }
          break;
        }
        case 'pump': {
          const landings: {
            input: Parsed;
            inputIndex: number;
            line: number;
            run: string;
          }[] = [];
          let inputIndex = lines
            .slice(0, index + 1)
            .filter(l => l.startsWith('> ')).length;
          for (
            let j = index + 1;
            j < lines.length && !lines[j]!.startsWith('pumped ');
            j++
          ) {
            const line = lines[j]!;
            if (!line.startsWith('> ')) {
              continue;
            }
            const input = parseRecord(line);
            if (
              (input.name === 'stop' || input.name === 'cancel-run') &&
              input.fields.has('pc')
            ) {
              const segment = lines
                .slice(j + 1)
                .find(l => l.startsWith('seg '));
              if (!segment) {
                throw new Error('Early Host Input has no executing Segment');
              }
              landings.push({
                line: j,
                input,
                inputIndex,
                run: parseRecord(segment).ids[0]!,
              });
            }
            inputIndex++;
          }
          const armLanding = () => {
            const next = landings[0];
            if (next) {
              group.debug().landAt(next.inputIndex, {
                pc: Number(next.input.fields.get('pc')),
                run: next.run,
              });
            }
          };
          armLanding();
          let pumped = group.pump(parseInstant(r.fields.get('clock')!), {
            fuelSlice: r.fields.has('fuel-slice')
              ? Number(r.fields.get('fuel-slice'))
              : 0,
            fuelCap: r.fields.has('fuel-cap')
              ? Number(r.fields.get('fuel-cap'))
              : 0,
          });
          while (group.debug().isPaused) {
            const action = yield {
              state: 'paused',
              hostInputIndex,
              group,
              pause: group.debug().current!,
            };
            if (group.debug().current?.reason === 'replay') {
              const landing = landings.shift()!;
              const input = landing.input;
              if (input.name === 'stop') {
                group
                  .script(input.ids[0]!)!
                  .stop(value(input.fields.get('reason')!).asText()!);
              } else {
                group
                  .script(input.ids[0]!.split('/r')[0]!)!
                  .cancelRun(input.ids[0]!);
              }
              landedLines.add(landing.line);
              armLanding();
            }
            if (
              action !== undefined &&
              !['resume', 'step', 'stepOver', 'stepOut'].includes(action)
            ) {
              throw new Error('Expected a replay debugger action');
            }
            pumped = group.debug()[(action ?? 'resume') as ReplayAction]()!;
          }
          if (landings.length) {
            throw new Error(
              'Early Host Input did not reach its replay instruction',
            );
          }
          if (malformed) {
            throw malformed;
          }
          yield { state: 'pumped', hostInputIndex, group, result: pumped };
          // Inputs made synchronously inside a Host callback cannot suspend that
          // callback. Expose their completed, safe Pump boundary for seeking.
          for (
            let j = index + 1;
            j < lines.length && !lines[j]!.startsWith('pumped ');
            j++
          ) {
            if (crossingLines.has(j)) {
              yield {
                state: 'input',
                applied: true,
                hostInputIndex: lines
                  .slice(0, j)
                  .filter(l => l.startsWith('> ')).length,
                group,
              };
            }
          }
          for (const report of pumped.reports) {
            if (report.kind === 'run end') {
              if (report.result) {
                receive(report.result);
              }
              if (report.error) {
                receive(report.error.data);
              }
            }
          }
          if (
            restoreBetweenPumps &&
            lines.slice(index + 1).some(line => line.startsWith('> pump ')) &&
            // An explicit save/restore case already exercises this boundary;
            // hidden adoption must not become a visible queued settlement.
            !lines
              .slice(
                index + 1,
                lines.findIndex(
                  (line, j) => j > index && line.startsWith('> pump '),
                ),
              )
              .some(
                line =>
                  line.startsWith('> save ') || line.startsWith('> restore '),
              )
          ) {
            // A later input using a nonpending old Call or cancellation handle
            // belongs to the old Group; chapter 11 excludes these boundaries.
            const future = lines
              .slice(index + 1)
              .filter(
                line =>
                  line.startsWith('> answer ') ||
                  line.startsWith('> fail ') ||
                  line.startsWith('> cancel-delivery ') ||
                  line.startsWith('> call-value ') ||
                  (line.startsWith('> ') && line.includes('<function ')),
              );
            hidden = true;
            hiddenTrace.length = 0;
            let bytes: Uint8Array;
            const inspection = () =>
              JSON.stringify(group.inspect(), (_key, value) =>
                typeof value === 'bigint' ? String(value) : value,
              );
            const before = inspection();
            hiddenTrace.length = 0;
            try {
              bytes = group.save();
            } catch (error) {
              if (
                !(error instanceof HostError) ||
                error.code !== 'effects pending'
              ) {
                throw error;
              }
              if (
                hiddenTrace.length !== 2 ||
                !hiddenTrace[0]!.startsWith('> save ') ||
                hiddenTrace[1] !== 'refused code="effects pending"'
              ) {
                throw new Error('Refused Save changed execution');
              }
              if (inspection() !== before) {
                throw new Error('Refused Save changed Group state');
              }
              hidden = false;
              break;
            }
            const restored = restore(bytes, {
              name: 'case',
              trace: writeTrace,
              libraries: [...registered.values()],
              grants: (script, name) => bound.get(script)?.[name],
              resolve: (kind, id) => ({
                native: made.get(`${kind} ${id}`)!.native,
              }),
              onMismatch: 'reject',
            });
            hidden = false;
            const pending = new Set(restored.result.pending.map(p => p.id));
            if (
              !future.some(
                line =>
                  line.startsWith('> cancel-delivery ') ||
                  line.startsWith('> call-value ') ||
                  line.includes('<function ') ||
                  !pending.has(parseRecord(line).ids[0]!),
              )
            ) {
              group = restored.group;
              configureDebug?.(group);
              for (const [key, handle] of made) {
                made.set(key, group.objectById(handle.kind.name, handle.id)!);
              }
              for (const p of restored.result.pending) {
                calls.set(p.id, group.settle(p.id, { adopt: true })!);
                adopted.add(p.id);
              }
            }
          }
          break;
        }
        case 'counters':
          group.script(r.ids[0]!)!.counters();
          break;
        case 'vars':
          for (const script of group.inspect().scripts) {
            for (const [, value] of script.vars) {
              receive(value);
            }
          }
          break;
        case 'answer':
        case 'fail': {
          const call = calls.get(r.ids[0] ?? '');
          if (!call) {
            throw new DeferredCaseError('settling a call after a restore');
          }
          if (r.name === 'answer') {
            const fuel = Number(r.fields.get('fuel') ?? 0);
            call.answer(
              value(r.fields.get('value')!),
              fuel ? { fuel } : undefined,
            );
          } else {
            const error = value(r.fields.get('error')!);
            const entries = error.entries();
            call.fail(
              entries.length
                ? new ScriptError(
                    error.get('code').asText() ?? '',
                    error.get('message').asText() ?? '',
                    map(
                      entries.filter(([k]) => k !== 'code' && k !== 'message'),
                    ),
                  )
                : (new Error('not a Script error') as ScriptError),
            );
          }
          break;
        }
        case 'stub': {
          // The runner's, written where the case has it; the Core never sees it.
          const op = r.ids[0]!;
          if (
            op === 'clock.now' &&
            setup.standard?.some(s => s.capability === 'clock')
          ) {
            throw new Error('clock.now uses the Pump Clock, not a Stub');
          }
          stubs.add(op, {
            charge: Number(r.fields.get('charge') ?? 0),
            ...(r.fields.has('value')
              ? { value: value(r.fields.get('value')!) }
              : {}),
            ...(r.fields.has('error')
              ? { error: value(r.fields.get('error')!) }
              : {}),
          });
          trace.push(line);
          break;
        }
        case 'stub-effect': {
          const phase = r.fields.get('phase')!;
          const status = r.fields.get('status')!;
          if (
            !['begin', 'commit', 'rollback'].includes(phase) ||
            !['ok', 'failed', 'unknown'].includes(status)
          ) {
            throw new Error('Invalid lifecycle Stub');
          }
          stubs.addEffect(r.ids[0]!, phase, {
            status: status as EffectResult['status'],
          });
          trace.push(line);
          break;
        }
        default:
          throw new DeferredCaseError(`the Host Input ${r.name}`);
      }
    } catch (error) {
      if (hidden) {
        throw error;
      }
      if (
        error instanceof LoadError ||
        (error instanceof Error && error.name === 'MailboxFull') ||
        error instanceof HostError
      ) {
        continue;
      }
      if (error instanceof NotImplementedError) {
        throw new DeferredCaseError(error.message);
      }
      throw error;
    }
    if (malformed) {
      throw malformed;
    }
  }
  return trace;
};

type ReplayReady = {
  callIds: string[];
  group: Group;
  saveIds: string[];
  state: 'ready';
};

/** Replay a fixed Trace, including recorded Host crossings and debugger landings. */
export const replayTrace = function* (
  readSource: (file: string) => string,
  setup: Setup,
  lines: readonly string[],
  options: {
    configureDebug?: (group: Group) => void;
    restoreBetweenPumps?: boolean;
    trace?: string[];
  } = {},
): Generator<ReplayEvent, string[], ReplayAction | undefined> {
  const driver = driveReplay(readSource, setup, lines, options);
  let next = driver.next();
  while (!next.done) {
    if (next.value.state === 'ready') {
      throw new Error('Unexpected incremental replay boundary');
    }
    next = driver.next(yield next.value);
  }
  return next.value;
};

/** Non-normative incremental Host for generated cases. No hidden Inspect calls. */
export const createReplayHost = (
  readSource: (file: string) => string,
  setup: Setup,
) => {
  const trace: string[] = [];
  const driver = driveReplay(readSource, setup, [], {
    incremental: true,
    trace,
  });
  let ready = driver.next().value as ReplayReady;
  return {
    trace,
    get group() {
      return ready.group;
    },
    get callIds(): readonly string[] {
      return ready.callIds;
    },
    get saveIds(): readonly string[] {
      return ready.saveIds;
    },
    apply(input: string): PumpResult | undefined {
      let pumped: PumpResult | undefined;
      let next = driver.next(input);
      while (!next.done && next.value.state !== 'ready') {
        if (next.value.state === 'pumped') {
          pumped = next.value.result;
        }
        if (next.value.state === 'paused') {
          throw new Error('Incremental Host cannot pause for debugging');
        }
        next = driver.next();
      }
      if (next.done) {
        throw new Error('Incremental replay Host has ended');
      }
      ready = next.value as ReplayReady;
      return pumped;
    },
  };
};

export type ReplayAction = 'resume' | 'step' | 'stepOver' | 'stepOut';
export type ReplayEvent = { group: Group; hostInputIndex: number } & (
  | { applied?: boolean; state: 'input' }
  | { pause: DebugPause; state: 'paused' }
  | { result: PumpResult; state: 'pumped' }
);
// The Session Host's Group, as a Trace Case sets it up: the Session Script
// loaded from empty source, granted `console`, whose Operations cost nothing,
// each mock Operation and built-in Capability, under every name it was
// granted, and each user Library as it was added.
export const sessionSetup = (host: SessionHost): Setup => {
  const { granted, mocks } = host.grants;
  return {
    libraries: host.userLibraries.map(l => ({
      name: l.name,
      version: l.version,
      source: '(inline)',
      text: l.source,
    })),
    operations: [
      ...extensionOperations(host),
      ...mocks.map(m => ({
        capability: m.capability,
        name: m.operation,
        mode: m.mode,
        args: Array.from({ length: MOCK_ARGUMENTS }, () => ({
          optional: 'any',
        })),
        ...(m.mode === 'fire-and-forget' ? {} : { result: 'any' }),
        cost: { fuel: 0 },
      })),
    ],
    scripts: [
      {
        name: 'session',
        source: '(empty)',
        text: '',
        grants: {
          console: { ops: 'all' },
          ...Object.fromEntries(
            Object.entries(granted).map(([name, capability]) => [
              name,
              { capability, ops: 'all' as const },
            ]),
          ),
        },
      },
    ],
    standard: [
      {
        capability: 'console',
        costs: { write: { fuel: 0 }, read: { fuel: 0 } },
      },
      ...(Object.values(granted).includes('clock')
        ? [{ capability: 'clock', costs: { now: { fuel: 0 } } }]
        : []),
    ],
  };
};

// Carry custom declarations into Trace replay; replay supplies recorded outcomes.
const shapeSpec = (s: Shape): ShapeSpec => {
  switch (s.k) {
    case 'kind':
      return s.kind;
    case 'any':
    case 'value':
      return s.k;
    case 'quantity':
      return { quantity: s.unit };
    case 'unitKind':
      return { unitKind: s.kind };
    case 'object':
      return { object: s.kind };
    case 'list':
      return { list: shapeSpec(s.of) };
    case 'oneOf':
      return { oneOf: s.of.map(shapeSpec) };
    case 'optional':
      return { optional: shapeSpec(s.of) };
    case 'map':
      return {
        map: s.fields.map(f => ({
          key: f.key,
          optional: f.optional,
          shape: shapeSpec(f.shape),
        })),
        open: s.open,
      };
  }
};
const extensionOperations = (host: SessionHost): OperationSpec[] => {
  const granted = new Set(Object.values(host.grants.granted));
  return host.extensionCapabilities
    .filter(c => granted.has(c.name))
    .flatMap(c =>
      [...c.operations].map(([name, op]) => ({
        capability: c.name,
        name,
        mode: op.mode,
        args: (op.args ?? []).map(shapeSpec),
        cost: op.cost,
        ...(op.result ? { result: shapeSpec(op.result) } : {}),
        ...(op.errors
          ? {
              errors: op.errors.map(e => ({
                code: e.code,
                fields: Object.entries(e.fields ?? {}).map(([key, field]) => ({
                  key,
                  ...('shape' in field
                    ? { optional: true, shape: shapeSpec(field.shape) }
                    : { shape: shapeSpec(field) }),
                })),
              })),
            }
          : {}),
      })),
    );
};
