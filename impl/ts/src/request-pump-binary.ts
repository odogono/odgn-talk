// Selected fields envelope (ADR 0110). Ordered JSON is the Message Layer data
// model, not a transport dependency: this codec also serves TS worker Hosts.
import { toBase64 } from './base64';
import {
  BinaryReader,
  BinaryWriter,
  binaryFailure,
  children,
  integerItem,
  itemInteger,
  itemText,
  itemValue,
  valueItem,
  type BinaryItem,
  type BinaryValueOptions,
} from './binary-value';
import { formatInstant, parseInstant } from './dates';
import {
  JsonNumber,
  JsonObject,
  fromJson,
  isJsonNumber as isNumber,
  isJsonObject as isObject,
  type Json,
} from './readers';
import {
  nothing,
  objectValue,
  patternValue,
  functionValue,
  Value,
} from './values';

export const requestPumpFeature = 'request-pump-fields-v1';
export const callbacksFeature = 'callbacks-fields-v1';
const prefix = [0x4e, 0x54, 0x42, 1, 1];
export const binaryReports: readonly (readonly [string, readonly string[]])[] =
  [
    [
      'run end',
      [
        'script',
        'run',
        'delivery',
        'broadcast',
        'handler',
        'fallback',
        'climbed',
        'outcome',
        'result',
        'error',
        'limit',
        'effect',
        'cleanupFailed',
        'at',
        'fuel',
        'alloc',
      ],
    ],
    [
      'run started',
      [
        'script',
        'run',
        'args',
        'rootDelivery',
        'parentRun',
        'parentCall',
        'delivery',
        'selector',
        'fn',
      ],
    ],
    [
      'run discarded',
      ['script', 'run', 'reason', 'rootDelivery', 'parentRun', 'parentCall'],
    ],
    [
      'run accounting',
      [
        'script',
        'run',
        'fuel',
        'state',
        'rootDelivery',
        'parentRun',
        'parentCall',
      ],
    ],
    [
      'causal work',
      ['rootDelivery', 'liveRuns', 'queuedMessages', 'discardedMessages'],
    ],
    [
      'stop',
      ['script', 'reason', 'discardedRuns', 'droppedMessages', 'pendingCalls'],
    ],
    ['unhandled', ['delivery', 'message', 'target']],
    ['call failed', ['script', 'call', 'operation', 'detail']],
    [
      'effect failure',
      ['script', 'run', 'grant', 'segment', 'phase', 'status', 'scope'],
    ],
    ['decided', ['delivery', 'broadcast', 'verdict', 'vetoes', 'undecided']],
    ['host error', ['code', 'detail']],
    ['charge result', ['request', 'call', 'fuel', 'status']],
  ];
const object = (j: Json): JsonObject => (isObject(j) ? j : binaryFailure());
const field = (j: Json, k: string): Json | undefined =>
  object(j).pairs.find(([key]) => key === k)?.[1];
const record = (pairs: [string, Json | undefined][]) =>
  new JsonObject(pairs.filter((p): p is [string, Json] => p[1] !== undefined));
const coreErrorNodes = new WeakSet<JsonObject>();
const valueNodes = new WeakMap<JsonObject, Value>();
/**
 * A frame node standing for a Host Value, so a Host that holds the Value
 * skips its Value Encoding; Functions use the options' `encodeFunction`.
 */
export const valueNode = (v: Value): Json => {
  const node = new JsonObject([]);
  valueNodes.set(node, v);
  return node;
};
/** The Value a `valueNode` holds. */
export const heldValue = (j: Json | undefined): Value | undefined =>
  isObject(j) ? valueNodes.get(j) : undefined;
/** Checks Values' metadata without resolving Objects or Functions. */
export const placeholderValues = (
  o: BinaryValueOptions,
): BinaryValueOptions => ({
  ...o,
  object: (kind, id) => objectValue({ kind, id, handle: {} }),
  decodeFunction: () => nothing,
});
const metadata = placeholderValues;

