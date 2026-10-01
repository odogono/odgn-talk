import { invalidValue } from './errors';
import { characterBoundaries, isWhiteSpace, normalizeNFC } from './unicode';

/** Kinds implemented by the first value foundation slice of #126. */
export type Kind = 'nothing' | 'boolean' | 'number' | 'text' | 'list' | 'map';
type Pairs = readonly (readonly [string, Value])[];
type Payload =
  undefined | boolean | string | Decimal | readonly Value[] | Pairs;
const valueToken = Symbol('Value');
const decimalToken = Symbol('Decimal');
let makeValue: (kind: Kind, payload: Payload) => Value;
let makeDecimal: (canonical: string) => Decimal;

export class Decimal {
  readonly #canonical: string;
  private constructor(token: symbol, canonical: string) {
    if (token !== decimalToken) {
      invalidValue('Use a numeric constructor');
    }
    this.#canonical = canonical;
    Object.freeze(this);
  }
  static {
    makeDecimal = canonical => new Decimal(decimalToken, canonical);
  }
  toString(): string {
    return this.#canonical;
  }
  toBigInt(): bigint {
    const [whole, fraction] = this.#canonical.split('.');
    if (fraction && /[1-9]/.test(fraction)) {
      invalidValue('Decimal is not an integer');
    }
    return BigInt(whole!);
  }
  toNumberLossy(): number {
    return Number(this.#canonical);
  }
}

/** Immutable, opaque value. Host code uses the named constructors. */
export class Value {
  readonly #data: Payload;
  readonly kind: Kind;
  private constructor(token: symbol, kind: Kind, payload: Payload) {
    if (token !== valueToken) {
      invalidValue('Use a named Value constructor');
    }
    this.kind = kind;
    this.#data = payload;
    Object.freeze(this);
  }
  static {
    makeValue = (kind, payload) => new Value(valueToken, kind, payload);
  }
  static isValue(input: unknown): input is Value {
    return typeof input === 'object' && input !== null && #data in input;
  }
  asText(): string | undefined {
    return this.kind === 'text' ? (this.#data as string) : undefined;
  }
  asBool(): boolean | undefined {
    return this.kind === 'boolean' ? (this.#data as boolean) : undefined;
  }
  asDecimal(): Decimal | undefined {
    return this.kind === 'number' ? (this.#data as Decimal) : undefined;
  }
  get length(): number {
    return this.kind === 'list' ? (this.#data as readonly Value[]).length : 0;
  }
  index(i: number): Value {
    if (this.kind !== 'list' || !Number.isInteger(i) || i < 1) {
      return nothing;
    }
    return (this.#data as readonly Value[])[i - 1] ?? nothing;
  }
  get(key: string): Value {
    const nfc = normalizeNFC(key);
    return this.kind === 'map'
      ? ((this.#data as Pairs).find(([k]) => k === nfc)?.[1] ?? nothing)
      : nothing;
  }
  entries(): [string, Value][] {
    return this.kind === 'map'
      ? (this.#data as Pairs).map(([k, v]) => [k, v])
      : [];
  }
  equals(other: Value): boolean {
    requireValue(other);
    const pending: [Value, Value][] = [[this, other]];
    while (pending.length) {
      const [left, right] = pending.pop()!;
      if (left.kind !== right.kind) {
        return false;
      }
      switch (left.kind) {
        case 'nothing':
          break;
        case 'text':
        case 'boolean':
          if (left.#data !== right.#data) {
            return false;
          }
          break;
        case 'number':
          if (
            numericIdentity(left.asDecimal()!) !==
            numericIdentity(right.asDecimal()!)
          ) {
            return false;
          }
          break;
        case 'list': {
          if (left.length !== right.length) {
            return false;
          }
          for (let i = 1; i <= left.length; i++) {
            pending.push([left.index(i), right.index(i)]);
          }
          break;
        }
        case 'map': {
          const rhs = new Map(right.entries());
          const entries = left.#data as Pairs;
          if (entries.length !== rhs.size) {
            return false;
          }
          for (const [k, v] of entries) {
            const match = rhs.get(k);
            if (!match) {
              return false;
            }
            pending.push([v, match]);
          }
          break;
        }
      }
    }
    return true;
  }
  toString(): string {
    const pending: (Value | string)[] = [this];
    const output: string[] = [];
    while (pending.length) {
      const next = pending.pop()!;
      if (typeof next === 'string') {
        output.push(next);
        continue;
      }
      switch (next.kind) {
        case 'nothing':
          output.push('nothing');
          break;
        case 'boolean':
          output.push(next.#data ? 'true' : 'false');
          break;
        case 'number':
          output.push(next.asDecimal()!.toString());
          break;
        case 'text':
          output.push(displayText(next.#data as string));
          break;
        case 'list': {
          output.push('[');
          pending.push(']');
          const items = next.#data as readonly Value[];
          for (let i = items.length - 1; i >= 0; i--) {
            if (i < items.length - 1) {
              pending.push(', ');
            }
            pending.push(items[i]!);
          }
          break;
        }
        case 'map': {
          output.push('{');
          pending.push('}');
          const entries = next.#data as Pairs;
          for (let i = entries.length - 1; i >= 0; i--) {
            const [k, v] = entries[i]!;
            if (i < entries.length - 1) {
              pending.push(', ');
            }
            pending.push(v, `${displayKey(k)}: `);
          }
          break;
        }
      }
    }
    return output.join('');
  }
}

export const requireValue: (
  value: unknown,
) => asserts value is Value = value => {
  if (!Value.isValue(value)) {
    invalidValue('Expected a Value from a named constructor');
  }
};
export const nothing = makeValue('nothing', undefined);
export const bool = (b: boolean): Value => {
  if (typeof b !== 'boolean') {
    invalidValue('Boolean must be true or false');
  }
  return makeValue('boolean', b);
};
export const text = (s: string): Value => makeValue('text', normalizeNFC(s));

const trimWhiteSpace = (s: string): string => {
  const boundaries = characterBoundaries(s);
  let first = 0,
    last = boundaries.length - 1;
  while (first < last && isWhiteSpace(s.codePointAt(boundaries[first]!)!)) {
    first++;
  }
  while (last > first && isWhiteSpace(s.codePointAt(boundaries[last - 1]!)!)) {
    last--;
  }
  return s.slice(boundaries[first], boundaries[last]);
};

export const dec = (s: string): Value => {
  if (typeof s !== 'string') {
    invalidValue('Decimal must be text');
  }
  s = trimWhiteSpace(s);
  if (!/^-?(?:\d+(?:\.\d+)?|0x[\dA-Fa-f]+)$/.test(s)) {
    invalidValue('Invalid decimal syntax');
  }
  const negative = s.startsWith('-');
  if (negative) {
    s = s.slice(1);
  }
  if (s.startsWith('0x')) {
    // A valid value cannot require more than 29 significant hex digits.
    const hex = s.slice(2).replace(/^0+/, '') || '0';
    if (hex.length > 29) {
      invalidValue('Decimal exceeds 34 digits');
    }
    s = BigInt(`0x${hex}`).toString();
  }
  const [integer, fraction = ''] = s.split('.');
  const whole = integer!.replace(/^0+/, '') || '0';
  const coefficient = (whole + fraction).replace(/^0+/, '');
  if (coefficient.length > 34 || whole.length > 34 || fraction.length > 6176) {
    invalidValue('Decimal exceeds the value limits');
  }
  const canonical = `${negative && coefficient ? '-' : ''}${whole}${fraction.length ? `.${fraction}` : ''}`;
  return makeValue('number', makeDecimal(canonical));
};

/** ECMAScript's shortest round-trip digits, expanded without rounding. */
export const num = (n: number | bigint): Value => {
  if (typeof n !== 'number' && typeof n !== 'bigint') {
    invalidValue('Number must be a number or bigint');
  }
  if (typeof n === 'number' && !Number.isFinite(n)) {
    invalidValue('Number must be finite');
  }
  const raw = n.toString();
  if (!/[Ee]/.test(raw)) {
    return dec(raw);
  }
  const [mantissa, exp] = raw.split('e');
  const negative = mantissa!.startsWith('-');
  const unsigned = negative ? mantissa!.slice(1) : mantissa!;
  const [whole, fraction = ''] = unsigned.split('.');
  const digits = whole! + fraction;
  const point = whole!.length + Number(exp);
  const expanded =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return dec((negative ? '-' : '') + expanded);
};

const numericIdentity = (d: Decimal): string =>
  d
    .toString()
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');

export const list = (...vs: Value[]): Value => listValues(vs);
// Readers use this array form to avoid JS argument-count limits. It is not a Host API.
export const listValues = (vs: readonly Value[]): Value => {
  vs.forEach(requireValue);
  return makeValue('list', Object.freeze([...vs]));
};
export const map = (
  input: Map<string, Value> | Iterable<[string, Value]>,
): Value => {
  if (
    input === null ||
    input === undefined ||
    typeof input[Symbol.iterator] !== 'function'
  ) {
    invalidValue('Map requires ordered entries');
  }
  const seen = new Set<string>();
  const pairs: (readonly [string, Value])[] = [];
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      invalidValue('Map entries must be key/Value pairs');
    }
    const [key, value] = entry;
    const nfc = normalizeNFC(key);
    requireValue(value);
    if (seen.has(nfc)) {
      invalidValue(`Duplicate map key: ${displayText(nfc)}`);
    }
    seen.add(nfc);
    pairs.push(Object.freeze([nfc, value] as const));
  }
  return makeValue('map', Object.freeze(pairs));
};
export const record = (input: Record<string, Value>): Value => {
  if (
    typeof input !== 'object' ||
    input === null ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(input))
  ) {
    invalidValue('Record requires a plain object');
  }
  const pairs = Object.entries(input);
  for (const [key] of pairs) {
    const n = Number(key);
    if (
      Number.isInteger(n) &&
      n >= 0 &&
      n < 0xff_ff_ff_ff &&
      String(n) === key
    ) {
      invalidValue('Record has an integer-like key; use map');
    }
  }
  return map(pairs);
};

export const hiddenCodePoint = (cp: number): boolean =>
  cp <= 0x1f ||
  (cp >= 0x7f && cp <= 0x9f) ||
  cp === 0x6_1c ||
  cp === 0x20_0e ||
  cp === 0x20_0f ||
  (cp >= 0x20_28 && cp <= 0x20_2e) ||
  (cp >= 0x20_66 && cp <= 0x20_69) ||
  cp === 0xfe_ff;
export const displayText = (s: string): string => {
  const pieces: string[] = [];
  let run = '';
  const flush = () => {
    if (run) {
      pieces.push(`"${run}"`);
      run = '';
    }
  };
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 34 || hiddenCodePoint(cp)) {
      flush();
      pieces.push(
        cp === 34
          ? 'quote'
          : cp === 10
            ? 'newline'
            : cp === 9
              ? 'tab'
              : `fromCodePoint(${cp})`,
      );
    } else {
      run += ch;
    }
  }
  flush();
  return pieces.length ? pieces.join(' & ') : '""';
};
const displayKey = (key: string): string => {
  if (/^[A-Z_a-z]\w*$/.test(key)) {
    return key;
  }
  const display = displayText(key);
  return display.startsWith('"') ? display : `"" & ${display}`;
};
