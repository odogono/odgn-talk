import { invalidValue } from './errors';
import {
  type Decimal,
  Value,
  isDecimal,
  bool,
  bytes,
  dec,
  listValues,
  map,
  nothing,
  num,
  record,
  text,
} from './values';

/** Plain JS data, as `fromValue` writes it (ADR 0119). */
export type PlainValue =
  | null
  | boolean
  | string
  | Decimal
  | Uint8Array
  | Value
  | PlainValue[]
  | { [key: string]: PlainValue }
  | Map<string, PlainValue>;

export type ToValueOptions = {
  /** `decimal` reads a JS number through `num`; the default refuses it. */
  numbers?: 'refuse' | 'decimal';
};

export type FromValueOptions = {
  maps?: 'object' | 'map';
  numbers?: 'decimal' | 'string';
};

const tagOf = (input: object): string => Object.prototype.toString.call(input);

const isPlainObject = (input: object): boolean =>
  [null, Object.prototype].includes(Object.getPrototypeOf(input));

/**
 * Plain JS data to a Value by the named constructors (ADR 0119). Anything
 * the table doesn't name, and cyclic data, throws `invalid value`.
 */
export const toValue = (
  plain: unknown,
  options: ToValueOptions = {},
): Value => {
  const decimalNumbers = options.numbers === 'decimal';
  const open = new Set<object>();
  const convert = (input: unknown): Value => {
    switch (typeof input) {
      case 'undefined':
        return nothing;
      case 'boolean':
        return bool(input);
      case 'string':
        return text(input);
      case 'bigint':
        return num(input);
      case 'number':
        return decimalNumbers
          ? num(input)
          : invalidValue(
              "A JS number needs { numbers: 'decimal' }, or num() or dec()",
            );
      case 'object':
        break;
      default:
        return invalidValue(`Not plain data: ${typeof input}`);
    }
    if (input === null) {
      return nothing;
    }
    if (Value.isValue(input)) {
      return input;
    }
    if (isDecimal(input)) {
      return dec(input.toString());
    }
    if (tagOf(input) === '[object Uint8Array]') {
      return bytes(input as Uint8Array);
    }
    if (open.has(input)) {
      return invalidValue('Cyclic data has no Value');
    }
    open.add(input);
    let result: Value;
    if (Array.isArray(input)) {
      const items: Value[] = [];
      for (let i = 0; i < input.length; i++) {
        items.push(convert(input[i]));
      }
      result = listValues(items);
    } else if (tagOf(input) === '[object Map]') {
      result = map(
        Array.from(
          input as Map<unknown, unknown>,
          ([k, v]): [string, Value] => {
            if (typeof k !== 'string') {
              invalidValue('Map keys must be text');
            }
            return [k, convert(v)];
          },
        ),
      );
    } else if (isPlainObject(input)) {
      const fields: Record<string, Value> = Object.create(null);
      for (const [k, v] of Object.entries(input)) {
        Object.defineProperty(fields, k, {
          value: convert(v),
          enumerable: true,
        });
      }
      result = record(fields);
    } else {
      return invalidValue(
        `Not plain data: ${input.constructor?.name ?? 'object'}`,
      );
    }
    open.delete(input);
    return result;
  };
  return convert(plain);
};

/** A Value as plain JS data (ADR 0119); kinds with no JS form stay Values. */
export const fromValue = (
  v: Value,
  options: FromValueOptions = {},
): PlainValue => {
  if (!Value.isValue(v)) {
    invalidValue('Expected a Value from a named constructor');
  }
  const convert = (value: Value): PlainValue => {
    switch (value.kind) {
      case 'nothing':
        return null;
      case 'boolean':
        return value.asBool()!;
      case 'text':
        return value.asText()!;
      case 'number': {
        const d = value.asDecimal()!;
        return options.numbers === 'string' ? d.toString() : d;
      }
      case 'bytes':
        return value.asBytes()!;
      case 'list': {
        const items: PlainValue[] = [];
        for (let i = 1; i <= value.length; i++) {
          items.push(convert(value.index(i)));
        }
        return items;
      }
      case 'map': {
        if (options.maps === 'map') {
          return new Map(value.entries().map(([k, x]) => [k, convert(x)]));
        }
        const fields: { [key: string]: PlainValue } = {};
        for (const [k, x] of value.entries()) {
          Object.defineProperty(fields, k, {
            value: convert(x),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return fields;
      }
      default:
        return value;
    }
  };
  return convert(v);
};
