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
  type Value,
} from './values';

export const requestPumpFeature = 'request-pump-fields-v1';
export const callbacksFeature = 'callbacks-fields-v1';
const prefix = [0x4e, 0x54, 0x42, 1, 1];
const messages = [
  ['request', ['ref', 'group', 'to', 'message']],
  ['call', ['ref', 'group', 'fn', 'args', 'limits']],
  ['pump', ['ref', 'group', 'now', 'fuelSlice', 'fuelCap']],
  [
    'request-pump',
    ['ref', 'group', 'token', 'to', 'message', 'now', 'fuelSlice', 'fuelCap'],
  ],
  [
    'call-pump',
    [
      'ref',
      'group',
      'token',
      'fn',
      'args',
      'limits',
      'now',
      'fuelSlice',
      'fuelCap',
    ],
  ],
] as const;
const resultFields = [
  'ref',
  'group',
  'outcome',
  'value',
  'code',
  'message',
  'charged',
] as const;
const callbackResults = [
  ['op-result', resultFields],
  ['prop-result', resultFields],
  ['effect-result', ['ref', 'group', 'status']],
  ['release-result', ['ref', 'group']],
] as const;
const notices = ['abandoned', 'settled', 'trace'];
const callbackNeeds: readonly (readonly [string, readonly string[]])[] = [
  [
    'op',
    [
      'ref',
      'call',
      'script',
      'run',
      'segment',
      'grant',
      'capability',
      'operation',
      'mode',
      'now',
      'args',
      'scope',
      'automatic',
      'fuelLeft',
      ...notices,
    ],
  ],
  [
    'prop',
    ['ref', 'object', 'prop', 'set', 'value', 'op', 'selector', ...notices],
  ],
  [
    'effect',
    [
      'ref',
      'script',
      'run',
      'segment',
      'grant',
      'grants',
      'coordinator',
      'phase',
      'now',
      ...notices,
    ],
  ],
  ['release', ['ref', 'script', 'grant', 'reason', 'now', ...notices]],
];
/** Callback result methods whose wire form is selected independently of Pump. */
const callbackResultNames = new Set<string>(callbackResults.map(([m]) => m));
export const isCallbackResult = (m: string): boolean =>
  callbackResultNames.has(m);
const opOutcomes = ['result', 'started', 'done', 'fail', 'limit', 'hostError'];
const propOutcomes = ['value', 'ok', 'fail', 'hostError'];
const outcomes = (m: string): readonly string[] =>
  m === 'op-result' ? opOutcomes : propOutcomes;
const uintFields = new Set(['ref', 'charged', 'fuelLeft']);
const boolFields = new Set(['automatic', 'set']);
const textListFields = new Set(['object', 'grants', ...notices]);
const resultHinted = new Set(['value', 'selector']);
const requiredNeedFields: readonly (readonly string[])[] = [
  [
    'call',
    'script',
    'run',
    'segment',
    'grant',
    'capability',
    'operation',
    'mode',
    'now',
    'args',
  ],
  ['object', 'prop'],
  ['script', 'run', 'segment', 'grant', 'grants', 'phase', 'now'],
  ['script', 'grant', 'reason', 'now'],
];
const admission = ['ref', 'delivery', 'err', 'abandoned', 'settled', 'trace'];
const completion = [
  'ref',
  'delivery',
  'token',
  'state',
  'nextDeadline',
  'fuelUsed',
  'reports',
  'gone',
  'err',
  'abandoned',
  'settled',
  'trace',
];
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
const metadata = (o: BinaryValueOptions): BinaryValueOptions => ({
  ...o,
  object: (kind, id) => objectValue({ kind, id, handle: {} }),
  decodeFunction: () => nothing,
});

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
    if (key === 'now' || key === 'nextDeadline') {
      const n = parseInstant(j);
      return { tag: 11, data: (n << 1n) ^ (n >> 63n) };
    }
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

// Callback fields have no nested protocol records. Keep their Value positions
// explicit: a property Object is two protocol texts, not an Object Value item.
const callbackItem = (
  item: BinaryItem,
  name: string,
  o: BinaryValueOptions,
): Json => {
  if (item.tag === 0) {
    return null;
  }
  if (name === 'value' || name === 'selector') {
    itemValue(item, metadata(o));
    return itemJson(item, o, true);
  }
  if (name === 'args') {
    if (item.tag !== 6) {
      return binaryFailure();
    }
    const meta = metadata(o);
    return children(item).map(v => {
      itemValue(v, meta);
      return itemJson(v, o, true);
    });
  }
  if (uintFields.has(name)) {
    if (itemInteger(item) < 0n && name !== 'ref') {
      return binaryFailure();
    }
  } else if (boolFields.has(name)) {
    if (item.tag !== 1 && item.tag !== 2) {
      return binaryFailure();
    }
  } else if (name === 'now') {
    if (item.tag !== 11) {
      return binaryFailure();
    }
  } else if (textListFields.has(name)) {
    const texts = item.tag === 6 ? children(item) : undefined;
    if (!texts || texts.some(v => v.tag !== 18)) {
      return binaryFailure();
    }
    if (name === 'object' && texts.length !== 2) {
      return binaryFailure();
    }
  } else if (item.tag !== 18) {
    return binaryFailure();
  }
  return itemJson(item, o);
};