// A Value Encoding node becomes an item without ever interpreting a Function
// token as code. Validate metadata before an owner can resolve its identity.
const jsonValueItem = (j: Json, o: BinaryValueOptions): BinaryItem => {
  const held = isObject(j) ? valueNodes.get(j) : undefined;
  if (held) {
    return valueItem(held, o);
  }
  const payloads = new WeakMap<object, ReturnType<typeof fromJson>[]>();
  const v = fromJson(
    j,
    (kind, id) => objectValue({ kind, id, handle: {} }),
    undefined,
    (tag, data) => {
      if (tag === '$pattern' && typeof data === 'string') {
        return patternValue({ source: data, program: 0, data: null });
      }
      if (tag !== '$function' || !Array.isArray(data)) {
        return binaryFailure();
      }
      const xs = data.map((x, i) =>
        i === 6 && typeof x === 'string'
          ? fromJson(new JsonObject([['$bytes', x]]))
          : fromJson(x),
      );
      const placeholder = functionValue({
        home: '',
        place: '',
        identity: '',
        captures: [],
        maySuspend: false,
        code: null,
      });
      payloads.set(placeholder, xs);
      return placeholder;
    },
  );
  const root = valueItem(v, {
    ...o,
    encodeFunction: v => payloads.get(v) ?? binaryFailure(),
  });
  // Core-error maps have a binary marker beyond their ordinary JSON shape.
  // Keep it on decoded nodes, including nested Maps and the $map escape.
  const work: [Json, BinaryItem][] = [[j, root]];
  while (work.length) {
    const [node, item] = work.pop()!;
    if (Array.isArray(node)) {
      node.forEach((v, i) => work.push([v, children(item)[i]!]));
    } else if (isObject(node)) {
      if (coreErrorNodes.has(node)) {
        if (!o.coreErrors) {
          binaryFailure();
        }
        item.tag = 17;
      }
      if (item.tag === 7 || item.tag === 17) {
        const escaped = field(node, '$map');
        const pairs = Array.isArray(escaped)
          ? (escaped as [string, Json][])
          : node.pairs;
        pairs.forEach(([, v], i) => work.push([v, children(item)[2 * i + 1]!]));
      } else if (item.tag === 10) {
        const ends = field(node, '$range');
        if (!Array.isArray(ends)) {
          return binaryFailure();
        }
        ends.forEach((v, i) => work.push([v, children(item)[i]!]));
      }
    }
  }
  itemValue(root, metadata(o));
  return root;
};

type Role = 'protocol' | 'value' | 'values';
const role = (key: string, parent: string): Role =>
  ['fn', 'result', 'error', 'object', 'target'].includes(key) ||
  (key === 'reason' && parent === 'vetoes')
    ? 'value'
    : key === 'args'
      ? 'values'
      : 'protocol';
const jsonItem = (
  j: Json,
  o: BinaryValueOptions,
  key = '',
  parent = '',
): BinaryItem => {
  if (j === null) {
    return { tag: 0 };
  }
  const r = role(key, parent);
  if (r === 'value') {
    return jsonValueItem(j, o);
  }
  if (r === 'values') {
    if (!Array.isArray(j)) {
      return binaryFailure();
    }
    return { tag: 6, data: j.map(v => jsonValueItem(v, o)) };
  }
  if (j === null) {
    return { tag: 0 };
  }
  if (typeof j === 'boolean') {
    return { tag: j ? 2 : 1 };
  }
  if (typeof j === 'string') {
    return { tag: 18, data: j };
  }
  if (isNumber(j)) {
    return /^-?\d+$/.test(j.source)
      ? integerItem(BigInt(j.source))
      : valueItem(fromJson(new JsonObject([['$dec', j.source]])));
  }
  if (Array.isArray(j)) {
    return { tag: 6, data: j.map(v => jsonItem(v, o, '', key)) };
  }
  return {
    tag: 7,
    data: j.pairs.flatMap(([k, v]) => [
      { tag: 5, data: k },
      jsonItem(v, o, k, parent),
    ]),
  };
};

