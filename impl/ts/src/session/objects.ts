// Session object transport (session-observation.md). The adapter records real
// callback boundaries; playback still uses the Core's Shape checks and costs.
import {
  defineObjectKind,
  type ObjectKind,
  type ObjectKindDef,
  type HostObject,
} from '../objects';
import { HostError, ScriptError } from '../errors';
import {
  sessionReply,
  observeValues,
  type Group,
  type Report,
  type Message,
  type LimitOverride,
} from '../group';
import { shape, type Shape, type Cost } from '../capabilities';
import { canonicalJSON, shapeData } from '../manifest';
import { encodeValue, quoteJSON } from '../encoding';
import {
  decodeValue,
  JsonObject,
  JsonNumber,
  readOrderedJSON,
  type Json,
} from '../readers';
import { compareText } from '../text';
import { Value, listValues } from '../values';
import type { TranscriptItem } from './transcript';

export type ObjectReference = { id: string; kind: string };
export type Envelope = Record<string, unknown> & { type: string };
const encodedJSON = Symbol('session Value Encoding');
const encoded = (json: string) => ({ [encodedJSON]: json });
const isJsonObject = (j: unknown): j is JsonObject =>
  !!j && typeof j === 'object' && 'kind' in j && j.kind === 'object';
const isJsonNumber = (j: unknown): j is JsonNumber =>
  !!j && typeof j === 'object' && 'kind' in j && j.kind === 'number';
class TranscriptError extends Error {}
const malformed = (detail: string): never => {
  throw new TranscriptError(`Malformed Transcript: ${detail}`);
};
const recordObject = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return malformed('expected object');
  }
  return raw as Record<string, unknown>;
};
const exact = (raw: unknown, required: string[], optional: string[] = []) => {
  const obj = recordObject(raw);
  if (
    required.some(k => !(k in obj)) ||
    Object.keys(obj).some(k => ![...required, ...optional].includes(k))
  ) {
    malformed('missing or extra fields');
  }
  return obj;
};
const string = (raw: unknown): string =>
  typeof raw === 'string' ? raw : malformed('expected text');
const counter = (raw: unknown): bigint => {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    return BigInt(raw);
  }
  if (
    typeof raw === 'string' &&
    /^[1-9]\d*$/.test(raw) &&
    BigInt(raw) >= 2n ** 53n
  ) {
    return BigInt(raw);
  }
  return malformed('invalid counter');
};
const integer = (n: bigint) => (n < 2n ** 53n ? Number(n) : n.toString());
const ref = (raw: unknown): ObjectReference => {
  const o = exact(raw, ['kind', 'id']);
  const kind = string(o.kind),
    id = string(o.id);
  if (!kind) {
    malformed('empty kind');
  }
  return { kind, id };
};
const identity = (o: ObjectReference) => `${o.kind}\u0000${o.id}`;
const serialize = (raw: unknown): string => {
  if (raw && typeof raw === 'object' && encodedJSON in raw) {
    return raw[encodedJSON] as string;
  }
  if (Array.isArray(raw)) {
    return `[${raw.map(serialize).join(',')}]`;
  }
  if (raw && typeof raw === 'object') {
    return `{${Object.entries(raw)
      .sort(([a], [b]) => compareText(a, b))
      .map(([k, v]) => `${quoteJSON(k)}:${serialize(v)}`)
      .join(',')}}`;
  }
  return canonicalJSON(raw);
};
// Ordered JSON nodes are retained at Value positions, including numeric map keys.
const jsonSource = (j: Json): string =>
  isJsonObject(j)
    ? `{${j.pairs.map(([k, v]) => `${quoteJSON(k)}:${jsonSource(v)}`).join(',')}}`
    : isJsonNumber(j)
      ? j.source
      : Array.isArray(j)
        ? `[${j.map(jsonSource).join(',')}]`
        : canonicalJSON(j);
const plain = (j: Json): unknown =>
  isJsonObject(j)
    ? Object.fromEntries(j.pairs.map(([k, v]) => [k, plain(v)]))
    : isJsonNumber(j)
      ? Number(j.source)
      : Array.isArray(j)
        ? j.map(plain)
        : j;
