// Chapter 9's Capabilities: Operation Declarations with Shapes, defined once
// per process, and Grants that bind them to a Script. The Core checks each
// argument against its Shape before the Host function runs, and each result
// after (chapter 6, Errors from Capabilities).
import {
  HostError,
  invalidValue,
  type ScriptError as HostScriptError,
} from './errors';
import type { HostObject, ObjectKind } from './objects';
import { parseUnit, unitEntry, unitText } from './units';
import {
  bool,
  bytes,
  dec,
  instant,
  isDecimal,
  listValues,
  map as mapValue,
  nothing,
  num,
  text,
  Value,
  type Decimal,
} from './values';
import { unitKinds } from './generated/syntax';
import type { Group } from './embedding';
import { RESERVED } from './lexer';
import { validArgumentLabel } from './selectors';

declare const plainForm: unique symbol;
/**
 * A Shape, carrying the JS type a typed Host function receives for it
 * (#1420). The type is compile-time only.
 */
export type Shape<T = unknown> = ShapeNode & { readonly [plainForm]?: T };
type ShapeNode =
  | { k: 'any' }
  | { k: 'value' }
  | { k: 'kind'; kind: string }
  | { k: 'object'; kind: string }
  | { k: 'quantity'; unit: string }
  | { k: 'unitKind'; kind: string }
  | { k: 'list'; of: Shape }
  | {
      fields: readonly { key: string; optional: boolean; shape: Shape }[];
      k: 'map';
      open: boolean;
    }
  | { k: 'oneOf'; of: readonly Shape[] }
  | { k: 'optional'; of: Shape };
export type FieldShape = Shape | { optional: true; shape: Shape };

/** Only a suffix of directly Optional argument Shapes can be omitted. */
export const acceptsArgumentCount = (
  args: readonly Shape[],
  count: number,
): boolean =>
  count <= args.length && args.slice(count).every(s => s.k === 'optional');

const kind = (k: string): Shape => ({ k: 'kind', kind: k });
const fieldsOf = (fields: Record<string, FieldShape>) =>
  Object.entries(fields).map(([key, f]) =>
    'shape' in f
      ? { key, optional: true, shape: f.shape }
      : { key, optional: false, shape: f },
  );
/** The Shape constructors of `talk.ts`. */
export const shape = {
  any: { k: 'any' } as Shape<Value>,
  value: { k: 'value' } as Shape<Value>,
  nothing: kind('nothing') as Shape<null>,
  bool: kind('boolean') as Shape<boolean>,
  number: kind('number') as Shape<Decimal>,
  text: kind('text') as Shape<string>,
  bytes: kind('bytes') as Shape<Uint8Array>,
  instant: kind('instant') as Shape<bigint>,
  civilDate: kind('civil date') as Shape<Value>,
  range: kind('range') as Shape<Value>,
  pattern: kind('pattern') as Shape<Value>,
  function: kind('function') as Shape<Value>,
  object: <N>(kind: ObjectKind<N>): Shape<HostObject<N>> => ({
    k: 'object',
    kind: kind.name,
  }),
  quantityOf: (unit: string): Shape<Value> => ({
    k: 'quantity',
    unit: unitText(parseUnit(unit)),
  }),
  quantityKind: (unitKind: string): Shape<Value> => ({
    k: 'unitKind',
    kind: unitKind,
  }),
  listOf: (of: Shape): Shape<Value> => ({ k: 'list', of }),
  map: (fields: Record<string, FieldShape>): Shape<Value> => ({
    k: 'map',
    fields: fieldsOf(fields),
    open: false,
  }),
  openMap: (fields: Record<string, FieldShape>): Shape<Value> => ({
    k: 'map',
    fields: fieldsOf(fields),
    open: true,
  }),
  oneOf: (...of: Shape[]): Shape<Value> => ({ k: 'oneOf', of }),
  /** Supplied Nothing is null; an omitted trailing argument is undefined. */
  optional: <T>(of: Shape<T>): Shape<T | null | undefined> => ({
    k: 'optional',
    of,
  }),
};

/** What a Shape expects, as `wrong kind` writes it. */
export const expectedOf = (s: Shape): string => {
  switch (s.k) {
    case 'any':
      return 'any';
    case 'value':
      return 'value';
    case 'kind':
    case 'object':
      return s.kind;
    case 'quantity':
      return s.unit;
    case 'unitKind':
      return s.kind;
    case 'list':
      return 'list';
    case 'map':
      return 'map';
    case 'oneOf':
      return s.of.map(expectedOf).join(' or ');
    case 'optional':
      return `${expectedOf(s.of)} or nothing`;
  }
};

/** Where a value first breaks a Shape, depth-first. */
export type Mismatch = {
  expected: string;
  got: string;
  path: (string | number)[];
  /** A Function Value under a data Shape is `not encodable`, not `wrong kind`. */
  unencodable?: boolean;
  value: Value;
};
const nothingValue = (v: Value) => v.kind === 'nothing';
// What a value is, as `wrong kind` writes it: its kind, or a Quantity's Unit
// when a Quantity Shape wants another.
const gotOf = (v: Value, s: Shape) =>
  (s.k === 'quantity' || s.k === 'unitKind') && v.kind === 'quantity'
    ? unitText(v.asQuantityRef()!.unit)
    : v.kind;

