// Plain-JS Handler calls use only the shared Script interface (ADR 0130).
import type { Script } from './embedding';
import { HostError, invalidValue } from './errors';
import { fromValue, toValue, type PlainValue } from './plain';
import { validStaticMessageName } from './selectors';

/** Untyped Handler calls accept safe-integer JS numbers and plain data. */
export type Handlers = {
  [name: string]: (
    ...args: (PlainValue | number | bigint)[]
  ) => Promise<PlainValue>;
};

/** The Host supplies T without runtime checking of its arguments or results. */
export type ScriptWithHandlers<T = Handlers> = Script & {
  readonly handlers: T;
};

/**
 * Calls invoke with integer-mode toValue arguments and default fromValue answers.
 * The Script's existing driver or Host Pump loop still runs the Requests.
 * Promise hooks, symbols and non-message properties read as undefined.
 */
export const handlersOf = <T = Handlers>(script: Script): T =>
  new Proxy(Object.create(null), {
    get: (_target, name: string | symbol) => {
      if (
        typeof name !== 'string' ||
        name === 'then' ||
        Object.hasOwn(Object.prototype, name) ||
        !validStaticMessageName(name)
      ) {
        return undefined;
      }
      return async (...args: unknown[]) => {
        const values = args.map((arg, index) => {
          try {
            return toValue(arg, { numbers: 'integer' });
          } catch (error) {
            if (error instanceof HostError && error.code === 'invalid value') {
              invalidValue(
                `Argument ${index + 1} to ${name}: ${error.message}`,
              );
            }
            throw error;
          }
        });
        return fromValue(await script.invoke(name, ...values));
      };
    },
  });
