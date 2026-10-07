// Chapter 7's `store` declarations and chapter 9's `add`. The Core checks the
// Shapes, `invalid key` and the result kinds; keeping the Store, with its
// reservations and quotas, is the Host implementation's obligation.
import {
  defineCapability,
  shape,
  type Call,
  type CapabilityDef,
  type ImmediateOp,
  type SegmentLifecycle,
  type Shape,
} from './capabilities';
import { HostError, ScriptError as HostScriptError } from './errors';
import { errorMessages } from './generated/machine';
import { arithmetic, ScriptError } from './operations';
import { costOf, fixed, type Costs } from './standard-capabilities';
import { registerStandardChecks } from './standard-capability-checks';
import { bool, map, nothing, type Value } from './values';

/**
 * The binding is the Store's name. `set`, `delete`, `increment` and `swap`
 * act on the calling Segment's pending writes, which `commit` applies and
 * `rollback` discards (chapter 7, ADR 0062).
 */
export type StoreImpl = SegmentLifecycle<string> & {
  delete(call: Call<string>, key: string): void;
  get(call: Call<string>, key: string, fallback?: Value): Value;
  increment(call: Call<string>, key: string, by?: Value): Value;
  keys(call: Call<string>, prefix?: string): Value;
  set(call: Call<string>, key: string, value: Value): void;
  swap(
    call: Call<string>,
    key: string,
    expected: Value,
    replacement: Value,
  ): boolean;
};

/** A Core-raised error as the Host sees it, with its catalogue message. */
export const hostScriptError = (
  code: string,
  fields: readonly (readonly [string, Value])[],
): HostScriptError => {
  const template = errorMessages[code as keyof typeof errorMessages] ?? code;
  const message = template.replaceAll(/{(\w+)}/g, (_, name: string) => {
    const field = fields.find(([k]) => k === name);
    return field ? field[1].toString() : `{${name}}`;
  });
  return new HostScriptError(
    code,
    message,
    map(fields.map(([k, v]) => [k, v])),
  );
};

/** The `+` rules outside any Run, uncharged (chapter 9, Adding). */
export const add = (a: Value, b: Value): Value => {
  try {
    return arithmetic('add', a, b);
  } catch (error) {
    throw error instanceof ScriptError
      ? hostScriptError(error.code, error.fields)
      : error;
  }
};

const textShape = shape.text;
const keyShape = textShape;
const quantityShape: Shape = { k: 'kind', kind: 'quantity' };
const amountShape = shape.oneOf(shape.number, quantityShape);
const OPERATIONS = ['get', 'set', 'delete', 'keys', 'increment', 'swap'];

const isText = (data: Value, field: string) => data.get(field).kind === 'text';
// The fields each code the Host may fail with must carry.
const errorFields: Record<string, (data: Value) => boolean> = {
  "can't store": data => isText(data, 'kind'),
  'store full': data =>
    ['size', 'keys', 'value'].includes(data.get('limit').asText() ?? ''),
  'store busy': data => isText(data, 'key'),
  'wrong kind': data =>
    isText(data, 'expected') &&
    isText(data, 'got') &&
    data.entries().some(([k]) => k === 'value'),
  'incompatible units': data => isText(data, 'left') && isText(data, 'right'),
  overflow: data => isText(data, 'operator'),
};
const checkKey = (args: readonly Value[]) => {
  if (args[0]!.asText() === '') {
    throw new ScriptError('invalid key', [], true);
  }
};

const errors = (...codes: string[]) => codes.map(code => ({ code }));
const writes = ["can't store", 'store full', 'store busy'];
const key = (args: readonly Value[]) => args[0]!.asText()!;

/** The Store is the Host's; the Grant binding names it. */
export const storeCapability = (
  impl: StoreImpl,
  costs: Costs,
): CapabilityDef<string> => {
  for (const name of [...OPERATIONS, 'begin', 'commit', 'rollback']) {
    if (!impl || typeof impl[name as keyof StoreImpl] !== 'function') {
      throw new HostError('invalid value', `Store needs ${name}`);
    }
  }
  const operations: Record<string, ImmediateOp<string>> = {
    get: {
      mode: 'immediate',
      args: [keyShape, shape.optional(shape.any)],
      result: shape.any,
      errors: [],
      cost: costOf(costs, 'get'),
      do: (call, ...args) => impl.get(call, key(args), args[1]),
    },
    set: {
      mode: 'immediate',
      args: [keyShape, shape.any],
      result: shape.nothing,
      errors: errors(...writes),
      cost: costOf(costs, 'set'),
      segmentBound: true,
      do: (call, ...args) => {
        impl.set(call, key(args), args[1]!);
        return nothing;
      },
    },
    delete: {
      mode: 'immediate',
      args: [keyShape],
      result: shape.nothing,
      errors: errors('store busy'),
      cost: costOf(costs, 'delete'),
      segmentBound: true,
      do: (call, ...args) => {
        impl.delete(call, key(args));
        return nothing;
      },
    },
    keys: {
      mode: 'immediate',
      args: [shape.optional(textShape)],
      result: shape.listOf(textShape),
      errors: [],
      cost: costOf(costs, 'keys'),
      do: (call, prefix) => impl.keys(call, prefix?.asText()),
    },
    increment: {
      mode: 'immediate',
      args: [keyShape, shape.optional(amountShape)],
      result: amountShape,
      errors: errors(
        'wrong kind',
        'incompatible units',
        'overflow',
        'store full',
        'store busy',
      ),
      cost: costOf(costs, 'increment'),
      segmentBound: true,
      do: (call, ...args) => impl.increment(call, key(args), args[1]),
    },
    swap: {
      mode: 'immediate',
      args: [keyShape, shape.any, shape.any],
      result: shape.bool,
      errors: errors(...writes),
      cost: costOf(costs, 'swap'),
      segmentBound: true,
      do: (call, ...args) =>
        bool(impl.swap(call, key(args), args[1]!, args[2]!)),
    },
  };
  const capability = defineCapability<string>('store', operations, {
    begin: context => impl.begin(context),
    commit: context => impl.commit(context),
    rollback: context => impl.rollback(context),
  });
  // Segment-bound declarations are copied, so the checks attach to the copies.
  for (const [name, op] of capability.operations) {
    registerStandardChecks(op, {
      error: (code, data) =>
        Boolean(
          op.errors?.some(e => e.code === code) && errorFields[code]?.(data),
        ),
      ...(name === 'keys' ? {} : { arguments: checkKey }),
    });
  }
  return fixed(capability);
};