export const mismatch = (
  v: Value,
  s: Shape,
  path: (string | number)[] = [],
): Mismatch | null => {
  const wrong = (): Mismatch => ({
    expected: expectedOf(s),
    got: gotOf(v, s),
    path,
    value: v,
  });
  switch (s.k) {
    case 'value':
      return null;
    case 'any':
      return v.kind === 'function'
        ? { ...wrong(), unencodable: true }
        : deepFunction(v, path);
    case 'kind':
      return v.kind === s.kind ? null : wrong();
    case 'object':
      return v.asObjectRef()?.kind === s.kind ? null : wrong();
    case 'quantity': {
      const q = v.asQuantityRef();
      return q && unitText(q.unit) === s.unit ? null : wrong();
    }
    case 'unitKind': {
      const q = v.asQuantityRef();
      const slot = q?.unit.length === 1 ? q.unit[0]! : undefined;
      return slot &&
        slot.exponent === 1 &&
        unitEntry(slot.unit)?.kind === s.kind
        ? null
        : wrong();
    }
    case 'list': {
      if (v.kind !== 'list') {
        return wrong();
      }
      for (let i = 1; i <= v.length; i++) {
        const m = mismatch(v.index(i), s.of, [...path, i]);
        if (m) {
          return m;
        }
      }
      return null;
    }
    case 'map': {
      if (v.kind !== 'map') {
        return wrong();
      }
      const keys = new Set(v.entries().map(([k]) => k));
      for (const f of s.fields) {
        if (!keys.has(f.key)) {
          if (!f.optional) {
            return {
              expected: expectedOf(f.shape),
              got: 'nothing',
              path: [...path, f.key],
              value: nothing,
            };
          }
          continue;
        }
        const m = mismatch(v.get(f.key), f.shape, [...path, f.key]);
        if (m) {
          return m;
        }
      }
      const declared = new Set(s.fields.map(f => f.key));
      for (const [key, item] of v.entries()) {
        if (!declared.has(key)) {
          if (!s.open) {
            return {
              expected: 'nothing',
              got: item.kind,
              path: [...path, key],
              value: item,
            };
          }
          const m = deepFunction(item, [...path, key]);
          if (m) {
            return m;
          }
        }
      }
      return null;
    }
    case 'oneOf':
      return s.of.some(option => !mismatch(v, option, path)) ? null : wrong();
    case 'optional': {
      if (nothingValue(v)) {
        return null;
      }
      const m = mismatch(v, s.of, path);
      return m && m.path.length === path.length && !m.unencodable
        ? { ...m, expected: `${m.expected} or nothing` }
        : m;
    }
  }
};
// A Function Value inside a value under a data Shape.
const deepFunction = (v: Value, path: (string | number)[]): Mismatch | null => {
  if (v.kind === 'function') {
    return {
      expected: 'any',
      got: 'function',
      path,
      value: v,
      unencodable: true,
    };
  }
  if (v.kind === 'list') {
    for (let i = 1; i <= v.length; i++) {
      const m = deepFunction(v.index(i), [...path, i]);
      if (m) {
        return m;
      }
    }
  }
  if (v.kind === 'map') {
    for (const [key, item] of v.entries()) {
      const m = deepFunction(item, [...path, key]);
      if (m) {
        return m;
      }
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Script Shape checks (chapter 7): Shapes as data, decoded and checked
// iteratively so depth is bounded by the budgets, not the native stack.
// `scanned` counts what the Built-in rates measure, failed work included.
// ---------------------------------------------------------------------------

export type Path = readonly (string | number)[];
export type ShapeDefinitionError = {
  path: (string | number)[];
  reason: string;
  value: Value;
};
export type ShapeDiagnostic = Mismatch & {
  alternatives?: ShapeDiagnostic[][];
};

const scalarKinds = new Set([
  'nothing',
  'boolean',
  'number',
  'quantity',
  'text',
  'bytes',
  'list',
  'map',
  'range',
  'instant',
  'civil date',
  'pattern',
  'function',
  'object',
]);
const wrapperKeys = [
  'quantity',
  'unitKind',
  'object',
  'list',
  'oneOf',
  'optional',
  'map',
] as const;
const scalarsOf = (s: string): number => [...s].length;

type FieldAcc = { key: string; optional: boolean; shape: Shape }[];
type DecodeFrame =
  | { data: Value; path: (string | number)[]; t: 'enter' }
  | { k: 'list' | 'optional'; t: 'wrap' }
  | { n: number; t: 'oneOf' }
  | { acc: FieldAcc; open: boolean; t: 'mapDone' }
  | {
      acc: FieldAcc;
      data: Value;
      path: (string | number)[];
      seen: Set<string>;
      t: 'field';
    }
  | { acc: FieldAcc; key: string; optional: boolean; t: 'fieldDone' };

/** Reads Shape data into a Shape, or gives the first definition error. */
export const decodeShape = (
  data: Value,
): { error?: ShapeDefinitionError; scanned: number; shape?: Shape } => {
  let scanned = 0;
  const results: Shape[] = [];
  const stack: DecodeFrame[] = [{ data, path: [], t: 'enter' }];
  const fail = (
    reason: string,
    path: (string | number)[],
    value: Value,
  ): { error: ShapeDefinitionError; scanned: number } => ({
    error: { path, reason, value },
    scanned,
  });
  while (stack.length) {
    const frame = stack.pop()!;
    switch (frame.t) {
      case 'wrap':
        results.push({ k: frame.k, of: results.pop()! });
        break;
      case 'oneOf':
        results.push({
          k: 'oneOf',
          of: results.splice(results.length - frame.n, frame.n),
        });
        break;
      case 'mapDone':
        results.push({ fields: frame.acc, k: 'map', open: frame.open });
        break;
      case 'fieldDone':
        frame.acc.push({
          key: frame.key,
          optional: frame.optional,
          shape: results.pop()!,
        });
        break;
      case 'field': {
        const { data: decl, path } = frame;
        if (decl.kind !== 'map') {
          return fail('invalid field', path, decl);
        }
        const entries = new Map(decl.entries());
        scanned += entries.size;
        const key = entries.get('key');
        if (key === undefined) {
          return fail('invalid field key', path, decl);
        }
        if (key.kind !== 'text') {
          return fail('invalid field key', [...path, 'key'], key);
        }
        const inner = entries.get('shape');
        if (inner === undefined) {
          return fail('missing field shape', path, decl);
        }
        const flag = entries.get('optional');
        if (flag !== undefined && flag.kind !== 'boolean') {
          return fail('invalid flag', [...path, 'optional'], flag);
        }
        const name = key.asText()!;
        if (frame.seen.has(name)) {
          return fail('duplicate field', [...path, 'key'], key);
        }
        frame.seen.add(name);
        stack.push(
          {
            acc: frame.acc,
            key: name,
            optional: flag?.asBool() ?? false,
            t: 'fieldDone',
          },
          { data: inner, path: [...path, 'shape'], t: 'enter' },
        );
        break;
      }
      case 'enter': {
        const { data: node, path } = frame;
        scanned++;
        if (node.kind === 'text') {
          const name = node.asText()!;
          scanned += scalarsOf(name);
          if (name === 'any' || name === 'value') {
            results.push({ k: name });
          } else if (scalarKinds.has(name)) {
            results.push({ k: 'kind', kind: name });
          } else {
            return fail('unknown kind', path, node);
          }
          break;
        }
        if (node.kind !== 'map') {
          return fail('not a shape', path, node);
        }
        const entries = new Map(node.entries());
        scanned += entries.size;
        const present = wrapperKeys.filter(k => entries.has(k));
        if (present.length === 0) {
          return fail('not a shape', path, node);
        }
        if (present.length > 1) {
          return fail('ambiguous shape', path, node);
        }
        const key = present[0]!;
        const payload = entries.get(key)!;
        switch (key) {
          case 'quantity': {
            if (payload.kind !== 'text') {
              return fail('invalid unit', [...path, key], payload);
            }
            scanned += scalarsOf(payload.asText()!);
            try {
              results.push({
                k: 'quantity',
                unit: unitText(parseUnit(payload.asText()!)),
              });
            } catch {
              return fail('invalid unit', [...path, key], payload);
            }
            break;
          }
          case 'unitKind': {
            if (payload.kind === 'text') {
              scanned += scalarsOf(payload.asText()!);
            }
            if (
              payload.kind !== 'text' ||
              !unitKinds.includes(payload.asText()! as never)
            ) {
              return fail('unknown unit kind', [...path, key], payload);
            }
            results.push({ k: 'unitKind', kind: payload.asText()! });
            break;
          }
          case 'object': {
            if (payload.kind !== 'text') {
              return fail('invalid object kind', [...path, key], payload);
            }
            results.push({ k: 'object', kind: payload.asText()! });
            break;
          }
          case 'list':
          case 'optional':
            stack.push(
              { k: key, t: 'wrap' },
              { data: payload, path: [...path, key], t: 'enter' },
            );
            break;
          case 'oneOf': {
            if (payload.kind !== 'list') {
              return fail('invalid alternatives', [...path, key], payload);
            }
            if (payload.length === 0) {
              return fail('empty union', [...path, key], payload);
            }
            stack.push({ n: payload.length, t: 'oneOf' });
            for (let i = payload.length; i >= 1; i--) {
              stack.push({
                data: payload.index(i),
                path: [...path, key, i],
                t: 'enter',
              });
            }
            break;
          }
          case 'map': {
            const flag = entries.get('open');
            if (flag !== undefined && flag.kind !== 'boolean') {
              return fail('invalid flag', [...path, 'open'], flag);
            }
            if (payload.kind !== 'list') {
              return fail('invalid fields', [...path, key], payload);
            }
            const acc: FieldAcc = [];
            const seen = new Set<string>();
            stack.push({ acc, open: flag?.asBool() ?? false, t: 'mapDone' });
            for (let i = payload.length; i >= 1; i--) {
              stack.push({
                acc,
                data: payload.index(i),
                path: [...path, key, i],
                seen,
                t: 'field',
              });
            }
            break;
          }
        }
        break;
      }
    }
  }
  return { scanned, shape: results[0]! };
};

type Sink = { diags: ShapeDiagnostic[] };
type CheckFrame =
  | {
      path: (string | number)[];
      s: Shape;
      sink: Sink;
      t: 'node';
      trial: number;
      v: Value;
    }
  | {
      path: (string | number)[];
      sink: Sink;
      t: 'deep';
      trial: number;
      v: Value;
    }
  | {
      path: (string | number)[];
      s: Extract<Shape, { k: 'map' }>;
      sink: Sink;
      t: 'extras';
      trial: number;
      v: Value;
    }
  | {
      expected: string;
      path: (string | number)[];
      sink: Sink;
      t: 'missing';
      trial: number;
    }
  | {
      mark: number;
      path: (string | number)[];
      sink: Sink;
      t: 'adjust';
      trial: number;
    }
  | {
      alts: readonly Shape[];
      collected: ShapeDiagnostic[][];
      current: Sink | null;
      index: number;
      path: (string | number)[];
      s: Extract<Shape, { k: 'oneOf' }>;
      sink: Sink;
      t: 'union';
      trial: number;
      v: Value;
    };

/**
 * Every mismatch of `v` against `s`, or only the first when `first`:
 * the traversal of chapter 7, with failed union alternatives grouped.
 */
export const shapeDiagnostics = (
  v: Value,
  s: Shape,
  first: boolean,
  scanned: number,
): { diags: ShapeDiagnostic[]; scanned: number } => {
  const root: Sink = { diags: [] };
  const discarded = new Set<number>();
  let trials = 0;
  let halted = false;
  // A deep scan re-walks a shared part at each occurrence only until it
  // is known to hold no Function Value; then its logical node count is
  // charged without walking it again (#890).
  const deepInfo = new Map<Value, { clean: boolean; nodes: number }>();
  const infoOf = (rootValue: Value): { clean: boolean; nodes: number } => {
    const pending: Value[] = [rootValue];
    const order: Value[] = [];
    const seen = new Set<Value>();
    while (pending.length) {
      const next = pending.pop()!;
      if (deepInfo.has(next) || seen.has(next)) {
        continue;
      }
      seen.add(next);
      order.push(next);
      if (next.kind === 'list') {
        for (let i = 1; i <= next.length; i++) {
          pending.push(next.index(i));
        }
      } else if (next.kind === 'map') {
        for (const [, value] of next.entries()) {
          pending.push(value);
        }
      }
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const value = order[i]!;
      let clean = value.kind !== 'function';
      let nodes = 1;
      const children =
        value.kind === 'list'
          ? Array.from({ length: value.length }, (_, j) => value.index(j + 1))
          : value.kind === 'map'
            ? value.entries().map(([, item]) => item)
            : [];
      for (const child of children) {
        const info = deepInfo.get(child)!;
        clean = clean && info.clean;
        nodes += info.nodes;
      }
      deepInfo.set(value, { clean, nodes });
    }
    return deepInfo.get(rootValue)!;
  };
  const stack: CheckFrame[] = [
    { path: [], s, sink: root, t: 'node', trial: 0, v },
  ];
  const emit = (sink: Sink, trial: number, diag: ShapeDiagnostic): void => {
    sink.diags.push(diag);
    if (!first) {
      return;
    }
    if (trial === 0) {
      // The first mismatch is in: only enclosing Optional adjustments,
      // already on the stack as ancestors, may still run.
      halted = true;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.t !== 'adjust') {
          stack.splice(i, 1);
        }
      }
      return;
    }
    discarded.add(trial);
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.trial === trial) {
        stack.splice(i, 1);
      }
    }
  };
  const wrong = (
    sink: Sink,
    trial: number,
    value: Value,
    shape: Shape,
    path: (string | number)[],
  ): void =>
    emit(sink, trial, {
      expected: expectedOf(shape),
      got: gotOf(value, shape),
      path,
      value,
    });
  while (stack.length) {
    const frame = stack.pop()!;
    if (discarded.has(frame.trial)) {
      continue;
    }
    switch (frame.t) {
      case 'adjust': {
        for (let i = frame.mark; i < frame.sink.diags.length; i++) {
          const d = frame.sink.diags[i]!;
          if (
            !d.unencodable &&
            d.path.length === frame.path.length &&
            d.path.every((p, j) => p === frame.path[j])
          ) {
            d.expected += ' or nothing';
            break;
          }
        }
        break;
      }
      case 'missing':
        scanned++;
        emit(frame.sink, frame.trial, {
          expected: frame.expected,
          got: 'nothing',
          path: frame.path,
          value: nothing,
        });
        break;
      case 'deep': {
        const info = infoOf(frame.v);
        if (info.clean) {
          scanned += info.nodes;
          break;
        }
        scanned++;
        const { path, sink, trial, v: value } = frame;
        if (value.kind === 'function') {
          emit(sink, trial, {
            expected: 'any',
            got: 'function',
            path,
            unencodable: true,
            value,
          });
        } else if (value.kind === 'list') {
          for (let i = value.length; i >= 1; i--) {
            stack.push({
              path: [...path, i],
              sink,
              t: 'deep',
              trial,
              v: value.index(i),
            });
          }
        } else if (value.kind === 'map') {
          const entries = value.entries();
          for (let i = entries.length - 1; i >= 0; i--) {
            stack.push({
              path: [...path, entries[i]![0]],
              sink,
              t: 'deep',
              trial,
              v: entries[i]![1],
            });
          }
        }
        break;
      }
      case 'extras': {
        const declared = new Set(frame.s.fields.map(f => f.key));
        const deeps: CheckFrame[] = [];
        for (const [key, item] of frame.v.entries()) {
          if (declared.has(key)) {
            continue;
          }
          if (!frame.s.open) {
            scanned++;
            emit(frame.sink, frame.trial, {
              expected: 'nothing',
              got: item.kind,
              path: [...frame.path, key],
              value: item,
            });
            if (halted || discarded.has(frame.trial)) {
              break;
            }
          } else {
            deeps.push({
              path: [...frame.path, key],
              sink: frame.sink,
              t: 'deep',
              trial: frame.trial,
              v: item,
            });
          }
        }
        for (let i = deeps.length - 1; i >= 0; i--) {
          stack.push(deeps[i]!);
        }
        break;
      }
      case 'union': {
        if (frame.current) {
          if (frame.current.diags.length === 0) {
            break;
          }
          frame.collected.push(frame.current.diags);
          frame.current = null;
          frame.index++;
        }
        if (frame.index >= frame.alts.length) {
          emit(frame.sink, frame.trial, {
            alternatives: frame.collected,
            expected: expectedOf(frame.s),
            got: gotOf(frame.v, frame.s),
            path: frame.path,
            value: frame.v,
          });
          break;
        }
        const sink: Sink = { diags: [] };
        frame.current = sink;
        stack.push(frame, {
          path: frame.path,
          s: frame.alts[frame.index]!,
          sink,
          t: 'node',
          trial: ++trials,
          v: frame.v,
        });
        break;
      }
      case 'node': {
        scanned++;
        const { path, s: shape, sink, trial, v: value } = frame;
        switch (shape.k) {
          case 'value':
            break;
          case 'any':
            stack.push({ path, sink, t: 'deep', trial, v: value });
            break;
          case 'kind':
            if (value.kind !== shape.kind) {
              wrong(sink, trial, value, shape, path);
            }
            break;
          case 'object':
            if (value.asObjectRef()?.kind !== shape.kind) {
              wrong(sink, trial, value, shape, path);
            }
            break;
          case 'quantity': {
            const q = value.asQuantityRef();
            if (!q || unitText(q.unit) !== shape.unit) {
              wrong(sink, trial, value, shape, path);
            }
            break;
          }
          case 'unitKind': {
            const q = value.asQuantityRef();
            const slot = q?.unit.length === 1 ? q.unit[0]! : undefined;
            if (
              !slot ||
              slot.exponent !== 1 ||
              unitEntry(slot.unit)?.kind !== shape.kind
            ) {
              wrong(sink, trial, value, shape, path);
            }
            break;
          }
          case 'list': {
            if (value.kind !== 'list') {
              wrong(sink, trial, value, shape, path);
              break;
            }
            for (let i = value.length; i >= 1; i--) {
              stack.push({
                path: [...path, i],
                s: shape.of,
                sink,
                t: 'node',
                trial,
                v: value.index(i),
              });
            }
            break;
          }
          case 'map': {
            if (value.kind !== 'map') {
              wrong(sink, trial, value, shape, path);
              break;
            }
            stack.push({
              path,
              s: shape,
              sink,
              t: 'extras',
              trial,
              v: value,
            });
            const entries = new Map(value.entries());
            for (let i = shape.fields.length - 1; i >= 0; i--) {
              const f = shape.fields[i]!;
              const item = entries.get(f.key);
              if (item !== undefined) {
                stack.push({
                  path: [...path, f.key],
                  s: f.shape,
                  sink,
                  t: 'node',
                  trial,
                  v: item,
                });
              } else if (!f.optional) {
                stack.push({
                  expected: expectedOf(f.shape),
                  path: [...path, f.key],
                  sink,
                  t: 'missing',
                  trial,
                });
              }
            }
            break;
          }
          case 'oneOf':
            stack.push({
              alts: shape.of,
              collected: [],
              current: null,
              index: 0,
              path,
              s: shape,
              sink,
              t: 'union',
              trial,
              v: value,
            });
            break;
          case 'optional': {
            if (nothingValue(value)) {
              break;
            }
            stack.push(
              {
                mark: sink.diags.length,
                path,
                sink,
                t: 'adjust',
                trial,
              },
              {
                path,
                s: shape.of,
                sink,
                t: 'node',
                trial,
                v: value,
              },
            );
            break;
          }
        }
        break;
      }
    }
  }
  return { diags: root.diags, scanned };
};

