// Replaying a Trace Case (chapter 11): its Host Input lines drive a Group
// through the embedding interface, and the Trace the Group writes must equal
// the case's, ignoring comments and blank lines. Bless writes the Core's
// Trace back, keeping each comment and blank line before the Host Input line
// it preceded.
import { readDisplayText } from '../../src/readers';
import { replacementLibraries } from '../../src/library';
import corpus from '../../spec/data/corpus.toml';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compileLibrary,
  defineCapability,
  clockCapability,
  consoleCapability,
  calendarCapability,
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
  type Value,
} from '../../src/index';

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
  const keys = (records.get(name)?.key ?? []).map(k => k.key);
  // Each field starts at a known key followed by `=`, in corpus.toml's order.
  const starts: [number, string][] = [];
  let from = 0;
  for (const key of keys) {
    const at = rest.indexOf(`${key}=`, from);
    if (at >= 0 && (at === 0 || rest[at - 1] === ' ')) {
      starts.push([at, key]);
      from = at + key.length + 1;
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
const same = (expected: string, actual: string): boolean => {
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
};
type ObjectRefSpec = { id: string; kind: string };
type Setup = {
  libraries?: { name: string; source: string; version: string }[];
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
    grants?: Record<string, { capability?: string; ops: string[] | 'all' }>;
    grantsAsUsed?: boolean;
    limits?: Partial<Limits>;
    name: string;
    objects?: Record<string, ObjectRefSpec>;
    owner?: ObjectRefSpec;
    source: string;
  }[];
  standard?: {
    capability: string;
    costs: Record<string, { alloc?: number; fuel?: number }>;
  }[];
};

// A value in the display form, or a deferral for a kind this Core can't read yet.
const read = (
  text: string,
  resolve?: (kind: string, id: string) => HostObject | undefined,
): Value => {
  try {
    return readDisplay(text, resolve);
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

type Stub = { charge: number; error?: Value; value?: Value };
// The next Stub for an Operation: its value or its failure, after its charge.
const takeStub = (
  stubs: Map<string, Stub[]>,
  key: string,
  call: { charge(fuel: number): void },
  needed: boolean,
): Value => {
  const stub = stubs.get(key)?.shift();
  if (!stub) {
    if (needed) {
      throw new Error(`No Stub for ${key}`);
    }
    return nothing;
  }
  if (stub.charge) {
    call.charge(stub.charge);
  }
  if (stub.error) {
    const entries = stub.error.entries();
    if (!entries.length) {
      throw new Error(`The Stub for ${key} fails`);
    }
    const code = stub.error.get('code').asText() ?? '';
    const message = stub.error.get('message').asText() ?? '';
    throw new ScriptError(
      code,
      message,
      map(entries.filter(([k]) => k !== 'code' && k !== 'message')),
    );
  }
  return stub.value ?? nothing;
};

const fireStub = (
  stubs: Map<string, Stub[]>,
  key: string,
  call: Call<unknown>,
  crossing: (id: string) => void,
) => {
  try {
    takeStub(stubs, key, call, false);
  } finally {
    crossing(call.id);
  }
};

const startStub = (
  stubs: Map<string, Stub[]>,
  key: string,
  call: Call<unknown>,
  calls: Map<string, Call<unknown>>,
  crossing: (id: string) => void,
) => {
  const stub = stubs.get(key)?.shift();
  if (stub?.charge) {
    call.charge(stub.charge);
  }
  calls.set(call.id, call);
  crossing(call.id);
};

// The runner's Host functions (chapter 11, Stubs): an immediate call takes
// the next Stub for its Operation, and a fire-and-forget one takes one if
// there is one.
const capabilitiesOf = (
  setup: Setup,
  stubs: Map<string, Stub[]>,
  calls: Map<string, Call<unknown>>,
  crossing: (id: string) => void,
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
              start: call => startStub(stubs, key, call, calls, crossing),
            }
          : op.mode === 'immediate'
            ? {
                ...base,
                mode: 'immediate',
                do: call => {
                  try {
                    return takeStub(stubs, key, call, true);
                  } finally {
                    crossing(call.id);
                  }
                },
              }
            : {
                ...base,
                mode: 'fire-and-forget',
                fire: call => fireStub(stubs, key, call, crossing),
              };
    }
    out.set(name, defineCapability(name, operations));
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
            schedule: call => fireStub(stubs, 'timer.schedule', call, crossing),
            cancel: call => fireStub(stubs, 'timer.cancel', call, crossing),
          },
          costs,
        ),
      );
    } else if (capability === 'calendar') {
      const answer = (operation: string, call: Call<string>): Value => {
        try {
          return takeStub(stubs, `calendar.${operation}`, call, true);
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
    } else if (capability === 'console') {
      out.set(
        capability,
        consoleCapability(
          {
            write: call => fireStub(stubs, 'console.write', call, crossing),
            read: call =>
              startStub(stubs, 'console.read', call, calls, crossing),
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
  dir: string,
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
              source: readFileSync(resolve(dir, library.source), 'utf8'),
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

/** Replay a case's Host Inputs, giving the Trace the Core wrote. */
export const replay = (
  dir: string,
  setup: Setup,
  lines: readonly string[],
  { restoreBetweenPumps = false } = {},
): string[] => {
  const trace: string[] = [];
  let hidden = false;
  const adopted = new Set<string>();
  const saveNames = new Map<string, string>();
  let visibleSaves = 0;
  const writeTrace = (line: string) => {
    if (hidden) {
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
  let group = newGroup({ name: 'case', trace: writeTrace });
  // A Stop or CancelRun after a crossing is made from that Host function,
  // rather than a second time by the outer replay loop (chapter 11).
  const atCrossings = new Map<string, Parsed[][]>();
  const crossingLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith('call ') && !lines[i]!.startsWith('prop ')) {
      continue;
    }
    const record = parseRecord(lines[i]!);
    const key =
      record.name === 'call'
        ? record.ids[0]!
        : `${record.fields.get('object')}:${record.fields.get('name')}:${record.fields.get('op')}`;
    const inputs: Parsed[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j]!;
      if (!line || line.startsWith('#')) {
        j++;
        continue;
      }
      if (!line.startsWith('> stop ') && !line.startsWith('> cancel-run ')) {
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
  const value = (text: string) => read(text, resolveObject);
  const objectOf = (o: ObjectRefSpec): HostObject => {
    const found = resolveObject(o.kind, o.id);
    if (!found) {
      throw new Error(`case.toml has no object ${o.kind} ${o.id}`);
    }
    return found;
  };
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
                return (
                  props.get(`${o.kind.name} ${o.id}`)?.get(p.name) ?? nothing
                );
              },
              ...(p.readOnly
                ? {}
                : {
                    set: (o: HostObject<null>, v: Value) => {
                      props.get(`${o.kind.name} ${o.id}`)!.set(p.name, v);
                      crossing(`${o.value}:${p.name}:set`);
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
  const stubs = new Map<string, Stub[]>();
  // Each suspending call in flight, which `answer` and `fail` lines settle.
  const calls = new Map<string, Call<unknown>>();
  const capabilities = capabilitiesOf(setup, stubs, calls, crossing);
  const declarations = operationDeclarations(capabilities);
  const compiled = compileLibraries(dir, setup, declarations);
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
  for (const index of order) {
    const line = lines[index]!;
    if (crossingLines.has(index)) {
      continue;
    }
    if (!line.startsWith('> ')) {
      continue;
    }
    const r = parseRecord(line);
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
            grants[granted] = capability.grant(g.ops, undefined);
          }
          bound.set(script.name, grants);
          group.load({
            grants,
            grantsAsUsed: script.grantsAsUsed,
            name: script.name,
            source: readFileSync(resolve(dir, script.source), 'utf8'),
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
          group = restored.group;
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
        case 'pump':
          group.pump(parseInstant(r.fields.get('clock')!), {
            fuelSlice: r.fields.has('fuel-slice')
              ? Number(r.fields.get('fuel-slice'))
              : 0,
            fuelCap: r.fields.has('fuel-cap')
              ? Number(r.fields.get('fuel-cap'))
              : 0,
          });
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
                  line.startsWith('> call-value '),
              );
            hidden = true;
            const bytes = group.save();
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
                  !pending.has(parseRecord(line).ids[0]!),
              )
            ) {
              group = restored.group;
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
        case 'vars':
          group.inspect();
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
              read(r.fields.get('value')!),
              fuel ? { fuel } : undefined,
            );
          } else {
            const error = read(r.fields.get('error')!);
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
          stubs.set(op, [
            ...(stubs.get(op) ?? []),
            {
              charge: Number(r.fields.get('charge') ?? 0),
              ...(r.fields.has('value')
                ? { value: read(r.fields.get('value')!) }
                : {}),
              ...(r.fields.has('error')
                ? { error: read(r.fields.get('error')!) }
                : {}),
            },
          ]);
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
  }
  return trace;
};

export type TraceDivergence = {
  actual: string;
  context: string[];
  expected: string;
  line: number;
};

/** Run a Trace Case, or with `bless` write its case.trace from the Core's Trace. */
export const runTraceCase = (
  dir: string,
  setup: Setup,
  { bless = false } = {},
): { divergence?: TraceDivergence; lines: number } => {
  const path = resolve(dir, 'case.trace');
  const file = readFileSync(path, 'utf8').split('\n');
  if (file.at(-1) === '') {
    file.pop();
  }
  const actual = replay(dir, setup, file);
  const roundTripped = replay(dir, setup, file, { restoreBetweenPumps: true });
  if (actual.join('\n') !== roundTripped.join('\n')) {
    const at = actual.findIndex((line, i) => line !== roundTripped[i]);
    throw new Error(
      `Save/restore replay differs at output ${at + 1}:\nexpected ${actual[at]}\nactual ${roundTripped[at]}`,
    );
  }
  if (bless) {
    writeFileSync(path, blessed(file, actual));
    return { lines: actual.length };
  }
  const expected = file
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => text !== '' && !text.startsWith('#'));
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    const e = expected[i];
    const a = actual[i];
    if (!e || a === undefined || !same(e.text, a)) {
      return {
        lines: i,
        divergence: {
          line: e?.line ?? file.length + 1,
          expected: e?.text ?? '(end of the Trace)',
          actual: a ?? '(end of the Trace)',
          context: actual.slice(Math.max(0, i - 3), i),
        },
      };
    }
  }
  return { lines: actual.length };
};

// The Core's Trace, with each comment and blank line of the case kept before
// the Host Input line it preceded, and the case's trailing ones kept last.
const blessed = (
  file: readonly string[],
  actual: readonly string[],
): string => {
  const before: string[][] = [];
  let pending: string[] = [];
  for (const line of file) {
    if (line === '' || line.startsWith('#')) {
      pending.push(line);
    } else if (line.startsWith('> ')) {
      before.push(pending);
      pending = [];
    }
  }
  const out: string[] = [];
  let input = 0;
  for (const line of actual) {
    if (line.startsWith('> ')) {
      out.push(...(before[input++] ?? []));
    }
    out.push(line);
  }
  out.push(...pending);
  return `${out.join('\n')}\n`;
};

/** Whether a case's Trace says it was written by hand, not by bless. */
export const unblessed = (dir: string): boolean =>
  readFileSync(resolve(dir, 'case.trace'), 'utf8').includes('# Unblessed:');