export const parseEnvelope = (source: string): Envelope => {
  const raw = readOrderedJSON(source);
  if (!isJsonObject(raw)) {
    malformed('envelope must be object');
  }
  const obj = plain(raw) as Envelope;
  const fields: Record<string, [string[], string[]?]> = {
    kind: [['type', 'name', 'props', 'parentKinds']],
    object: [['type', 'object']],
    setup: [['type', 'objects']],
    'property-begin': [
      ['type', 'crossing', 'object', 'property', 'operation'],
      ['value'],
    ],
    'property-end': [['type', 'crossing', 'reply']],
    input: [['type', 'request', 'reply']],
    function: [['type', 'handle', 'exposure', 'path']],
    resolve: [['type', 'objects']],
  };
  const f = fields[obj.type];
  if (!f) {
    return malformed('unknown envelope type');
  }
  exact(obj, f[0], f[1]);
  // Validate nested framing before replay. Value trees are decoded at the crossing.
  if (obj.type === 'object' || obj.type === 'property-begin') {
    ref(obj.object);
  }
  if (obj.type === 'property-begin') {
    counter(obj.crossing);
    string(obj.property);
    if (
      !['get', 'set'].includes(string(obj.operation)) ||
      'value' in obj !== (obj.operation === 'set')
    ) {
      malformed('invalid property operation');
    }
  }
  if (obj.type === 'property-end') {
    counter(obj.crossing);
    const r = recordObject(obj.reply);
    if (
      Object.keys(r).length !== 1 ||
      !['value', 'ok', 'fail', 'hostError'].includes(Object.keys(r)[0]!)
    ) {
      malformed('invalid property reply');
    }
    if (
      ('ok' in r && r.ok !== true) ||
      ('hostError' in r && r.hostError !== true)
    ) {
      malformed('invalid property reply flag');
    }
    if ('fail' in r) {
      validateFailure(r.fail);
    }
  }
  if (obj.type === 'input') {
    validateRequest(obj.request);
    const reply = recordObject(obj.reply);
    if (Object.keys(reply).length !== 1) {
      malformed('invalid input reply');
    }
    if ('ok' in reply) {
      const ok = exact(reply.ok, [], ['delivery', 'broadcast']);
      if (Object.keys(ok).length > 1) {
        malformed('invalid input reply');
      }
      for (const v of Object.values(ok)) {
        string(v);
      }
    } else {
      string(exact(reply, ['error']).error);
    }
  }
  if (obj.type === 'function') {
    if (!/^f[1-9]\d*$/.test(string(obj.handle))) {
      malformed('invalid function handle');
    }
    counter(obj.exposure);
    if (
      !Array.isArray(obj.path) ||
      obj.path.some(
        p =>
          typeof p !== 'string' &&
          !(typeof p === 'number' && Number.isSafeInteger(p) && p >= 0),
      )
    ) {
      malformed('invalid path');
    }
  }
  if (obj.type === 'setup') {
    for (const o of Object.values(recordObject(obj.objects))) {
      ref(o);
    }
  }
  if (obj.type === 'resolve') {
    if (!Array.isArray(obj.objects)) {
      malformed('invalid resolver outcomes');
    }
    for (const o of obj.objects as unknown[]) {
      const r = exact(o, ['object', 'resolved']);
      ref(r.object);
      if (typeof r.resolved !== 'boolean') {
        malformed('invalid resolved');
      }
    }
  }
  if (obj.type === 'kind') {
    if (!string(obj.name)) {
      malformed('empty kind');
    }
    if (
      !Array.isArray(obj.props) ||
      !Array.isArray(obj.parentKinds) ||
      obj.parentKinds.some(p => typeof p !== 'string')
    ) {
      malformed('invalid kind');
    }
    const names = new Set<string>();
    for (const p of obj.props as unknown[]) {
      const r = exact(p, ['name', 'shape', 'readOnly', 'getCost'], ['setCost']);
      const name = string(r.name);
      if (!name || names.has(name)) {
        malformed('duplicate/empty property');
      }
      names.add(name);
      if (typeof r.readOnly !== 'boolean' || 'setCost' in r === r.readOnly) {
        malformed('invalid property declaration');
      }
      decodeShape(r.shape);
      for (const k of ['getCost', ...(!r.readOnly ? ['setCost'] : [])]) {
        validateCost(r[k]);
      }
    }
  }
  // Keep all JSON subtrees: raw values must retain insertion order.
  Object.defineProperty(obj, 'raw', { value: raw });
  return obj;
};
const nodeAt = (envelope: Envelope, ...path: (string | number)[]): Json => {
  let raw = (envelope as Envelope & { raw?: Json }).raw;
  if (!raw) {
    return readOrderedJSON(
      serialize(
        path.reduce<unknown>(
          (o, k) =>
            Array.isArray(o) && typeof k === 'number'
              ? o[k]
              : recordObject(o)[k],
          envelope,
        ),
      ),
    );
  }
  for (const key of path) {
    raw =
      typeof key === 'number' && Array.isArray(raw)
        ? raw[key]
        : isJsonObject(raw)
          ? raw.pairs.find(([k]) => k === key)?.[1]
          : undefined;
    if (raw === undefined) {
      return malformed('missing Value');
    }
  }
  return raw;
};
const validateCost = (raw: unknown): Cost => {
  const c = exact(raw, ['fuel', 'alloc']);
  if (
    ![c.fuel, c.alloc].every(
      n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0,
    )
  ) {
    malformed('invalid cost');
  }
  return c as Cost;
};
const nonnegative = (raw: unknown): number =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
    ? raw
    : malformed('invalid nonnegative integer');