/** A Value Path as a Script value: text keys and 1-based positions. */
export const pathValue = (path: Path): Value =>
  listValues(path.map(p => (typeof p === 'number' ? dec(String(p)) : text(p))));

/** One `explain` record: the error's fields as a plain map, without `message` or `at`. */
export const diagnosticRecord = (d: ShapeDiagnostic): Value => {
  if (d.unencodable) {
    return mapValue([
      ['code', text('not encodable')],
      ['kind', text(d.got)],
      ['path', pathValue(d.path)],
    ]);
  }
  const fields: [string, Value][] = [
    ['code', text('wrong kind')],
    ['expected', text(d.expected)],
    ['got', text(d.got)],
    ['value', d.value],
  ];
  if (d.path.length) {
    fields.push(['path', pathValue(d.path)]);
  }
  if (d.alternatives) {
    fields.push([
      'alternatives',
      listValues(
        d.alternatives.map(alt => listValues(alt.map(diagnosticRecord))),
      ),
    ]);
  }
  return mapValue(fields);
};

export type ScopeDecl = { abandon: string; opens: string } | { closes: string };

/** Synchronous, unmetered participant lifecycle work. */
export type SegmentContext<B> = {
  readonly binding: B;
  /** The first enrolled Grant. */
  readonly grantName: string;
  /** Enrolled, in enrollment order; `begin` sees only the first. */
  readonly grants: readonly SegmentGrant<B>[];
  readonly group: Group;
  readonly now: bigint;
  readonly runId: string;
  readonly scriptName: string;
  readonly segmentId: string;
};
export type SegmentGrant<B> = {
  readonly binding: B;
  readonly grantName: string;
};
export type EffectResult = {
  detail?: string;
  status: 'ok' | 'failed' | 'unknown';
};
export type SegmentLifecycle<B> = {
  begin(context: SegmentContext<B>): EffectResult;
  commit(context: SegmentContext<B>): EffectResult;
  rollback(context: SegmentContext<B>): EffectResult;
};
/** Compared by identity: Grants mapped to one coordinator share a Segment's participant (ADR 0069). */
export type SegmentCoordinator = SegmentLifecycle<unknown>;
/** Maps each binding to its coordinator once, when a Grant is created. */
export type CoordinatedLifecycle<B> = {
  coordinator(binding: B): SegmentCoordinator;
};