// Iterative conversion retains exact decimals, Map order and adapter payloads.
const itemJson = (
  root: BinaryItem,
  o: BinaryValueOptions,
  value = false,
): Json => {
  let result!: Json;
  const tasks: (() => void)[] = [];
  const visit = (item: BinaryItem, assign: (j: Json) => void, value: boolean) =>
    tasks.push(() => {
      const { tag, data } = item;
      if (tag === 0) {
        return assign(null);
      }
      if (tag === 1 || tag === 2) {
        return assign(tag === 2);
      }
      if (tag === 3 || tag === 16 || tag === 4) {
        const s = tag === 4 ? (data as string) : itemInteger(item).toString();
        return assign(
          value &&
            (s.includes('.') ||
              BigInt(s) <= -(2n ** 53n) ||
              BigInt(s) >= 2n ** 53n)
            ? new JsonObject([['$dec', s]])
            : new JsonNumber(s),
        );
      }
      if (tag === 5 || tag === 18) {
        if (value && tag === 18) {
          return binaryFailure();
        }
        return assign(itemText(item));
      }
      if (tag === 11) {
        const n = data as bigint;
        const s = formatInstant((n >> 1n) ^ -(n & 1n));
        return assign(value ? new JsonObject([['$instant', s]]) : s);
      }
      if (tag === 8 || tag === 12 || tag === 13) {
        return assign(
          new JsonObject([
            [
              tag === 8 ? '$bytes' : tag === 12 ? '$date' : '$pattern',
              tag === 8 ? toBase64(data as Uint8Array) : (data as string),
            ],
          ]),
        );
      }
      const items = children(item);
      const xs: Json[] = new Array(items.length);
      tasks.push(() => {
        if (tag === 6) {
          return assign(xs);
        }
        if (tag === 7 || tag === 17) {
          if (tag === 17 && !o.coreErrors) {
            return binaryFailure();
          }
          const pairs: [string, Json][] = [];
          const seen = new Set<string>();
          for (let i = 0; i < xs.length; i += 2) {
            if (items[i]!.tag !== 5) {
              return binaryFailure();
            }
            const k = itemText(items[i]!);
            if (seen.has(k)) {
              return binaryFailure();
            }
            seen.add(k);
            pairs.push([k, xs[i + 1]!]);
          }
          const node =
            value && pairs.some(([k]) => k.startsWith('$'))
              ? new JsonObject([['$map', pairs.map(([k, v]) => [k, v])]])
              : new JsonObject(pairs);
          if (tag === 17) {
            coreErrorNodes.add(node);
          }
          return assign(node);
        }
        if (tag === 9) {
          const n = children(item)[0]!;
          return assign(
            new JsonObject([
              [
                '$quantity',
                [
                  n.tag === 4 ? (n.data as string) : itemInteger(n).toString(),
                  itemText(items[1]!),
                ],
              ],
            ]),
          );
        }
        if (tag === 10 || tag === 14) {
          return assign(
            new JsonObject([[tag === 10 ? '$range' : '$object', xs]]),
          );
        }
        if (tag === 15 || tag === 19) {
          if (tag === 19 && !o.functionMetadata) {
            return binaryFailure();
          }
          if (xs.length === 7) {
            xs[6] = toBase64(items[6]!.data as Uint8Array);
          }
          return assign(new JsonObject([['$function', xs]]));
        }
        return binaryFailure();
      });
      for (let i = items.length - 1; i >= 0; i--) {
        const v = value || ![6, 7].includes(tag);
        visit(
          items[i]!,
          j => {
            xs[i] = j;
          },
          v,
        );
      }
    });
  visit(
    root,
    j => {
      result = j;
    },
    value,
  );
  while (tasks.length) {
    tasks.pop()!();
  }
  return result;
};

// Nested protocol data, where a key says which members are Values.
const convert = (
  item: BinaryItem,
  o: BinaryValueOptions,
  key: string,
  parent = '',
): Json => {
  const kind = role(key, parent);
  if (kind === 'value') {
    itemValue(item, metadata(o));
    return itemJson(item, o, true);
  }
  if (kind === 'values') {
    if (item.tag !== 6) {
      return binaryFailure();
    }
    return children(item).map(v => {
      itemValue(v, metadata(o));
      return itemJson(v, o, true);
    });
  }
  if (item.tag === 7) {
    const xs = children(item);
    const ps: [string, Json][] = [];
    const seen = new Set<string>();
    for (let i = 0; i < xs.length; i += 2) {
      if (xs[i]!.tag !== 5) {
        return binaryFailure();
      }
      const k = itemText(xs[i]!);
      if (seen.has(k)) {
        return binaryFailure();
      }
      seen.add(k);
      ps.push([k, convert(xs[i + 1]!, o, k, parent)]);
    }
    return new JsonObject(ps);
  }
  if (item.tag === 6) {
    return children(item).map(v => convert(v, o, '', key));
  }
  return itemJson(item, o);
};

// How each field crosses. Protocol kinds are checked as they decode; `value`
// positions are Values; `record` is nested protocol data, typed by its keys.
type Kind =
  | 'int'
  | 'uint'
  | 'token'
  | 'bool'
  | 'instant'
  | 'text'
  | 'texts'
  | 'value'
  | 'values'
  | 'record'
  | 'settlements'
  | 'reports';
