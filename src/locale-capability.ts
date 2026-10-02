// Chapter 7's Locale boundary: syntax and Shapes belong to the Core;
// collation, case mappings, data and fallback belong to the Host.
import {
  defineCapability,
  shape,
  type Call,
  type CapabilityDef,
  type Operation,
  type Shape,
} from './capabilities';
import { HostError } from './errors';
import { isInteger, integerOf, parseDec } from './decimal';
import { wellFormedLocale } from './locale-tag';
import { ScriptError } from './operations';
import { costOf, fixed, type Costs } from './standard-capabilities';
import { registerStandardChecks } from './standard-capability-checks';
import { bool, map, text, type Value } from './values';

export type LocaleImpl = {
  compare(
    call: Call<string>,
    a: Value,
    b: Value,
    opts: Value,
    tag?: string,
  ): Value;
  dayNames(call: Call<string>, opts: Value, tag?: string): Value;
  lower(call: Call<string>, s: Value, tag?: string): Value;
  monthNames(call: Call<string>, opts: Value, tag?: string): Value;
  numberSymbols(call: Call<string>, tag?: string): Value;
  rank(call: Call<string>, texts: Value, opts: Value, tag?: string): Value;
  tag(call: Call<string>, tag?: string): Value;
  upper(call: Call<string>, s: Value, tag?: string): Value;
};
const collationShape = shape.map({
  sensitivity: { optional: true, shape: shape.text },
  numeric: { optional: true, shape: shape.bool },
});
const nameShape = shape.map({
  width: { optional: true, shape: shape.text },
  form: { optional: true, shape: shape.text },
});
const textList = shape.listOf(shape.text);
const symbolsShape = shape.map({
  decimal: shape.text,
  group: shape.text,
  minus: shape.text,
  digits: textList,
  primaryGroup: shape.number,
  secondaryGroup: shape.number,
  minGrouping: shape.number,
});
const collationDefaults = map([
  ['sensitivity', text('variant')],
  ['numeric', bool(false)],
]);
const nameDefaults = map([
  ['width', text('long')],
  ['form', text('format')],
]);
const words: Record<string, readonly string[]> = {
  sensitivity: ['base', 'accent', 'case', 'variant'],
  width: ['long', 'short', 'narrow'],
  form: ['format', 'standalone'],
};
const domainError = (name: string, value: Value): never => {
  throw new ScriptError(
    'out of domain',
    [
      ['function', text(name)],
      ['value', value],
    ],
    true,
  );
};
const optionalParts = (
  args: readonly Value[],
  required: number,
  options: boolean,
) => {
  const first = args[required];
  return {
    options: options && first?.kind === 'map' ? first : undefined,
    tag:
      options && first?.kind !== 'text'
        ? args[required + 1]?.asText()
        : first?.asText(),
  };
};
const checkArguments = (
  name: string,
  required: number,
  options: boolean,
  args: readonly Value[],
  binding: unknown,
): void => {
  if (
    options &&
    args.length > required + 1 &&
    args[required]?.kind === 'text'
  ) {
    domainError(name, args[required]!);
  }
  const parts = optionalParts(args, required, options);
  for (const [key, value] of parts.options?.entries() ?? []) {
    if (words[key] && !words[key]!.includes(value.asText()!)) {
      domainError(name, value);
    }
  }
  const tag = parts.tag ?? binding;
  if (typeof tag !== 'string') {
    throw new HostError('invalid value', 'Locale binding must be a tag');
  }
  if (!wellFormedLocale(tag)) {
    throw new ScriptError('bad locale', [['locale', text(tag)]], true);
  }
};
const withDefaults = (given: Value | undefined, defaults: Value): Value =>
  map(
    defaults
      .entries()
      .map(([key, value]) => [
        key,
        given && given.get(key).kind !== 'nothing' ? given.get(key) : value,
      ]),
  );