export type Cost = { alloc?: number; fuel: number };
export type ErrorDecl = { code: string; fields?: Record<string, FieldShape> };
type OpBase<A extends readonly Shape[] = Shape[], R = Shape> = {
  args?: A;
  /** Also callable as a Host Command, by its name alone (ADR 0094). */
  command?: boolean;
  cost: Cost;
  /** Plain-text documentation, carried only by the Host Manifest. */
  description?: string;
  errors?: ErrorDecl[];
  examples?: string[];
  /**
   * Argument Labels, one per argument after the first, that a call may write
   * between its arguments; checked at load only (ADR 0115). Empty is absent.
   */
  labels?: string[];
  result?: R;
};
/** What the Core gives a Host function at each call (chapter 9, The call). */
export type Call<B, R = Value> = {
  /** Queued, for a suspending call; ignored once the call isn't pending. */
  answer(v: R, lateCost?: { fuel: number }): void;
  readonly automatic: boolean;
  readonly binding: B;
  /** Draws more Fuel, before the work. Throws LimitReached. */
  charge(fuel: number): void;
  /** The Host Delivery that started the calling Run; absent when none did (ADR 0125). */
  readonly delivery?: string;
  fail(e: HostScriptError): void;
  readonly grantName: string;
  readonly group: Group;
  readonly id: string;
  readonly now: bigint;
  readonly runId: string;
  readonly scopeName?: string;
  readonly scriptName: string;
  readonly segmentId: string;
  readonly signal: AbortSignal;
};