/** A frame member by name: Json, or a Value on the direct callback paths. */
type Get = (key: string) => unknown;
type Schema = {
  readonly family: 'message' | 'result' | 'need' | 'reply';
  /** Wire order. */
  readonly fields: readonly (readonly [string, Kind])[];
  /** The decoded flat record as the frame. */
  readonly fromWire: (get: Get, pairs: [string, Json][]) => Json;
  /** Members a frame may have, the wire's flattened ones included. */
  readonly keys: ReadonlySet<string>;
  /** The method, need or reply this tag carries. */
  readonly name: string;
  readonly required: readonly string[];
  readonly tag: number;
  /** The frame's members as the flat wire record, when the two differ. */
  readonly toWire?: (get: Get) => Get;
};
type Fields = Readonly<Record<string, Kind>>;

const notices = ['abandoned', 'settled', 'trace'];
const noticeFields: Fields = {
  abandoned: 'texts',
  settled: 'texts',
  trace: 'texts',
};
// A member of a frame's nested record, decoded (Json) or direct (a plain record).
const member = (x: unknown, k: string): unknown =>
  isObject(x as Json)
    ? field(x as Json, k)
    : x !== null && typeof x === 'object' && !Value.isValue(x)
      ? (x as Record<string, unknown>)[k]
      : undefined;
const schema = (
  tag: number,
  name: string,
  family: Schema['family'],
  fields: Fields,
  required: readonly string[],
  fromWire: Schema['fromWire'],
  extra: { keys?: readonly string[]; toWire?: Schema['toWire'] } = {},
): Schema => ({
  tag,
  name,
  family,
  fields: Object.entries(fields),
  keys: new Set(extra.keys ?? Object.keys(fields)),
  required: ['ref', ...required],
  fromWire,
  toWire: extra.toWire,
});

const message = (
  tag: number,
  name: string,
  fields: Fields,
  required: readonly string[] = ['group'],
): Schema =>
  schema(
    tag,
    name,
    tag < 6 || tag === 10 || tag === 11 ? 'message' : 'result',
    fields,
    required,
    (_, pairs) => new JsonObject([['m', name], ...pairs]),
  );

// An op or prop result names its outcome as a member; the wire carries the
// outcome's name, with its Value or failure in shared fields.
const resultFields: Fields = {
  ref: 'int',
  group: 'text',
  outcome: 'text',
  value: 'value',
  code: 'text',
  message: 'text',
  charged: 'uint',
};
const outcomeResult = (
  tag: number,
  name: string,
  outcomes: readonly string[],
): Schema =>
  schema(
    tag,
    name,
    'result',
    resultFields,
    ['group', 'outcome'],
    (get, pairs) => {
      const outcome = get('outcome') as string;
      if (
        !outcomes.includes(outcome) ||
        (outcome === 'fail' && get('code') === undefined)
      ) {
        return binaryFailure();
      }
      const value = (get('value') as Json | undefined) ?? null;
      return new JsonObject([
        ['m', name],
        ...pairs.filter(
          ([k]) => k === 'ref' || k === 'group' || k === 'charged',
        ),
        [
          outcome,
          outcome === 'fail'
            ? record([
                ['code', get('code') as Json],
                ['message', get('message') as Json | undefined],
                ['data', value],
              ])
            : outcome === 'result' || outcome === 'value'
              ? value
              : outcome === 'hostError'
                ? ''
                : true,
        ],
      ]);
    },
    {
      keys: ['ref', 'group', 'charged', ...outcomes],
      toWire: get => {
        let outcome: string | undefined;
        for (const k of outcomes) {
          if (get(k) !== undefined) {
            if (outcome !== undefined) {
              return binaryFailure();
            }
            outcome = k;
          }
        }
        if (outcome === undefined) {
          return binaryFailure();
        }
        const fail = outcome === 'fail' ? get('fail') : undefined;
        const value =
          fail !== undefined
            ? member(fail, 'data')
            : outcome === 'result' || outcome === 'value'
              ? get(outcome)
              : undefined;
        return k =>
          k === 'outcome'
            ? outcome
            : k === 'value'
              ? value
              : k === 'code' || k === 'message'
                ? member(fail, k)
                : get(k);
      },
    },
  );