const integer = (value: Value): bigint | undefined => {
  const n =
    value.kind === 'number'
      ? parseDec(value.asDecimal()!.toString())
      : undefined;
  return n && isInteger(n) ? integerOf(n) : undefined;
};
const validRank = (value: Value, args: readonly Value[]): boolean => {
  const texts = args[0]!;
  const wanted = new Set<string>();
  for (let i = 1; i <= texts.length; i++) {
    wanted.add(texts.index(i).asText()!);
  }
  const entries = value.entries();
  if (entries.length !== wanted.size) {
    return false;
  }
  const ranks = new Set<bigint>();
  for (const [key, rank] of entries) {
    const n = integer(rank);
    if (
      !wanted.has(key) ||
      n === undefined ||
      n < 1n ||
      n > BigInt(entries.length)
    ) {
      return false;
    }
    ranks.add(n);
  }
  for (let i = 1; i <= ranks.size; i++) {
    if (!ranks.has(BigInt(i))) {
      return false;
    }
  }
  return true;
};
const validSymbols = (value: Value): boolean => {
  for (const key of ['decimal', 'group', 'minus']) {
    if (!value.get(key).asText()) {
      return false;
    }
  }
  const digits = value.get('digits');
  if (digits.length !== 10) {
    return false;
  }
  for (let i = 1; i <= 10; i++) {
    if (!digits.index(i).asText()) {
      return false;
    }
  }
  return ['primaryGroup', 'secondaryGroup', 'minGrouping'].every(
    key => (integer(value.get(key)) ?? 0n) >= 1n,
  );
};

/** The Host resolves tags and provides every Operation for each Locale. */
export const localeCapability = (
  impl: LocaleImpl,
  costs: Costs,
): CapabilityDef<string> => {
  for (const name of [
    'compare',
    'rank',
    'upper',
    'lower',
    'numberSymbols',
    'monthNames',
    'dayNames',
    'tag',
  ] as const) {
    if (!impl || typeof impl[name] !== 'function') {
      throw new HostError('invalid value', `Locale needs ${name}`);
    }
  }
  const operations: Record<string, Operation<string>> = {};
  const add = (
    name: keyof LocaleImpl,
    args: Shape[],
    result: Shape,
    doCall: (
      call: Call<string>,
      args: readonly Value[],
      opts: Value,
      tag?: string,
    ) => Value,
    options?: Value,
    resultCheck?: (value: Value, args: readonly Value[]) => boolean,
  ) => {
    const required = args.length;
    const optionShape =
      options === collationDefaults ? collationShape : nameShape;
    const op: Operation<string> = {
      mode: 'immediate',
      args: [
        ...args,
        ...(options
          ? [shape.optional(shape.oneOf(optionShape, shape.text))]
          : []),
        shape.optional(shape.text),
      ],
      result,
      errors: [],
      cost: costOf(costs, name),
      do: (call, ...values) => {
        const parts = optionalParts(values, required, !!options);
        return doCall(
          call,
          values,
          options ? withDefaults(parts.options, options) : map([]),
          parts.tag,
        );
      },
    };
    registerStandardChecks(op, {
      arguments: (values, binding) =>
        checkArguments(name, required, !!options, values, binding),
      ...(resultCheck ? { result: resultCheck } : {}),
    });
    operations[name] = op;
  };
  add(
    'compare',
    [shape.text, shape.text],
    shape.number,
    (call, args, opts, tag) =>
      impl.compare(call, args[0]!, args[1]!, opts, tag),
    collationDefaults,
    value => {
      const n = integer(value);
      return n !== undefined && n >= -1n && n <= 1n;
    },
  );
  add(
    'rank',
    [textList],
    shape.openMap({}),
    (call, args, opts, tag) => impl.rank(call, args[0]!, opts, tag),
    collationDefaults,
    validRank,
  );
  add('upper', [shape.text], shape.text, (call, args, _opts, tag) =>
    impl.upper(call, args[0]!, tag),
  );
  add('lower', [shape.text], shape.text, (call, args, _opts, tag) =>
    impl.lower(call, args[0]!, tag),
  );
  add(
    'numberSymbols',
    [],
    symbolsShape,
    (call, _args, _opts, tag) => impl.numberSymbols(call, tag),
    undefined,
    validSymbols,
  );
  add(
    'monthNames',
    [],
    textList,
    (call, _args, opts, tag) => impl.monthNames(call, opts, tag),
    nameDefaults,
    value => value.length === 12,
  );
  add(
    'dayNames',
    [],
    textList,
    (call, _args, opts, tag) => impl.dayNames(call, opts, tag),
    nameDefaults,
    value => value.length === 7,
  );
  add(
    'tag',
    [],
    shape.text,
    (call, _args, _opts, tag) => impl.tag(call, tag),
    undefined,
    value => wellFormedLocale(value.asText()!),
  );
  return fixed(defineCapability('locale', operations));
};