/** True before any attempt to interpret a frame as UTF-8 or JSON. */
export const isRequestPumpBinary = (bytes: Uint8Array): boolean =>
  bytes.length >= 3 &&
  bytes[0] === 0x4e &&
  bytes[1] === 0x54 &&
  bytes[2] === 0x42;

export const encodeBinaryFrame = (
  frame: Json,
  o: BinaryValueOptions = {},
): ArrayBuffer => {
  const m = field(frame, 'm');
  const need = field(frame, 'need');
  const callback = callbackResults.findIndex(([name]) => name === m);
  const needIndex =
    need === undefined
      ? -1
      : callbackNeeds.findIndex(([name]) => name === field(need, 'm'));
  const input = messages.findIndex(([name]) => name === m);
  const isCompletion =
    input < 0 &&
    callback < 0 &&
    needIndex < 0 &&
    (field(frame, 'token') !== undefined ||
      field(field(frame, 'ok') ?? new JsonObject([]), 'state') !== undefined);
  const tag =
    callback >= 0
      ? callback + 6
      : needIndex >= 0
        ? needIndex + 0x83
        : input >= 0
          ? input + 1
          : isCompletion
            ? 0x82
            : 0x81;
  if (
    (m !== undefined && input < 0 && callback < 0) ||
    (need !== undefined && needIndex < 0)
  ) {
    return binaryFailure();
  }
  const names: readonly string[] =
    callback >= 0
      ? callbackResults[callback]![1]
      : needIndex >= 0
        ? callbackNeeds[needIndex]![1]
        : input >= 0
          ? messages[input]![1]
          : isCompletion
            ? completion
            : admission;
  let data = frame;
  if (needIndex >= 0) {
    data = record([
      ...object(need!).pairs,
      ...object(frame).pairs.filter(([k]) => k !== 'need'),
    ]);
    if (field(need!, 'm') === 'prop') {
      data = record([
        ...object(data).pairs.filter(([k]) => k !== 'object' && k !== 'set'),
        ['object', field(field(need!, 'object') ?? null, '$object')],
        ['set', field(need!, 'value') !== undefined],
      ]);
    }
  } else if (callback >= 0 && callback <= 1) {
    const present = outcomes(m as string).filter(
      k => field(frame, k) !== undefined,
    );
    if (present.length !== 1) {
      return binaryFailure();
    }
    const outcome = present[0]!;
    const fail = field(frame, 'fail');
    data = record([
      ...object(frame).pairs.filter(([k]) => !present.includes(k)),
      ['outcome', outcome],
      [
        'value',
        fail === undefined
          ? outcome === 'result' || outcome === 'value'
            ? field(frame, outcome)
            : undefined
          : field(fail, 'data'),
      ],
      ['code', fail === undefined ? undefined : field(fail, 'code')],
      ['message', fail === undefined ? undefined : field(fail, 'message')],
    ]);
  } else if (input < 0 && callback < 0) {
    const ok = field(frame, 'ok');
    data = record([
      ...object(frame).pairs.filter(([k]) => k !== 'ok'),
      ...(isObject(ok) ? ok.pairs : []),
    ]);
  }
  if (object(data).pairs.some(([k]) => k !== 'm' && !names.includes(k))) {
    return binaryFailure();
  }
  const w = new BinaryWriter();
  w.output.push(...prefix, tag, 6);
  w.uint(BigInt(names.length));
  for (const name of names) {
    const j = field(data, name);
    if (name === 'reports' && j !== undefined && j !== null) {
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
        if (
          object(report).pairs.some(([k]) => k !== 'kind' && !keys.includes(k))
        ) {
          return binaryFailure();
        }
        w.output.push(i + 1, 6);
        w.uint(BigInt(keys.length));
        for (const key of keys) {
          w.item(jsonItem(field(report, key) ?? null, o, key));
        }
      }
    } else {
      const item = jsonItem(
        j ?? null,
        o,
        (callback >= 0 || needIndex >= 0) && resultHinted.has(name)
          ? 'result'
          : needIndex >= 0 && name === 'object'
            ? ''
            : name,
      );
      w.item(item);
    }
  }
  return w.buffer();
};

