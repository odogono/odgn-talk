// Chapter 7's optional `user` Standard Capability (ADR 0077). The Host shows
// prompts and answers them; the Core checks arguments and `choose` answers.
import {
  defineCapability,
  shape,
  type Call,
  type CapabilityDef,
  type Operation,
} from './capabilities';
import { HostError } from './errors';
import { ScriptError } from './operations';
import { costOf, fixed, type Costs } from './standard-capabilities';
import { registerStandardChecks } from './standard-capability-checks';
import { text, type Value } from './values';

/** An omitted prompt, default or title is "". */
export type UserImpl = {
  choose(
    call: Call<unknown>,
    items: readonly string[],
    prompt: string,
    multiple: boolean,
  ): void;
  confirm(call: Call<unknown>, message: string): void;
  enter(call: Call<unknown>, message: string, fallback: string): void;
  notify(call: Call<unknown>, message: string, title: string): void;
};

/** Every `confirm`, `choose` and `enter` waits as long as `console`'s `read`. */
export const USER_MAX_PENDING_MS = 2_147_483_647;

const optionalText = shape.optional(shape.text);
const options = (fields: Record<string, ReturnType<typeof shape.optional>>) =>
  shape.optional(
    shape.map(
      Object.fromEntries(
        Object.entries(fields).map(([key, s]) => [
          key,
          { optional: true, shape: s },
        ]),
      ),
    ),
  );
const userBusy = [{ code: 'user busy', fields: {} }];
const itemsOf = (list: Value): Value[] =>
  Array.from({ length: list.length }, (_, i) => list.index(i + 1));

// An option the Script gave, or undefined when it is omitted or Nothing.
const option = (options: Value | undefined, key: string): Value | undefined => {
  const value = options?.kind === 'map' ? options.get(key) : undefined;
  return value?.kind === 'nothing' ? undefined : value;
};
const optionText = (options: Value | undefined, key: string): string =>
  option(options, key)?.asText() ?? '';
const multipleOf = (options: Value | undefined): boolean =>
  option(options, 'multiple')?.asBool() === true;

// A `choose` answer: Nothing, one of `items`, or with `multiple` a
// subsequence of them (chapter 7).
const chosen = (answer: Value, args: readonly Value[]): boolean => {
  if (answer.kind === 'nothing') {
    return true;
  }
  const items = itemsOf(args[0]!);
  if (!multipleOf(args[1])) {
    return answer.kind === 'text' && items.some(item => item.equals(answer));
  }
  if (answer.kind !== 'list') {
    return false;
  }
  let at = 0;
  for (const item of itemsOf(answer)) {
    while (at < items.length && !items[at]!.equals(item)) {
      at += 1;
    }
    if (at === items.length) {
      return false;
    }
    at += 1;
  }
  return true;
};

/** Optional for Hosts. The binding is ignored. */
export const userCapability = (
  impl: UserImpl,
  costs: Costs,
): CapabilityDef<unknown> => {
  for (const name of ['confirm', 'choose', 'enter', 'notify'] as const) {
    if (!impl || typeof impl[name] !== 'function') {
      throw new HostError('invalid value', `User needs ${name}`);
    }
  }
  const operations: Record<string, Operation<unknown>> = {
    confirm: {
      mode: 'suspending',
      args: [shape.text],
      result: shape.bool,
      errors: userBusy,
      maxPendingMs: USER_MAX_PENDING_MS,
      cost: costOf(costs, 'confirm'),
      start: (call, message) => impl.confirm(call, message!.asText()!),
    },
    choose: {
      mode: 'suspending',
      args: [
        shape.listOf(shape.text),
        options({ prompt: optionalText, multiple: shape.optional(shape.bool) }),
      ],
      result: shape.optional(shape.oneOf(shape.text, shape.listOf(shape.text))),
      errors: userBusy,
      maxPendingMs: USER_MAX_PENDING_MS,
      cost: costOf(costs, 'choose'),
      start: (call, items, options) =>
        impl.choose(
          call,
          itemsOf(items!).map(item => item.asText()!),
          optionText(options, 'prompt'),
          multipleOf(options),
        ),
    },
    enter: {
      mode: 'suspending',
      args: [shape.text, options({ default: optionalText })],
      result: optionalText,
      errors: userBusy,
      maxPendingMs: USER_MAX_PENDING_MS,
      cost: costOf(costs, 'enter'),
      start: (call, message, options) =>
        impl.enter(call, message!.asText()!, optionText(options, 'default')),
    },
    notify: {
      mode: 'fire-and-forget',
      args: [shape.text, options({ title: optionalText })],
      errors: [],
      cost: costOf(costs, 'notify'),
      fire: (call, message, options) =>
        impl.notify(call, message!.asText()!, optionText(options, 'title')),
    },
  };
  for (const [name, op] of Object.entries(operations)) {
    registerStandardChecks(op, {
      error: code => code === 'user busy' && name !== 'notify',
      ...(name === 'choose'
        ? {
            arguments: args => {
              if (args[0]!.length === 0) {
                throw new ScriptError(
                  'out of domain',
                  [
                    ['function', text('choose')],
                    ['value', args[0]!],
                  ],
                  true,
                );
              }
            },
            result: chosen,
          }
        : {}),
    });
  }
  return fixed(defineCapability('user', operations));
};