// A need travels inside its packet, beside the notices; on the wire the two are one record.
const need = (
  tag: number,
  name: string,
  fields: Fields,
  required: readonly string[],
  reshape?: {
    fromWire: (get: Get, pairs: [string, Json][]) => [string, Json][];
    toWire: Schema['toWire'];
  },
): Schema =>
  schema(
    tag,
    name,
    'need',
    { ref: 'int', ...fields, ...noticeFields },
    required,
    (get, pairs) => {
      const inner = pairs.filter(([k]) => k !== 'ref' && !notices.includes(k));
      return new JsonObject([
        ...pairs.filter(([k]) => k === 'ref' || notices.includes(k)),
        [
          'need',
          new JsonObject([
            ['m', name],
            ...(reshape ? reshape.fromWire(get, inner) : inner),
          ]),
        ],
      ]);
    },
    { toWire: reshape?.toWire },
  );

// A property Object is its kind and id as protocol texts, and `set` says
// whether a setter's Value, absent for Nothing, is there.
const property = {
  toWire:
    (get: Get): Get =>
    k =>
      k === 'object'
        ? member(get('object'), '$object')
        : k === 'set'
          ? get('value') !== undefined
          : get(k),
  fromWire: (get: Get, pairs: [string, Json][]): [string, Json][] => {
    const set = get('set') === true;
    const ref = get('object') as Json[];
    if ((!set && get('value') !== undefined) || ref.length !== 2) {
      return binaryFailure();
    }
    const ps = pairs.flatMap(([k, v]): [string, Json][] =>
      k === 'set'
        ? []
        : [[k, k === 'object' ? new JsonObject([['$object', v]]) : v]],
    );
    if (set && get('value') === undefined) {
      ps.push(['value', null]);
    }
    return ps;
  },
};

// A reply's notices and correlation sit beside its `ok` or `err`; the wire
// carries every member flat.
const reply = (
  tag: number,
  name: string,
  fields: Fields,
  outer: readonly string[],
  check: (get: Get, failed: boolean) => boolean,
): Schema =>
  schema(tag, name, 'reply', fields, [], (get, pairs) => {
    const err = get('err') as Json | undefined;
    if (!check(get, err !== undefined)) {
      return binaryFailure();
    }
    return record([
      ...pairs.filter(([k]) => outer.includes(k)),
      err !== undefined
        ? ['err', err]
        : ['ok', record(pairs.filter(([k]) => !outer.includes(k)))],
    ]);
  });

const opNeed: Fields = {
  call: 'text',
  script: 'text',
  run: 'text',
  segment: 'text',
  grant: 'text',
  capability: 'text',
  operation: 'text',
  mode: 'text',
  now: 'instant',
  args: 'values',
  scope: 'text',
  automatic: 'bool',
  fuelLeft: 'uint',
};
const effectNeed: Fields = {
  script: 'text',
  run: 'text',
  segment: 'text',
  grant: 'text',
  grants: 'texts',
  coordinator: 'text',
  phase: 'text',
  now: 'instant',
};
const pumpFields: Fields = {
  now: 'instant',
  fuelSlice: 'record',
  fuelCap: 'record',
};
const schemas: readonly Schema[] = [
  message(1, 'request', {
    ref: 'int',
    group: 'text',
    to: 'record',
    message: 'record',
  }),
  message(2, 'call', {
    ref: 'int',
    group: 'text',
    fn: 'value',
    args: 'values',
    limits: 'record',
  }),
  message(3, 'pump', { ref: 'int', group: 'text', ...pumpFields }),
  message(4, 'request-pump', {
    ref: 'int',
    group: 'text',
    token: 'token',
    to: 'record',
    message: 'record',
    ...pumpFields,
  }),
  message(5, 'call-pump', {
    ref: 'int',
    group: 'text',
    token: 'token',
    fn: 'value',
    args: 'values',
    limits: 'record',
    ...pumpFields,
  }),
  outcomeResult(6, 'op-result', [
    'result',
    'started',
    'done',
    'fail',
    'limit',
    'hostError',
  ]),
  outcomeResult(7, 'prop-result', ['value', 'ok', 'fail', 'hostError']),
  message(8, 'effect-result', { ref: 'int', group: 'text', status: 'text' }),
  message(9, 'release-result', { ref: 'int', group: 'text' }),
  message(10, 'settle-pump', {
    ref: 'int',
    group: 'text',
    ...pumpFields,
    settlements: 'settlements',
  }),
  message(
    11,
    'load',
    {
      ref: 'int',
      group: 'text',
      name: 'text',
      source: 'text',
      grants: 'record',
      grantsAsUsed: 'bool',
      owner: 'record',
      objects: 'record',
      limits: 'record',
      newGroup: 'record',
      refuseWorker: 'bool',
    },
    ['group', 'name', 'source'],
  ),
  reply(
    0x81,
    'admission',
    { ref: 'int', delivery: 'text', err: 'record', ...noticeFields },
    ['ref', ...notices],
    (get, failed) => failed || get('delivery') !== undefined,
  ),
  reply(
    0x82,
    'completion',
    {
      ref: 'int',
      delivery: 'text',
      token: 'token',
      state: 'text',
      nextDeadline: 'instant',
      fuelUsed: 'record',
      reports: 'reports',
      gone: 'record',
      err: 'record',
      ...noticeFields,
    },
    ['ref', ...notices, 'delivery', 'token'],
    (get, failed) =>
      (get('delivery') === undefined) === (get('token') === undefined) &&
      (failed ||
        (get('state') !== undefined &&
          isNumber(get('fuelUsed') as Json) &&
          get('reports') !== undefined)),
  ),
  need(
    0x83,
    'op',
    opNeed,
    Object.keys(opNeed).filter(
      k => !['scope', 'automatic', 'fuelLeft'].includes(k),
    ),
  ),
  need(
    0x84,
    'prop',
    {
      object: 'texts',
      prop: 'text',
      set: 'bool',
      value: 'value',
      op: 'text',
      selector: 'value',
    },
    ['object', 'prop'],
    property,
  ),
  need(
    0x85,
    'effect',
    effectNeed,
    Object.keys(effectNeed).filter(k => k !== 'coordinator'),
  ),
  need(
    0x86,
    'release',
    { script: 'text', grant: 'text', reason: 'text', now: 'instant' },
    ['script', 'grant', 'reason', 'now'],
  ),
];
const byTag = new Map(schemas.map(s => [s.tag, s]));
const byMethod = new Map(
  schemas
    .filter(s => s.family === 'message' || s.family === 'result')
    .map(s => [s.name, s]),
);
const byNeed = new Map(
  schemas.filter(s => s.family === 'need').map(s => [s.name, s]),
);
const results = new Map(
  schemas
    .filter(s => s.family === 'result')
    .map(s => [s.name.replace(/-result$/, ''), s]),
);