const validateLimits = (raw: unknown) => {
  for (const n of Object.values(
    exact(raw, [], ['fuelPerRun', 'allocPerRun', 'maxWaitMs', 'maxJoin']),
  )) {
    nonnegative(n);
  }
};
const validateFailure = (raw: unknown) => {
  const f = exact(raw, ['code', 'message', 'data']);
  string(f.code);
  string(f.message);
};
const actionFields: Record<string, [string[], string[]?]> = {
  'set-parent': [['kind', 'object', 'parent']],
  dispose: [['kind', 'object']],
  deliver: [['kind', 'to', 'message']],
  request: [['kind', 'to', 'message']],
  'cancel-delivery': [['kind', 'delivery']],
  broadcast: [['kind', 'message']],
  call: [['kind', 'fn', 'args'], ['limits']],
  decide: [
    ['kind', 'message'],
    ['to', 'broadcast'],
  ],
  answer: [['kind', 'call', 'value'], ['fuel']],
  fail: [['kind', 'call', 'error']],
  settle: [['kind', 'call', 'settlement']],
  stop: [['kind', 'script', 'reason']],
  'cancel-run': [['kind', 'script', 'run']],
  revoke: [['kind', 'script', 'grant']],
};
const validateRequest = (raw: unknown): Record<string, unknown> => {
  const request = recordObject(raw),
    kind = string(request.kind),
    fields = actionFields[kind];
  if (!fields) {
    return malformed('forbidden Host action');
  }
  exact(request, fields[0], fields[1]);
  if ('object' in request) {
    ref(request.object);
  }
  if ('parent' in request && request.parent !== null) {
    ref(request.parent);
  }
  if ('to' in request) {
    const to = recordObject(request.to);
    if (Object.keys(to).length !== 1) {
      malformed('invalid target');
    }
    if ('script' in to) {
      string(to.script);
    } else {
      ref(exact(to, ['object']).object);
    }
  }
  if (
    kind === 'decide' &&
    ('to' in request === 'broadcast' in request ||
      ('broadcast' in request && request.broadcast !== true))
  ) {
    malformed('invalid decision target');
  }
  if ('message' in request) {
    const m = exact(request.message, ['name'], ['args', 'limits']);
    string(m.name);
    if ('args' in m && !Array.isArray(m.args)) {
      malformed('invalid message arguments');
    }
    if ('limits' in m) {
      validateLimits(m.limits);
    }
  }
  if ('args' in request && !Array.isArray(request.args)) {
    malformed('invalid arguments');
  }
  if ('limits' in request) {
    validateLimits(request.limits);
  }
  if ('fuel' in request) {
    nonnegative(request.fuel);
  }
  for (const k of ['script', 'run', 'grant', 'delivery', 'call', 'reason']) {
    if (k in request) {
      string(request[k]);
    }
  }
  if ('error' in request) {
    validateFailure(request.error);
  }
  if ('settlement' in request) {
    const s = recordObject(request.settlement);
    if (Object.keys(s).length !== 1) {
      malformed('invalid settlement');
    }
    const k = Object.keys(s)[0]!;
    if (!['answer', 'fail', 'reissue', 'adopt'].includes(k)) {
      malformed('invalid settlement');
    }
    if (k === 'fail') {
      validateFailure(s.fail);
    }
    if ((k === 'adopt' || k === 'reissue') && s[k] !== true) {
      malformed('invalid settlement flag');
    }
  }
  return request;
};
export const decodeShape = (raw: unknown): Shape => {
  if (typeof raw === 'string') {
    if (raw === 'any') {
      return shape.any;
    }
    if (raw === 'value') {
      return shape.value;
    }
    if (
      ![
        'nothing',
        'boolean',
        'number',
        'text',
        'bytes',
        'instant',
        'civil date',
        'range',
        'pattern',
        'function',
      ].includes(raw)
    ) {
      return malformed('invalid scalar Shape');
    }
    return { k: 'kind', kind: raw };
  }
  const obj = recordObject(raw);
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const k = keys[0]!;
    const v = obj[k];
    if (k === 'list' || k === 'optional') {
      return { k, of: decodeShape(v) };
    }
    if (k === 'oneOf' && Array.isArray(v)) {
      return { k, of: v.map(decodeShape) };
    }
    if (k === 'object') {
      return { k, kind: string(v) };
    }
    if (k === 'quantity') {
      return { k, unit: string(v) };
    }
    if (k === 'unitKind') {
      return { k, kind: string(v) };
    }
  }
  exact(obj, ['map'], ['open']);
  if (!Array.isArray(obj.map) || ('open' in obj && obj.open !== true)) {
    return malformed('invalid map Shape');
  }
  const fields = obj.map.map(raw => {
    const f = exact(raw, ['key', 'shape'], ['optional']);
    if ('optional' in f && f.optional !== true) {
      malformed('invalid optional field');
    }
    return {
      key: string(f.key),
      shape: decodeShape(f.shape),
      optional: f.optional === true,
    };
  });
  if (new Set(fields.map(f => f.key)).size !== fields.length) {
    malformed('duplicate Shape field');
  }
  return { k: 'map', fields, open: obj.open === true };
};

