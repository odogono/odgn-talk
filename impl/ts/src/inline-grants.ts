// Plain-JS Operations share the ordinary Capability and Grant boundary (ADR 0130).
import {
  defineCapability,
  shape,
  type Grant,
  type Operation,
} from './capabilities';
import { HostError, invalidValue, ScriptError } from './errors';
import { fromValue, toValue } from './plain';

/** Argument and result types are supplied by the Host, without runtime checking. */
export type InlineFunction = (...args: never[]) => unknown;
export type InlineOperation =
  | InlineFunction
  | { arity?: number; fn: InlineFunction }
  | { arity?: number; async: InlineFunction; maxPendingMs?: number };

type InlineDeclaration = Operation<
  void,
  (typeof shape.value)[],
  typeof shape.value
>;

// Conversion failures are Script errors; exceptions from the callback itself
// retain the normal Host callback behavior.
const resultValue = (result: unknown) => {
  try {
    return toValue(result, { numbers: 'integer' });
  } catch (error) {
    if (error instanceof HostError && error.code === 'invalid value') {
      throw new ScriptError(error.code, error.message);
    }
    throw error;
  }
};

/**
 * Defines one Capability per key and grants all its Operations. Arguments use
 * default fromValue; results use integer-mode toValue. Arity is fn.length unless
 * overridden, including for async functions, which also receive a final signal.
 */
export const inlineGrants = (
  capabilities: Readonly<
    Record<string, Readonly<Record<string, InlineOperation>>>
  >,
): Record<string, Grant<void>> =>
  Object.fromEntries(
    Object.entries(capabilities).map(([name, operations]) => {
      const ops: Record<string, InlineDeclaration> = Object.fromEntries(
        Object.entries(operations).map(([opName, op]) => {
          const spec = typeof op === 'function' ? { fn: op } : op;
          const fn = 'async' in spec ? spec.async : spec.fn;
          const arity = spec.arity ?? fn.length;
          if (!Number.isSafeInteger(arity) || arity < 0) {
            invalidValue(
              'An inline Operation arity must be a non-negative safe integer',
            );
          }
          const base = {
            args: Array.from({ length: arity }, () => shape.value),
            result: shape.value,
            cost: { fuel: 0 },
            command: true,
          };
          const operation: InlineDeclaration =
            'async' in spec
              ? {
                  ...base,
                  mode: 'suspending',
                  maxPendingMs: spec.maxPendingMs,
                  run: async (call, ...args) =>
                    resultValue(
                      await Reflect.apply(fn, undefined, [
                        ...args.map(value => fromValue(value)),
                        call.signal,
                      ]),
                    ),
                }
              : {
                  ...base,
                  mode: 'immediate',
                  do: (_call, ...args) =>
                    resultValue(
                      Reflect.apply(
                        fn,
                        undefined,
                        args.map(value => fromValue(value)),
                      ),
                    ),
                };
          return [opName, operation];
        }),
      );
      return [name, defineCapability(name, ops).grant('all', undefined)];
    }),
  );