const integer = (x: unknown): bigint =>
  typeof x === 'number' && Number.isSafeInteger(x)
    ? BigInt(x)
    : isNumber(x as Json) && /^-?\d+$/.test((x as JsonNumber).source)
      ? BigInt((x as JsonNumber).source)
      : binaryFailure();
const textItem = (x: unknown): BinaryItem =>
  typeof x === 'string' ? { tag: 18, data: x } : binaryFailure();
const valueOf = (x: unknown, o: BinaryValueOptions): BinaryItem =>
  Value.isValue(x) ? valueItem(x, o) : jsonValueItem(x as Json, o);

// The settlement record is positional even inside a fields-layout input.
// Outcome reshaping is deliberately kept here, beside the codec's other
// nested protocol records, rather than in generated tables.
const settlementFields = [
  ['call', 'text'],
  ['outcome', 'text'],
  ['value', 'value'],
  ['fuel', 'int'],
  ['code', 'text'],
  ['message', 'text'],
] as const;

const writeReports = (w: BinaryWriter, j: Json, o: BinaryValueOptions) => {
  if (!Array.isArray(j)) {
    return binaryFailure();
  }
  w.output.push(6);
  w.uint(BigInt(j.length));
  for (const report of j) {
    const i = binaryReports.findIndex(
      ([kind]) => kind === field(report, 'kind'),
    );
    if (i < 0) {
      return binaryFailure();
    }
    const keys = binaryReports[i]![1];
    if (object(report).pairs.some(([k]) => k !== 'kind' && !keys.includes(k))) {
      return binaryFailure();
    }
    w.output.push(i + 1, 6);
    w.uint(BigInt(keys.length));
    for (const key of keys) {
      w.item(jsonItem(field(report, key) ?? null, o, key));
    }
  }
};