/**
 * The JS type a Host function receives for an argument of Shape S (#1420):
 * scalars as their JS forms, Nothing as null, a Host Object as its handle,
 * and every other Shape as the Value. A Shape whose type was lost is unknown.
 */
export type PlainArg<S> =
  S extends Shape<infer T> ? (unknown extends T ? unknown : T) : unknown;
/** What a Host function may return for a result of Shape R: its JS form, a bigint for a number, or any Value. */
export type PlainResult<R> = [R] extends [undefined]
  ? Value
  : | (R extends Shape<infer T>
        ? unknown extends T
          ? unknown
          : T extends Decimal
            ? Decimal | bigint
            : T
        : unknown)
    | Value;
type PlainArgs<A extends readonly Shape[]> = {
  -readonly [K in keyof A]: PlainArg<A[K]>;
};

export type ImmediateOp<
  B,
  A extends readonly Shape[] = Shape[],
  R = Shape,
> = OpBase<A, R> & {
  do(call: Call<B, PlainResult<R>>, ...args: PlainArgs<A>): PlainResult<R>;
  mode: 'immediate';
  scope?: ScopeDecl;
  segmentBound?: boolean;
};
export type SuspendingOp<
  B,
  A extends readonly Shape[] = Shape[],
  R = Shape,
> = OpBase<A, R> & {
  maxPendingMs?: number;
  mode: 'suspending';
  run?(
    call: Call<B, PlainResult<R>>,
    ...args: PlainArgs<A>
  ): Promise<PlainResult<R>>;
  start?(call: Call<B, PlainResult<R>>, ...args: PlainArgs<A>): void;
};
export type FireOp<B, A extends readonly Shape[] = Shape[], R = Shape> = OpBase<
  A,
  R