/** Host adapters use this context for object registration and external actions. */
export class SessionObjects {
  private group!: Group;
  readonly items: TranscriptItem[] = [];
  private kinds = new Map<string, ObjectKind>();
  private declarations = new Map<string, string>();
  private objects = new Map<string, HostObject>();
  private crossing = 0n;
  private exposure = 0n;
  private handle = 0n;
  private handles = new Map<string, Value>();
  private supplied = new WeakMap<Value, string>();
  private replay:
    | {
        consumed: boolean;
        envelope: Envelope;
        index: number;
        item: TranscriptItem;
      }[]
    | null;
  private active = false;
  private failure: Error | null = null;
  private traceSaves = new Map<string, { id?: string; kind: string }[]>();
  private queuedTraceActions: { id?: string; kind: string }[] = [];
  constructor(
    private readonly record: (item: TranscriptItem) => void,
    private readonly recorded?: readonly TranscriptItem[],
    private enabled = true,
  ) {
    this.replay = recorded
      ? recorded
          .filter(i => i.k === 'envelope')
          .map(item => ({
            item,
            index: recorded.indexOf(item),
            envelope: parseEnvelope((item as { json: string }).json),
            consumed: false,
          }))
      : null;
  }
  attach(group: Group) {
    group[observeValues](tree => this.expose(tree));
    this.group = group;
    for (const [key, o] of this.objects) {
      const restored = group.objectById(o.kind.name, o.id);
      if (restored) {
        this.objects.set(key, restored);
      }
    }
  }
  private next(): Envelope {
    const next = this.replay?.find(r => !r.consumed);
    if (!next) {
      return malformed('missing envelope');
    }
    return next.envelope;
  }
  private consume(type: string): Envelope {
    const r = this.replay?.find(r => !r.consumed);
    if (!r || r.envelope.type !== type) {
      return malformed(`expected ${type}`);
    }
    r.consumed = true;
    this.items.push(r.item);
    this.record(r.item);
    return r.envelope;
  }
  private emit(e: Envelope) {
    const item: TranscriptItem = { k: 'envelope', json: serialize(e) };
    this.items.push(item);
    this.record(item);
  }
  private commandCursor = 0;
  private beforeCommand(name: string) {
    const index = this.recorded?.findIndex(
      (item, i) =>
        i >= this.commandCursor &&
        item.k === 'input' &&
        (item.source === `:${name}` ||
          item.source.startsWith(`:${name} `) ||
          (name === 'vars' && this.describeSnapshot(i))),
    );
    if (index === undefined || index < 0) {
      return;
    }
    this.commandCursor = index + 1;
    while (true) {
      const row = this.replay?.find(r => !r.consumed);
      if (!row || row.index >= index) {
        break;
      }
      if (row.envelope.type === 'input') {
        this.replayInput(true);
      } else if (row.envelope.type === 'kind') {
        this.registerKind(row.envelope);
      } else if (row.envelope.type === 'object') {
        this.registerObject(row.envelope);
      } else {
        malformed('unmatched crossing before command');
      }
    }
  }
  // A variable describe produces a vars Input; declaration-only lookups have
  // no passive value row and therefore consume no snapshot boundary.
  private describeSnapshot(index: number): boolean {
    const item = this.recorded?.[index];
    if (item?.k !== 'input' || !item.source.startsWith(':describe ')) {
      return false;
    }
    for (const row of this.recorded!.slice(index + 1)) {
      if (row.k === 'input') {
        break;
      }
      if (row.k === 'output' && row.text.startsWith('value ')) {
        return true;
      }
    }
    return false;
  }
  traceInput(name: string, ids: readonly string[] = []): boolean {
    if (['save', 'restore', 'vars'].includes(name)) {
      this.beforeCommand(name);
    }
    this.registrations();
    const operation =
      name === 'call-value'
        ? 'call'
        : name === 'decide-broadcast'
          ? 'decide'
          : name;
    const queued = this.queuedTraceActions.findIndex(
      a => a.kind === operation && (!a.id || a.id === ids[0]),
    );
    if (queued >= 0) {
      this.queuedTraceActions.splice(queued, 1);
      return true;
    }
    if (
      this.nextType() !== 'input' ||
      recordObject(this.next().request).kind !== operation
    ) {
      return false;
    }
    this.replayInput();
    return true;
  }
  traceObjects(): HostObject[] {
    return [...this.objects.values()];
  }
  private registrations() {
    while (this.replay && ['kind', 'object'].includes(this.nextType() ?? '')) {
      const e = this.next();
      if (e.type === 'kind') {
        this.registerKind(e);
      } else {
        this.registerObject(e);
      }
    }
  }
  private nextType() {
    return this.replay?.find(r => !r.consumed)?.envelope.type;
  }
  preload(): Record<string, HostObject> {
    this.registrations();
    if (this.nextType() !== 'setup') {
      if (this.replay?.length) {
        malformed('missing setup');
      }
      return {};
    }
    const e = this.consume('setup');
    return Object.fromEntries(
      Object.entries(recordObject(e.objects)).map(([name, o]) => [
        name,
        this.objectRef(o),
      ]),
    );
  }
  initial(bindings: Record<string, HostObject>) {
    if (this.replay) {
      return;
    }
    // An empty legacy Session needs no envelopes.
    if (!this.enabled) {
      return;
    }
    this.emit({
      type: 'setup',
      objects: Object.fromEntries(
        Object.entries(bindings).map(([k, o]) => [
          k,
          { kind: o.kind.name, id: o.id },
        ]),
      ),
    });
  }
  defineKind<N>(definition: ObjectKindDef<N>): ObjectKind<N> {
    const props = Object.entries(definition.props)
      .sort(([a], [b]) => compareText(a, b))
      .map(([name, p]) => ({
        name,
        shape: p.shape ? shapeData(p.shape) : 'any',
        readOnly: !p.set,
        getCost: { fuel: p.getCost?.fuel ?? 0, alloc: p.getCost?.alloc ?? 0 },
        ...(p.set
          ? {
              setCost: {
                fuel: p.setCost?.fuel ?? 0,
                alloc: p.setCost?.alloc ?? 0,
              },
            }
          : {}),
      }));
    const declaration = {
      type: 'kind',
      name: definition.name,
      props,
      parentKinds: definition.parentKinds ?? [],
    };
    const encoded = serialize(declaration);
    const old = this.declarations.get(definition.name);
    if (old) {
      if (old !== encoded) {
        malformed('conflicting kind registration');
      }
      return this.kinds.get(definition.name) as ObjectKind<N>;
    }
    const wrapped = Object.fromEntries(
      Object.entries(definition.props).map(([name, p]) => [
        name,
        {
          ...p,
          get: (o: HostObject<N>) =>
            this.property(o, name, 'get', () => p.get(o)),
          ...(p.set
            ? {
                set: (o: HostObject<N>, v: Value) => {
                  this.property(
                    o,
                    name,
                    'set',
                    () => {
                      p.set!(o, v);
                      return undefined;
                    },
                    v,
                  );
                },
              }
            : {}),
        },
      ]),
    );
    const kind = defineObjectKind({ ...definition, props: wrapped });
    this.kinds.set(kind.name, kind as ObjectKind);
    this.declarations.set(kind.name, encoded);
    if (!this.replay) {
      this.emit(declaration);
    }
    return kind;
  }
  object<N>(kind: ObjectKind<N>, id: string, native: N): HostObject<N> {
    if (this.kinds.get(kind.name) !== kind) {
      malformed('kind must be registered through SessionObjects');
    }
    const key = identity({ kind: kind.name, id });
    const old = this.objects.get(key);
    if (old) {
      if (old.kind !== kind) {
        malformed('conflicting object');
      }
      return old as HostObject<N>;
    }
    const o = this.group.object(kind, id, native);
    this.objects.set(key, o as HostObject);
    if (!this.replay) {
      this.emit({ type: 'object', object: { kind: kind.name, id } });
    }
    return o;
  }
  private registerKind(e: Envelope) {
    this.consume('kind');
    const name = string(e.name);
    if (this.kinds.has(name)) {
      return malformed('duplicate kind registration');
    }
    const props = Object.fromEntries(
      (e.props as Record<string, unknown>[]).map(p => [
        string(p.name),
        {
          shape: decodeShape(p.shape),
          getCost: validateCost(p.getCost),
          get: () => {
            throw new Error('external getter in replay');
          },
          ...(!p.readOnly
            ? { setCost: validateCost(p.setCost), set: () => {} }
            : {}),
        },
      ]),
    );
    this.defineKind({ name, parentKinds: e.parentKinds as string[], props });
  }
  private registerObject(e: Envelope) {
    this.consume('object');
    const r = ref(e.object);
    if (this.objects.has(identity(r))) {
      malformed('duplicate object registration');
    }
    const kind = this.kinds.get(r.kind);
    if (!kind) {
      return malformed('unknown kind');
    }
    this.object(kind, r.id, {});
  }
  private objectRef(raw: unknown) {
    const r = ref(raw);
    return this.objects.get(identity(r)) ?? malformed('unknown object');
  }
  private property<N>(
    o: HostObject<N>,
    name: string,
    operation: 'get' | 'set',
    callback: () => Value | undefined,
    value?: Value,
  ): Value {
    try {
      return this.propertyCrossing(o, name, operation, callback, value);
    } catch (error) {
      if (this.replay && error instanceof TranscriptError) {
        this.failure = error;
      }
      throw error;
    }
  }
  private propertyCrossing<N>(
    o: HostObject<N>,
    name: string,
    operation: 'get' | 'set',
    callback: () => Value | undefined,
    value?: Value,
  ): Value {
    if (this.active) {
      return malformed('reentrant property callback');
    }
    if (operation === 'set') {
      this.expose(listValues([value!]));
    }
    const crossing = ++this.crossing;
    const begin: Envelope = {
      type: 'property-begin',
      crossing: integer(crossing),
      object: { kind: o.kind.name, id: o.id },
      property: name,
      operation,
      ...(value ? { value: encoded(this.encode(value)) } : {}),
    };
    if (this.replay) {
      const e = this.consume('property-begin');
      if (
        serialize({
          ...e,
          ...(value ? { value: encoded(jsonSource(nodeAt(e, 'value'))) } : {}),
        }) !== serialize(begin)
      ) {
        malformed('unmatched property crossing');
      }
      this.active = true;
      try {
        while (['kind', 'object', 'input'].includes(this.nextType() ?? '')) {
          if (this.nextType() === 'input') {
            this.replayInput();
          } else {
            this.registrations();
          }
        }
        const end = this.consume('property-end');
        if (counter(end.crossing) !== crossing) {
          malformed('out-of-order property end');
        }
        const reply = recordObject(end.reply);
        if ('value' in reply) {
          if (operation !== 'get') {
            malformed('value for setter');
          }
          return this.decode(nodeAt(end, 'reply', 'value'));
        }
        if ('ok' in reply) {
          if (operation !== 'set' || reply.ok !== true) {
            malformed('invalid ok');
          }
          return undefined as unknown as Value;
        }
        if ('fail' in reply) {
          const f = exact(reply.fail, ['code', 'message', 'data']);
          throw new ScriptError(
            string(f.code),
            string(f.message),
            this.decode(nodeAt(end, 'reply', 'fail', 'data')),
          );
        }
        throw new Error('Recorded Host property failure');
      } catch (error) {
        if (error instanceof TranscriptError) {
          this.failure = error;
        }
        throw error;
      } finally {
        this.active = false;
      }
    }
    this.emit(begin);
    this.active = true;
    try {
      const result = callback();
      this.emit({
        type: 'property-end',
        crossing: integer(crossing),
        reply:
          operation === 'get'
            ? { value: encoded(this.encode(result!)) }
            : { ok: true },
      });
      return result as Value;
    } catch (error) {
      this.emit({
        type: 'property-end',
        crossing: integer(crossing),
        reply:
          error instanceof ScriptError
            ? {
                fail: {
                  code: error.code,
                  message: error.message,
                  data: encoded(this.encode(error.data)),
                },
              }
            : { hostError: true },
      });
      throw error;
    } finally {
      this.active = false;
    }
  }
  encode(value: Value): string {
    if (value.kind === 'object') {
      const o = value.asObjectRef()!;
      if (!this.objects.has(identity(o))) {
        malformed('object must be registered through SessionObjects');
      }
    }
    if (value.kind === 'function') {
      const handle = this.supplied.get(value);
      if (!handle || !this.handles.has(handle)) {
        return malformed('unexposed or invalidated function');
      }
      return `{"$sessionFunction":${quoteJSON(handle)}}`;
    }
    if (value.kind === 'list') {
      return `[${Array.from({ length: value.length }, (_, i) => this.encode(value.index(i + 1))).join(',')}]`;
    }
    if (value.kind === 'map') {
      const ps = value.entries();
      const tagged = ps.some(([k]) => k.startsWith('$'));
      return tagged
        ? `{"$map":[${ps.map(([k, v]) => `[${quoteJSON(k)},${this.encode(v)}]`).join(',')}]}`
        : `{${ps.map(([k, v]) => `${quoteJSON(k)}:${this.encode(v)}`).join(',')}}`;
    }
    return encodeValue(value);
  }
  private decode(raw: Json): Value {
    try {
      return decodeValue(
        jsonSource(raw),
        (kind, id) => this.objectRef({ kind, id }).value,
        h => this.handles.get(h) ?? malformed('unresolved function handle'),
      );
    } catch (error) {
      return malformed(
        `invalid crossing Value: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  expose(tree: unknown) {
    const exposure = ++this.exposure;
    if (!this.enabled) {
      return;
    }
    const walk = (raw: unknown, path: (string | number)[]) => {
      if (Value.isValue(raw)) {
        if (raw.kind === 'function') {
          const handle = `f${++this.handle}`;
          if (this.replay) {
            const e = this.consume('function');
            if (
              e.handle !== handle ||
              counter(e.exposure) !== exposure ||
              serialize(e.path) !== serialize(path)
            ) {
              malformed('invalid function exposure/path');
            }
          } else {
            this.emit({
              type: 'function',
              handle,
              exposure: integer(exposure),
              path,
            });
          }
          this.handles.set(handle, raw);
          this.supplied.set(raw, handle);
        } else if (raw.kind === 'list') {
          for (let i = 0; i < raw.length; i++) {
            walk(raw.index(i + 1), [...path, i]);
          }
        } else if (raw.kind === 'map') {
          for (const [k, v] of raw.entries()) {
            walk(v, [...path, k]);
          }
        }
        return;
      }
      if (Array.isArray(raw)) {
        raw.forEach((v, i) => walk(v, [...path, i]));
      } else if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          walk(v, [...path, k]);
        }
      }
    };
    walk(tree, []);
    if (
      this.nextType() === 'function' &&
      counter(this.next().exposure) <= exposure
    ) {
      malformed('path is not a Function Value');
    }
  }
  reports(reports: readonly Report[]) {
    if (this.failure) {
      throw this.failure;
    }
    for (const report of reports) {
      this.expose(report);
    }
  }
  snapshot(
    scripts: readonly { name: string; vars: readonly [string, Value][] }[],
  ) {
    this.expose(
      Object.fromEntries(
        scripts.map(s => [s.name, Object.fromEntries(s.vars)]),
      ),
    );
  }
  resolve(
    kind: string,
    id: string,
    resolve?: (kind: string, id: string) => { native: unknown } | undefined,
  ): { native: unknown } | undefined {
    // Core resolver requests are batched by the Host and emitted after Restore.
    const object = { kind, id };
    if (this.replay) {
      if (!this.resolving.length) {
        const e = this.consume('resolve');
        this.resolving = [
          ...(e.objects as { object: ObjectReference; resolved: boolean }[]),
        ];
      }
      const index = this.resolving.findIndex(
        r => identity(r.object) === identity(object),
      );
      const row = index < 0 ? undefined : this.resolving.splice(index, 1)[0];
      if (!row || identity(row.object) !== identity(object)) {
        malformed('resolver order mismatch');
      }
      return row!.resolved ? { native: {} } : undefined;
    }
    const result = resolve?.(kind, id);
    this.outcomes.push({ object, resolved: !!result });
    return result;
  }
  private resolving: { object: ObjectReference; resolved: boolean }[] = [];
  private outcomes: { object: ObjectReference; resolved: boolean }[] = [];
  crossesHandles(): boolean {
    const contains = (raw: Json): boolean => {
      if (isJsonObject(raw)) {
        if (
          raw.pairs.length === 1 &&
          raw.pairs[0]![0] === '$sessionFunction' &&
          typeof raw.pairs[0]![1] === 'string'
        ) {
          return this.handles.has(raw.pairs[0]![1] as string);
        }
        return raw.pairs.some(([, v]) => contains(v));
      }
      return Array.isArray(raw) && raw.some(contains);
    };
    return !!this.replay?.some(
      r =>
        !r.consumed &&
        contains(readOrderedJSON((r.item as { json: string }).json)),
    );
  }
  saved(name: string) {
    this.traceSaves.set(name, [...this.queuedTraceActions]);
  }
  restored(name?: string) {
    if (name) {
      this.queuedTraceActions = [...(this.traceSaves.get(name) ?? [])];
    }
    if (this.replay && this.resolving.length) {
      malformed('leftover resolver outcomes');
    }
    if (this.outcomes.length) {
      this.outcomes.sort(
        (a, b) =>
          compareText(a.object.kind, b.object.kind) ||
          compareText(a.object.id, b.object.id),
      );
      this.emit({ type: 'resolve', objects: this.outcomes });
      this.outcomes = [];
    }
    this.handles.clear();
    this.supplied = new WeakMap();
  }
  action(request: Record<string, unknown>): Record<string, unknown> {
    const convert = (raw: unknown): unknown =>
      Value.isValue(raw)
        ? encoded(this.encode(raw))
        : Array.isArray(raw)
          ? raw.map(convert)
          : raw && typeof raw === 'object'
            ? Object.fromEntries(
                Object.entries(raw).map(([k, v]) => [k, convert(v)]),
              )
            : raw;
    request = convert(request) as Record<string, unknown>;
    const result = this.perform(request);
    if (!this.replay) {
      this.emit({ type: 'input', request, reply: result });
    }
    return result;
  }
  private replayInput(track = false) {
    const e = this.consume('input');
    const request = recordObject(e.request);
    const actual = this.perform(request, e);
    if (this.active || track) {
      const ok = actual.ok as
        { broadcast?: string; delivery?: string } | undefined;
      this.queuedTraceActions.push({
        kind: string(request.kind),
        id: ok?.delivery ?? ok?.broadcast,
      });
    }
    if (serialize(actual) !== serialize(e.reply)) {
      malformed(
        `Host action reply mismatch: actual ${serialize(actual)} expected ${serialize(e.reply)}`,
      );
    }
  }
  drain(item: TranscriptItem) {
    const row = this.replay?.find(r => r.item === item);
    if (!row || row.consumed) {
      return;
    }
    if (
      row.envelope.type !== 'input' &&
      !['kind', 'object'].includes(row.envelope.type)
    ) {
      malformed('unmatched envelope');
    }
    if (row.envelope.type === 'input') {
      this.replayInput();
    } else {
      this.registrations();
    }
  }
  finish() {
    if (this.replay?.some(r => !r.consumed)) {
      malformed('leftover envelopes');
    }
    this.replay = null;
  }
  private perform(
    request: Record<string, unknown>,
    e?: Envelope,
  ): Record<string, unknown> {
    const kind = string(request.kind);
    validateRequest(request);
    const val = (...path: (string | number)[]) =>
      e
        ? this.decode(nodeAt(e, 'request', ...path))
        : this.decode(
            readOrderedJSON(
              serialize(
                path.reduce<unknown>(
                  (o, k) =>
                    Array.isArray(o) && typeof k === 'number'
                      ? o[k]
                      : recordObject(o)[k],
                  request,
                ),
              ),
            ),
          );
    const message = (): Message => {
      const m = exact(request.message, ['name'], ['args', 'limits']);
      return {
        name: string(m.name),
        ...(m.args
          ? {
              args: Array.from(
                { length: (m.args as unknown[]).length },
                (_, i) => val('message', 'args', i),
              ),
            }
          : {}),
        ...(m.limits ? { limits: m.limits as LimitOverride } : {}),
      };
    };
    const target = () => {
      const to = recordObject(request.to);
      if (Object.keys(to).length !== 1) {
        malformed('invalid target');
      }
      return 'script' in to
        ? (this.group.script(string(to.script)) ?? malformed('unknown script'))
        : this.objectRef(to.object);
    };
    const script = () =>
      this.group.script(string(request.script)) ?? malformed('unknown script');
    try {
      switch (kind) {
        case 'set-parent':
          this.group.setParent(
            this.objectRef(request.object),
            request.parent === null
              ? undefined
              : this.objectRef(request.parent),
          );
          break;
        case 'dispose':
          this.group.dispose(this.objectRef(request.object));
          break;
        case 'deliver':
        case 'request':
        case 'decide': {
          if (kind === 'decide' && request.broadcast === true) {
            return {
              ok: { broadcast: this.group.decideBroadcast(message()).id },
            };
          }
          const t = target(),
            m = message();
          const result =
            'name' in t
              ? t[kind](m)
              : kind === 'deliver'
                ? this.group.deliver(t, m)
                : kind === 'request'
                  ? this.group.request(t, m)
                  : this.group.decide(t, m);
          return {
            ok: { delivery: typeof result === 'string' ? result : result.id },
          };
        }
        case 'broadcast':
          return { ok: { broadcast: this.group.broadcast(message()) } };
        case 'call':
          return {
            ok: {
              delivery: this.group.call(
                val('fn'),
                (request.args as unknown[]).map((_, i) => val('args', i)),
                { limits: request.limits as LimitOverride },
              ).id,
            },
          };
        case 'cancel-delivery':
          this.group.cancelDelivery(string(request.delivery));
          break;
        case 'stop':
          script().stop(string(request.reason));
          break;
        case 'cancel-run':
          script().cancelRun(string(request.run));
          break;
        case 'revoke':
          script().revoke(string(request.grant));
          break;
        case 'answer':
          this.group[sessionReply](string(request.call), {
            k: 'answer',
            value: val('value'),
            fuel: Number(request.fuel ?? 0),
          });
          break;
        case 'fail': {
          const f = exact(request.error, ['code', 'message', 'data']);
          this.group[sessionReply](string(request.call), {
            k: 'fail',
            error: new ScriptError(
              string(f.code),
              string(f.message),
              val('error', 'data'),
            ),
          });
          break;
        }
        case 'settle': {
          const s = recordObject(request.settlement);
          if (Object.keys(s).length !== 1) {
            malformed('invalid settlement');
          }
          this.group.settle(
            string(request.call),
            'answer' in s
              ? { answer: val('settlement', 'answer') }
              : 'reissue' in s
                ? { reissue: true }
                : 'adopt' in s
                  ? { adopt: true }
                  : {
                      fail: new ScriptError(
                        string(recordObject(s.fail).code),
                        string(recordObject(s.fail).message),
                        val('settlement', 'fail', 'data'),
                      ),
                    },
          );
          break;
        }
      }
      return { ok: {} };
    } catch (error) {
      if (error instanceof HostError) {
        return { error: error.code };
      }
      throw error;
    }
  }
}