const writeField = (
  w: BinaryWriter,
  name: string,
  kind: Kind,
  x: unknown,
  o: BinaryValueOptions,
) => {
  if (x === undefined || x === null) {
    w.output.push(0);
    return;
  }
  switch (kind) {
    case 'int':
    case 'uint':
    case 'token': {
      const n = integer(x);
      if ((kind === 'uint' && n < 0n) || (kind === 'token' && n <= 0n)) {
        return binaryFailure();
      }
      return w.item(integerItem(n));
    }
    case 'bool':
      return typeof x === 'boolean'
        ? w.output.push(x ? 2 : 1)
        : binaryFailure();
    case 'instant': {
      const n = parseInstant(typeof x === 'string' ? x : binaryFailure());
      return w.item({ tag: 11, data: (n << 1n) ^ (n >> 63n) });
    }
    case 'text':
      return w.item(textItem(x));
    case 'texts':
      return w.item({
        tag: 6,
        data: (Array.isArray(x) ? x : binaryFailure()).map(textItem),
      });
    case 'value':
      return w.item(valueOf(x, o));
    case 'values':
      return w.item({
        tag: 6,
        data: (Array.isArray(x) ? x : binaryFailure()).map(v => valueOf(v, o)),
      });
    case 'record':
      return w.item(jsonItem(x as Json, o, name));
    case 'settlements': {
      if (!Array.isArray(x)) {
        return binaryFailure();
      }
      w.output.push(6);
      w.uint(BigInt(x.length));
      for (const settlement of x as Json[]) {
        if (
          object(settlement).pairs.some(
            ([key]) => !settlementFields.some(([name]) => name === key),
          )
        ) {
          return binaryFailure();
        }
        w.output.push(6);
        w.uint(BigInt(settlementFields.length));
        for (const [key, kind] of settlementFields) {
          writeField(w, key, kind, field(settlement, key), o);
        }
      }
      return;
    }
    case 'reports':
      return writeReports(w, x as Json, o);
  }
};

const write = (s: Schema, get: Get, o: BinaryValueOptions): ArrayBuffer => {
  const w = new BinaryWriter();
  w.output.push(...prefix, s.tag, 6);
  w.uint(BigInt(s.fields.length));
  const wire = s.toWire ? s.toWire(get) : get;
  for (const [name, kind] of s.fields) {
    writeField(w, name, kind, wire(name), o);
  }
  return w.buffer();
};

/** True before any attempt to interpret a frame as UTF-8 or JSON. */
export const isRequestPumpBinary = (bytes: Uint8Array): boolean =>
  bytes.length >= 3 &&
  bytes[0] === 0x4e &&
  bytes[1] === 0x54 &&
  bytes[2] === 0x42;

/** True when a binary frame's tag is a callback need. */
export const isBinaryNeed = (bytes: Uint8Array): boolean =>
  bytes.length > 5 && byTag.get(bytes[5]!)?.family === 'need';

export const encodeBinaryFrame = (
  frame: Json,
  o: BinaryValueOptions = {},
): ArrayBuffer => {
  const m = field(frame, 'm');
  const need = field(frame, 'need');
  const ok = field(frame, 'ok');
  const s =
    need !== undefined
      ? byNeed.get(field(need, 'm') as string)
      : m !== undefined
        ? byMethod.get(m as string)
        : field(frame, 'token') !== undefined ||
            (isObject(ok) && field(ok, 'state') !== undefined)
          ? byTag.get(0x82)
          : byTag.get(0x81);
  const inner = need ?? ok;
  if (
    !s ||
    [...object(frame).pairs, ...(isObject(inner) ? inner.pairs : [])].some(
      ([k]) => k !== 'm' && k !== 'need' && k !== 'ok' && !s.keys.has(k),
    )
  ) {
    return binaryFailure();
  }
  return write(
    s,
    k => {
      const j = isObject(inner) ? field(inner, k) : undefined;
      return j === undefined ? field(frame, k) : j;
    },
    o,
  );
};

/**
 * The binary result answering a callback need, straight from its members:
 * `answer` holds them as Values and plain data, without `m`, `ref` and
 * `group`. Undefined when the need has no binary result.
 */
export const encodeResult = (
  need: string,
  ref: number,
  group: string | undefined,
  answer: Readonly<Record<string, unknown>>,
  o: BinaryValueOptions = {},
): ArrayBuffer | undefined => {
  const s = results.get(need);
  return (
    s &&
    write(s, k => (k === 'ref' ? ref : k === 'group' ? group : answer[k]), o)
  );
};

