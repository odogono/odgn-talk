// Chapter 9's Capabilities: Operation Declarations with Shapes, defined once
// per process, and Grants that bind them to a Script. The Core checks each
// argument against its Shape before the Host function runs, and each result
// after (chapter 6, Errors from Capabilities).
import {
  HostError,
  invalidValue,
  type ScriptError as HostScriptError,
} from './errors';
import type { ObjectKind } from './objects';
import { parseUnit, unitEntry, unitText } from './units';
import { nothing, type Value } from './values';
import type { Group } from './group';

export type Shape =
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
  any: { k: 'any' } as Shape,
  value: { k: 'value' } as Shape,
  nothing: kind('nothing'),
  bool: kind('boolean'),
  number: kind('number'),
  text: kind('text'),
  bytes: kind('bytes'),
  instant: kind('instant'),
  civilDate: kind('civil date'),
  range: kind('range'),
  pattern: kind('pattern'),
  function: kind('function'),
  object: <N>(kind: ObjectKind<N>): Shape => ({
    k: 'object',
    kind: kind.name,
  }),
  quantityOf: (unit: string): Shape => ({
    k: 'quantity',
    unit: unitText(parseUnit(unit)),
  }),
  quantityKind: (unitKind: string): Shape => ({
    k: 'unitKind',
    kind: unitKind,
  }),
  listOf: (of: Shape): Shape => ({ k: 'list', of }),
  map: (fields: Record<string, FieldShape>): Shape => ({
    k: 'map',
    fields: fieldsOf(fields),
    open: false,
  }),
  openMap: (fields: Record<string, FieldShape>): Shape => ({
    k: 'map',
    fields: fieldsOf(fields),
    open: true,
  }),
  oneOf: (...of: Shape[]): Shape => ({ k: 'oneOf', of }),
  optional: (of: Shape): Shape => ({ k: 'optional', of }),
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

export type ScopeDecl = { abandon: string; opens: string } | { closes: string };

/** Synchronous, unmetered participant lifecycle work. */
export type SegmentContext<B> = {
  readonly binding: B;
  readonly grantName: string;
  readonly group: Group;
  readonly now: bigint;
  readonly runId: string;
  readonly scriptName: string;
  readonly segmentId: string;
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

export type Cost = { alloc?: number; fuel: number };
export type ErrorDecl = { code: string; fields?: Record<string, FieldShape> };
type OpBase = {
  args?: Shape[];
  cost: Cost;
  errors?: ErrorDecl[];
  result?: Shape;
};
/** What the Core gives a Host function at each call (chapter 9, The call). */
export type Call<B> = {
  /** Queued, for a suspending call; ignored once the call isn't pending. */
  answer(v: Value, lateCost?: { fuel: number }): void;
  readonly automatic: boolean;
  readonly binding: B;
  /** Draws more Fuel, before the work. Throws LimitReached. */
  charge(fuel: number): void;
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
export type ImmediateOp<B> = OpBase & {
  do(call: Call<B>, ...args: Value[]): Value;
  mode: 'immediate';
  scope?: ScopeDecl;
  segmentBound?: boolean;
};
export type SuspendingOp<B> = OpBase & {
  maxPendingMs?: number;
  mode: 'suspending';
  run?(call: Call<B>, ...args: Value[]): Promise<Value>;
  start?(call: Call<B>, ...args: Value[]): void;
};
export type FireOp<B> = OpBase & {
  fire(call: Call<B>, ...args: Value[]): void;
  mode: 'fire-and-forget';
};
export type Operation<B> = ImmediateOp<B> | SuspendingOp<B> | FireOp<B>;

/** Thrown by `call.charge` when the Run's Fuel can't cover it. */
export class LimitReached extends Error {
  override name = 'LimitReached';
}

export type CapabilityDef<B> = {
  /** A reusable template. Each load binds it to one Script. */
  grant(ops: readonly string[] | 'all', binding: B): Grant<B>;
  readonly lifecycle?: SegmentLifecycle<B>;
  readonly name: string;
  /** Its Operations, ordered by name. */
  readonly operations: ReadonlyMap<string, Operation<B>>;
};
export type Grant<B> = {
  readonly binding: B;
  readonly capability: CapabilityDef<B>;
  readonly ops: ReadonlySet<string>;
};

const refusedNames = new Set(['ask', 'tell', 'send', 'wait', 'end']);
const scopeWord = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z_a-z]\w*$/.test(value);

/** Define a Capability, once per process (chapter 9, Capabilities). */
export const defineCapability = <B = void>(
  name: string,
  ops: Record<string, Operation<B>>,
  lifecycle?: SegmentLifecycle<B>,
): CapabilityDef<B> => {
  for (const op of Object.keys(ops)) {
    if (refusedNames.has(op)) {
      throw new HostError('invalid value', `${op} can't name an Operation`);
    }
  }
  if (
    lifecycle !== undefined &&
    (!lifecycle ||
      !['begin', 'commit', 'rollback'].every(
        phase =>
          typeof lifecycle[phase as keyof SegmentLifecycle<B>] === 'function',
      ))
  ) {
    invalidValue(
      'A participant requires synchronous begin, commit and rollback hooks',
    );
  }
  const scopes = new Map<string, string>();
  const scopeEffects = new Map<string, boolean>();
  for (const [opName, op] of Object.entries(ops)) {
    const metadata = op as Operation<B> & {
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
        return [
          op,
          declaration.mode === 'immediate' &&
          (declaration.scope || declaration.segmentBound !== undefined)
            ? {
                ...declaration,
                ...(declaration.scope
                  ? { scope: Object.freeze({ ...declaration.scope }) }
                  : {}),
              }
            : declaration,
        ] as const;
      }),
  );
  const def: CapabilityDef<B> = {
    name,
    operations,
    ...(lifecycle
      ? {
          lifecycle: Object.freeze({
            begin: lifecycle.begin,
            commit: lifecycle.commit,
            rollback: lifecycle.rollback,
          }),
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
      return { capability: def, binding, ops: new Set(names) };
    },
  };
  return def;
};