> & {
  fire(call: Call<B, PlainResult<R>>, ...args: PlainArgs<A>): void;
  mode: 'fire-and-forget';
};
/** An Operation whose Host function takes the JS forms of its Shapes (#1420). */
export type Operation<B, A extends readonly Shape[] = Shape[], R = Shape> =
  ImmediateOp<B, A, R> | SuspendingOp<B, A, R> | FireOp<B, A, R>;

/** The Core's own form: every argument and result is a Value. */
export type ValueImmediateOp<B> = OpBase & {
  do(call: Call<B>, ...args: Value[]): Value;
  mode: 'immediate';
  scope?: ScopeDecl;
  segmentBound?: boolean;
};
export type ValueSuspendingOp<B> = OpBase & {
  maxPendingMs?: number;
  mode: 'suspending';
  run?(call: Call<B>, ...args: Value[]): Promise<Value>;
  start?(call: Call<B>, ...args: Value[]): void;
};
export type ValueFireOp<B> = OpBase & {
  fire(call: Call<B>, ...args: Value[]): void;
  mode: 'fire-and-forget';
};
export type ValueOperation<B> =
  ValueImmediateOp<B> | ValueSuspendingOp<B> | ValueFireOp<B>;

type OpDecl = {
  args?: readonly Shape[];
  mode: Operation<unknown>['mode'];
  result?: Shape;
};
type ArgsOf<D> = D extends { args: infer A extends readonly Shape[] }
  ? A
  : D extends { args?: infer A extends readonly Shape[] }
    ? A
    : [];
type ResultOf<D> = D extends { result: infer R }
  ? R
  : D extends { result?: infer R }
    ? R
    : undefined;
type ByMode<B, D> = D extends { mode: 'immediate' }
  ? ImmediateOp<B, ArgsOf<D>, ResultOf<D>>
  : D extends { mode: 'suspending' }
    ? SuspendingOp<B, ArgsOf<D>, ResultOf<D>>
    : FireOp<B, ArgsOf<D>, ResultOf<D>>;
/**
 * Each Operation typed from its own `args` and `result`: the Pick lets
 * TypeScript infer them from the literal before it types the callbacks.
 */
export type Operations<B, O> = {
  [K in keyof O]: Pick<O[K], keyof OpDecl & keyof O[K]> & ByMode<B, O[K]>;
};

/** Thrown by `call.charge` when the Run's Fuel can't cover it. */
export class LimitReached extends Error {
  override name = 'LimitReached';
}

export type ReleaseReason = 'stop' | 'reload' | 'revoke' | 'disable';
/** One loaded Script's named Grant, identified within its Group. */
export type GrantContext<B> = {
  readonly binding: B;
  readonly grantName: string;
  readonly group: Group;
  readonly now: bigint;
  readonly reason: ReleaseReason;
  readonly scriptName: string;
};
/** Synchronous, unmetered cleanup. Exceptions cannot refuse release. */
export type ReleaseHook<B> = (context: GrantContext<B>) => void;

export type CapabilityDef<B> = {
  /** Maps a Grant's binding to its Segment Coordinator. */
  coordinator?(binding: B): SegmentCoordinator;
  /** A reusable template. Each load binds it to one Script. */
  grant(ops: readonly string[] | 'all', binding: B): Grant<B>;
  /** A plain lifecycle, making each Grant its own coordinator. */
  readonly lifecycle?: SegmentLifecycle<B>;
  readonly name: string;
  /** Its Operations, ordered by name. */
  readonly operations: ReadonlyMap<string, ValueOperation<B>>;
  release?(context: GrantContext<B>): void;
};
export type Grant<B> = {
  readonly binding: B;
  readonly capability: CapabilityDef<B>;
  /** Resolved at Grant creation; absent when the Grant is its own coordinator. */
  readonly coordinator?: SegmentCoordinator;
  readonly ops: ReadonlySet<string>;
};

const refusedNames = new Set(['ask', 'tell', 'send', 'wait', 'end']);
const scopeWord = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z_a-z]\w*$/.test(value);
const hasHooks = (lifecycle: unknown): lifecycle is SegmentLifecycle<never> =>
  !!lifecycle &&
  typeof lifecycle === 'object' &&
  ['begin', 'commit', 'rollback'].every(
    phase =>
      typeof (lifecycle as Record<string, unknown>)[phase] === 'function',
  );

/**
 * Define a Capability whose Host functions take and return Values. The
 * standard Capabilities and replay Stubs use this form.
 */