const readReports = (r: BinaryReader, o: BinaryValueOptions): Json[] => {
  if (r.byte() !== 6) {
    return binaryFailure();
  }
  const count = r.count();
  const reports: Json[] = [];
  for (let i = 0; i < count; i++) {
    const report = binaryReports[r.byte() - 1] ?? binaryFailure();
    if (r.byte() !== 6 || r.uint() !== BigInt(report[1].length)) {
      return binaryFailure();
    }
    const ps: [string, Json][] = [['kind', report[0]]];
    for (const key of report[1]) {
      const item = r.item();
      if (item.tag !== 0) {
        ps.push([key, convert(item, o, key)]);
      }
    }
    if (
      report[0] === 'run end' &&
      ps.some(([k, v]) => k === 'outcome' && v === 'completed') &&
      !ps.some(([k]) => k === 'result')
    ) {
      ps.push(['result', null]);
    }
    reports.push(new JsonObject(ps));
  }
  return reports;
};

const readField = (
  item: BinaryItem,
  name: string,
  kind: Kind,
  o: BinaryValueOptions,
  value: (item: BinaryItem) => Json,
): Json => {
  switch (kind) {
    case 'int':
    case 'uint':
    case 'token': {
      const n = itemInteger(item);
      if ((kind === 'uint' && n < 0n) || (kind === 'token' && n <= 0n)) {
        return binaryFailure();
      }
      return new JsonNumber(n.toString());
    }
    case 'bool':
      return item.tag === 1 || item.tag === 2
        ? item.tag === 2
        : binaryFailure();
    case 'instant': {
      if (item.tag !== 11) {
        return binaryFailure();
      }
      const n = item.data as bigint;
      return formatInstant((n >> 1n) ^ -(n & 1n));
    }
    case 'text':
      return item.tag === 18 ? itemText(item) : binaryFailure();
    case 'texts':
      return item.tag === 6
        ? children(item).map(t =>
            t.tag === 18 ? itemText(t) : binaryFailure(),
          )
        : binaryFailure();
    case 'value':
      return value(item);
    case 'values':
      return item.tag === 6 ? children(item).map(value) : binaryFailure();
    case 'settlements':
      if (item.tag !== 6) {
        return binaryFailure();
      }
      return children(item).map(settlement => {
        const xs = children(settlement);
        if (settlement.tag !== 6 || xs.length !== settlementFields.length) {
          return binaryFailure();
        }
        const pairs: [string, Json][] = [];
        for (const [i, [key, kind]] of settlementFields.entries()) {
          if (xs[i]!.tag !== 0) {
            pairs.push([key, readField(xs[i]!, key, kind, o, value)]);
          }
        }
        const get = (key: string) => pairs.find(([k]) => k === key)?.[1];
        if (
          get('call') === undefined ||
          !['answer', 'fail'].includes(get('outcome') as string)
        ) {
          return binaryFailure();
        }
        // An absent Value is a Nothing answer or failure Data.
        if (get('value') === undefined) {
          pairs.push(['value', null]);
        }
        return new JsonObject(pairs);
      });
    default:
      return convert(item, o, name);
  }
};

const decode = (
  buffer: ArrayBuffer,
  o: BinaryValueOptions,
  value: (item: BinaryItem) => Json,
): Json => {
  const r = new BinaryReader(new Uint8Array(buffer));
  for (const b of prefix) {
    if (r.byte() !== b) {
      binaryFailure();
    }
  }
  const s = byTag.get(r.byte()) ?? binaryFailure();
  if (r.byte() !== 6 || r.uint() !== BigInt(s.fields.length)) {
    binaryFailure();
  }
  const pairs: [string, Json][] = [];
  for (const [name, kind] of s.fields) {
    if (kind === 'reports' && r.data[r.at] !== 0) {
      pairs.push([name, readReports(r, o)]);
      continue;
    }
    const item = r.item();
    if (item.tag !== 0) {
      pairs.push([name, readField(item, name, kind, o, value)]);
    }
  }
  r.done();
  const get: Get = k => pairs.find(([key]) => key === k)?.[1];
  if (s.required.some(k => get(k) === undefined)) {
    return binaryFailure();
  }
  return s.fromWire(get, pairs);
};

export const decodeBinaryFrame = (
  buffer: ArrayBuffer,
  o: BinaryValueOptions = {},
): Json => {
  const meta = metadata(o);
  return decode(buffer, o, item => {
    itemValue(item, meta);
    return itemJson(item, o, true);
  });
};

/**
 * A callback need's packet, each Value decoded once under `o`'s Object and
 * Function hooks and held in a `valueNode`.
 */
export const decodeNeed = (
  buffer: ArrayBuffer,
  o: BinaryValueOptions,
): Json => {
  if (
    !isBinaryNeed(new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength)))
  ) {
    return binaryFailure();
  }
  return decode(buffer, o, item => valueNode(itemValue(item, o)));
};