export const decodeBinaryFrame = (
  buffer: ArrayBuffer,
  o: BinaryValueOptions = {},
): Json => {
  const r = new BinaryReader(new Uint8Array(buffer));
  for (const b of prefix) {
    if (r.byte() !== b) {
      binaryFailure();
    }
  }
  const tag = r.byte();
  const callback = tag >= 6 && tag <= 9 ? callbackResults[tag - 6] : undefined;
  const need =
    tag >= 0x83 && tag <= 0x86 ? callbackNeeds[tag - 0x83] : undefined;
  const names = callback
    ? callback[1]
    : need
      ? need[1]
      : tag >= 1 && tag <= 5
        ? messages[tag - 1]![1]
        : tag === 0x81
          ? admission
          : tag === 0x82
            ? completion
            : binaryFailure();
  if (r.byte() !== 6 || r.uint() !== BigInt(names.length)) {
    binaryFailure();
  }
  const pairs: [string, Json][] = [];
  const convert = (item: BinaryItem, key: string, parent = ''): Json => {
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
        ps.push([k, convert(xs[i + 1]!, k, parent)]);
      }
      return new JsonObject(ps);
    }
    if (item.tag === 6) {
      return children(item).map(v => convert(v, '', key));
    }
    return itemJson(item, o);
  };
  for (const name of names) {
    if (name === 'reports' && r.data[r.at] !== 0) {
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
            ps.push([key, convert(item, key)]);
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
      pairs.push([name, reports]);
    } else {
      const item = r.item();
      if (name === 'ref') {
        itemInteger(item);
      }
      if (
        name === 'token' &&
        item.tag !== 0 &&
        (item.tag !== 3 || itemInteger(item) <= 0n)
      ) {
        binaryFailure();
      }
      if (
        ['group', 'delivery'].includes(name) &&
        item.tag !== 0 &&
        item.tag !== 18
      ) {
        binaryFailure();
      }
      if (item.tag !== 0) {
        pairs.push([
          name,
          callback || need ? callbackItem(item, name, o) : convert(item, name),
        ]);
      }
    }
  }
  r.done();
  const top = new JsonObject(pairs);
  if (!isNumber(field(top, 'ref'))) {
    return binaryFailure();
  }
  if (need) {
    if (
      requiredNeedFields[tag - 0x83]!.some(k => field(top, k) === undefined)
    ) {
      return binaryFailure();
    }
    const ps = pairs.filter(
      ([k]) => k !== 'ref' && !notices.includes(k) && k !== 'set',
    );
    if (need[0] === 'prop') {
      const set = field(top, 'set') === true;
      const hasValue = field(top, 'value') !== undefined;
      if (!set && hasValue) {
        return binaryFailure();
      }
      const at = ps.findIndex(([k]) => k === 'object');
      if (at < 0) {
        return binaryFailure();
      }
      ps[at] = ['object', new JsonObject([['$object', ps[at]![1]]])];
      if (set && !hasValue) {
        ps.push(['value', null]);
      }
    }
    return record([
      ...pairs.filter(([k]) => k === 'ref' || notices.includes(k)),
      ['need', record([['m', need[0]], ...ps])],
    ]);
  }
  if (callback) {
    if (typeof field(top, 'group') !== 'string') {
      return binaryFailure();
    }
    let ps = pairs;
    if (tag <= 7) {
      const outcome = field(top, 'outcome');
      if (
        typeof outcome !== 'string' ||
        !outcomes(callback[0]).includes(outcome)
      ) {
        return binaryFailure();
      }
      ps = pairs.filter(
        ([k]) => k === 'ref' || k === 'group' || k === 'charged',
      );
      ps.push([
        outcome,
        outcome === 'fail'
          ? record([
              ['code', field(top, 'code')],
              ['message', field(top, 'message')],
              ['data', field(top, 'value') ?? null],
            ])
          : outcome === 'result' || outcome === 'value'
            ? (field(top, 'value') ?? null)
            : outcome === 'hostError'
              ? ''
              : true,
      ]);
      if (outcome === 'fail' && typeof field(top, 'code') !== 'string') {
        return binaryFailure();
      }
    }
    return record([['m', callback[0]], ...ps]);
  }
  if (tag <= 5) {
    if (typeof field(top, 'group') !== 'string') {
      return binaryFailure();
    }
    return record([['m', messages[tag - 1]![0]], ...pairs]);
  }
  const err = field(top, 'err');
  if (err === undefined) {
    if (tag === 0x81 && typeof field(top, 'delivery') !== 'string') {
      return binaryFailure();
    }
    if (
      tag === 0x82 &&
      (typeof field(top, 'state') !== 'string' ||
        !isNumber(field(top, 'fuelUsed')) ||
        !Array.isArray(field(top, 'reports')))
    ) {
      return binaryFailure();
    }
  }
  if (
    tag === 0x82 &&
    (field(top, 'delivery') === undefined) !==
      (field(top, 'token') === undefined)
  ) {
    return binaryFailure();
  }
  const outer = [
    'ref',
    'abandoned',
    'settled',
    'trace',
    ...(tag === 0x82 ? ['delivery', 'token'] : []),
  ];
  return record([
    ...pairs.filter(([k]) => outer.includes(k)),
    ...(err !== undefined
      ? [['err', err] as [string, Json]]
      : [
          ['ok', record(pairs.filter(([k]) => !outer.includes(k)))] as [
            string,
            Json,
          ],
        ]),
  ]);
};