export const defineValueCapability = <B = void>(
  name: string,
  ops: Record<string, ValueOperation<B>>,
  lifecycle?: SegmentLifecycle<B> | CoordinatedLifecycle<B>,
  release?: ReleaseHook<B>,
): CapabilityDef<B> => {
  if (release !== undefined && typeof release !== 'function') {
    invalidValue('A release hook must be a function');
  }
  for (const op of Object.keys(ops)) {
    if (refusedNames.has(op)) {
      throw new HostError('invalid value', `${op} can't name an Operation`);
    }
  }
  const coordinated =
    !!lifecycle && typeof lifecycle === 'object' && 'coordinator' in lifecycle
      ? lifecycle
      : undefined;
  if (coordinated && typeof coordinated.coordinator !== 'function') {
    invalidValue('A coordinator mapping must be a function');
  }
  if (lifecycle !== undefined && !coordinated && !hasHooks(lifecycle)) {
    invalidValue(
      'A participant requires synchronous begin, commit and rollback hooks',
    );
  }
  const hooks = coordinated ? undefined : (lifecycle as SegmentLifecycle<B>);
  const scopes = new Map<string, string>();
  const scopeEffects = new Map<string, boolean>();
  for (const [opName, op] of Object.entries(ops)) {
    if (op.command !== undefined && typeof op.command !== 'boolean') {
      invalidValue('command must be Boolean');
    }
    // A Command Call can't start with a Reserved Word (ADR 0094).
    if (op.command && RESERVED.has(opName)) {
      invalidValue(`${opName} is a Reserved Word, so it can't be a command`);
    }
    if (op.labels !== undefined) {
      if (
        !Array.isArray(op.labels) ||
        [...op.labels].some(
          label => typeof label !== 'string' || !validArgumentLabel(label),
        )
      ) {
        invalidValue('labels must be a list of Argument Label words');
      }
      // One label per argument after the first; an empty list is none.
      if (op.labels.length && op.labels.length !== (op.args?.length ?? 0) - 1) {
        invalidValue('labels must have one entry per argument after the first');
      }
    }
    if (op.description !== undefined && typeof op.description !== 'string') {
      invalidValue('description must be text');
    }
    if (
      op.examples !== undefined &&
      (!Array.isArray(op.examples) ||
        [...op.examples].some(example => typeof example !== 'string'))
    ) {
      invalidValue('examples must be a list of text');
    }
    const metadata = op as ValueOperation<B> & {
      scope?: ScopeDecl;
      segmentBound?: boolean;
    };
    if (
      metadata.segmentBound !== undefined &&
      typeof metadata.segmentBound !== 'boolean'
    ) {
      invalidValue('segmentBound must be Boolean');
    }
    if (metadata.segmentBound && (op.mode !== 'immediate' || !lifecycle)) {
      invalidValue(
        'Segment-bound Operations require immediate mode and lifecycle hooks',
      );
    }
    const scope = metadata.scope;
    if (scope === undefined) {
      continue;
    }
    if (op.mode !== 'immediate' || !scope || typeof scope !== 'object') {
      invalidValue('Scopes require immediate Operations');
    }
    const scopeName = 'opens' in scope ? scope.opens : scope.closes;
    const bound = metadata.segmentBound === true;
    if (scopeEffects.has(scopeName) && scopeEffects.get(scopeName) !== bound) {
      invalidValue(
        'All lifecycle Operations of a scope must agree on segmentBound',
      );
    }
    scopeEffects.set(scopeName, bound);
    const keys = Object.keys(scope).sort().join(',');
    if (keys === 'abandon,opens' && 'opens' in scope) {
      if (!scopeWord(scope.opens) || !scopeWord(scope.abandon)) {
        invalidValue('Invalid scope name or abandonment Operation');
      }
      const previous = scopes.get(scope.opens);
      if (previous && previous !== scope.abandon) {
        invalidValue('Scope openers must agree on abandonment');
      }
      scopes.set(scope.opens, scope.abandon);
    } else if (keys === 'closes' && 'closes' in scope) {
      if (!scopeWord(scope.closes)) {
        invalidValue('Invalid scope name');
      }
    } else {
      invalidValue(`Invalid scope declaration for ${opName}`);
    }
  }
  for (const [scopeName, abandon] of scopes) {
    const op = ops[abandon];
    if (
      !op ||
      op.mode !== 'immediate' ||
      !op.scope ||
      !('closes' in op.scope) ||
      op.scope.closes !== scopeName ||
      (op.args?.length ?? 0) !== 0 ||
      op.result?.k !== 'kind' ||
      op.result.kind !== 'nothing'
    ) {
      invalidValue(
        'Abandonment must close its scope immediately, take no arguments and return Nothing',
      );
    }
  }
  for (const op of Object.values(ops)) {
    if (
      op.mode === 'immediate' &&
      op.scope &&
      'closes' in op.scope &&
      !scopes.has(op.scope.closes)
    ) {
      invalidValue('A closing scope has no opener');
    }
  }
  const operations = new Map(
    Object.keys(ops)
      .sort()
      .map(op => {
        const declaration = ops[op]!;
        const stored =
          declaration.mode === 'immediate' && declaration.scope
            ? {
                ...declaration,
                scope: Object.freeze({ ...declaration.scope }),
              }
            : Object.isExtensible(declaration)
              ? declaration
              : { ...declaration };
        if (!(valueForm in stored)) {
          Object.defineProperty(stored, valueForm, {
            value: true,
            enumerable: true,
          });
        }
        return [op, stored as ValueOperation<B>] as const;
      }),
  );
  const def: CapabilityDef<B> = {
    name,
    operations,
    ...(release ? { release } : {}),
    ...(hooks
      ? {
          lifecycle: Object.freeze({
            begin: hooks.begin,
            commit: hooks.commit,
            rollback: hooks.rollback,
          }),
        }
      : {}),
    ...(coordinated
      ? {
          coordinator: (binding: B) => coordinated.coordinator(binding),
        }
      : {}),
    grant: (granted, binding) => {
      const names = granted === 'all' ? [...operations.keys()] : granted;
      for (const op of names) {
        if (!operations.has(op)) {
          throw new HostError(
            'invalid value',
            `${name} has no Operation ${op}`,
          );
        }
      }
      for (const name of names) {
        const op = operations.get(name)!;
        if (
          op.mode === 'immediate' &&
          op.scope &&
          'opens' in op.scope &&
          !names.includes(op.scope.abandon)
        ) {
          invalidValue(
            'An opener requires its abandonment Operation in the Grant',
          );
        }
      }
      // Resolved once, so the mapping holds for the Grant's life (ADR 0069).
      const coordinator = def.coordinator?.(binding);
      if (def.coordinator && !hasHooks(coordinator)) {
        invalidValue(
          'A Segment Coordinator requires synchronous begin, commit and rollback hooks',
        );
      }
      return {
        capability: def,
        binding,
        ops: new Set(names),
        ...(coordinator ? { coordinator } : {}),
      };
    },
  };
  return def;
};

/** A checked argument as the JS form its Shape names (#1420). */
const plainArg = (s: Shape | undefined, v: Value): unknown => {
  switch (s?.k) {
    case 'kind':
      switch (s.kind) {
        case 'nothing':
          return null;
        case 'boolean':
          return v.asBool();
        case 'number':
          return v.asDecimal();
        case 'text':
          return v.asText();
        case 'bytes':
          return v.asBytes();
        case 'instant':
          return v.asInstant();
      }
      return v;
    case 'object': {
      const ref = v.asObjectRef()!;
      return (
        v.asObject() ?? invalidValue(`No Host Object ${ref.kind} ${ref.id}`)
      );
    }
    case 'optional':
      return v.kind === 'nothing' ? null : plainArg(s.of, v);
  }
  return v;
};

const isHostObject = (r: object): r is HostObject =>
  'value' in r && Value.isValue(r.value) && r.value.kind === 'object';

/**
 * A Host function's result as a Value. A JS form that doesn't match the
 * Shape is passed on unchanged, so the Core's result check refuses it.
 */
const resultValue = (s: Shape | undefined, r: unknown): unknown => {
  if (s === undefined || Value.isValue(r)) {
    return r;
  }
  switch (s.k) {
    case 'kind':
      switch (s.kind) {
        case 'nothing':
          return r === null || r === undefined ? nothing : r;
        case 'boolean':
          return typeof r === 'boolean' ? bool(r) : r;
        case 'number':
          return isDecimal(r)
            ? dec(r.toString())
            : typeof r === 'bigint'
              ? num(r)
              : r;
        case 'text':
          return typeof r === 'string' ? text(r) : r;
        case 'bytes':
          return Object.prototype.toString.call(r) === '[object Uint8Array]'
            ? bytes(r as Uint8Array)
            : r;
        case 'instant':
          return typeof r === 'bigint' ? instant(r) : r;
      }
      return r;
    case 'object':
      return r && typeof r === 'object' && isHostObject(r) ? r.value : r;
    case 'optional':
      return r === null || r === undefined ? nothing : resultValue(s.of, r);
  }
  return r;
};

/**
 * Marks a defined Capability's Operations as already in Value form. It is an
 * enumerable symbol, so it survives `{ ...op }` when a Host reuses one.
 */
const valueForm = Symbol('value form');

/** The Core's Value form of an Operation whose Host function is typed. */
const valueOperation = <B>(op: Operation<B>): ValueOperation<B> => {
  if (!op || typeof op !== 'object' || valueForm in op) {
    return op as ValueOperation<B>;
  }
  const { args = [], result } = op as OpBase;
  const plain = (vs: Value[]) => vs.map((v, i) => plainArg(args[i], v));
  // The wasm Core freezes its calls, so the override is defined, not assigned.
  const answering = (call: Call<B>): Call<B, unknown> =>
    Object.create(call, {
      answer: {
        value: (r: unknown, lateCost?: { fuel: number }) =>
          call.answer(resultValue(result, r) as Value, lateCost),
      },
    }) as Call<B, unknown>;
  const fn = op as unknown as Record<
    'do' | 'fire' | 'run' | 'start',
    ((call: Call<B, unknown>, ...args: unknown[]) => unknown) | undefined
  >;
  const adapted: Record<string, unknown> = { ...op };
  if (typeof fn.do === 'function') {
    const run = fn.do;
    adapted.do = (call: Call<B>, ...vs: Value[]) =>
      resultValue(result, run.call(op, call, ...plain(vs)));
  }
  if (typeof fn.fire === 'function') {
    const run = fn.fire;
    adapted.fire = (call: Call<B>, ...vs: Value[]) =>
      run.call(op, call, ...plain(vs));
  }
  if (typeof fn.run === 'function') {
    const run = fn.run;
    adapted.run = async (call: Call<B>, ...vs: Value[]) =>
      resultValue(result, await run.call(op, call, ...plain(vs)));
  }
  if (typeof fn.start === 'function') {
    const run = fn.start;
    adapted.start = (call: Call<B>, ...vs: Value[]) =>
      run.call(op, answering(call), ...plain(vs));
  }
  return adapted as ValueOperation<B>;
};

export type CapabilityDefiner<B> = <const O extends Record<string, OpDecl>>(
  name: string,
  ops: Operations<B, O>,
  lifecycle?: SegmentLifecycle<B> | CoordinatedLifecycle<B>,
  release?: ReleaseHook<B>,
) => CapabilityDef<B>;

const defineTyped: CapabilityDefiner<unknown> = (
  name,
  ops,
  lifecycle,
  release,
) =>
  defineValueCapability(
    name,
    Object.fromEntries(
      Object.entries(ops as Record<string, Operation<unknown>>).map(
        ([op, declaration]) => [op, valueOperation(declaration)],
      ),
    ),
    lifecycle,
    release,
  );

/**
 * Define a Capability, once per process (chapter 9, Capabilities). Each Host
 * function takes the JS forms of its argument Shapes and may return its
 * result's JS form (#1420). With a binding, name its type by currying:
 * `defineCapability<Db>()(name, ops)`.
 */
export function defineCapability<const O extends Record<string, OpDecl>>(
  name: string,
  ops: Operations<void, O>,
  lifecycle?: SegmentLifecycle<void> | CoordinatedLifecycle<void>,
  release?: ReleaseHook<void>,
): CapabilityDef<void>;
export function defineCapability<B>(): CapabilityDefiner<B>;
export function defineCapability(...input: unknown[]): unknown {
  return input.length === 0
    ? defineTyped
    : defineTyped(...(input as Parameters<CapabilityDefiner<unknown>>));
}
