import type { HostObject } from './objects';
import { ListStorage } from './list-storage';
import { MapStorage, type MapLayout } from './map-storage';
import { TextStorage } from './text-storage';
import {
  checkInstant,
  civilFields,
  civilFromFields,
  civilText,
  DateRangeError,
  formatInstant,
  parseCivil,
  type CivilRef,
} from './dates';
import {
  compareDec,
  formatDec,
  integerOf,
  isInteger,
  type Dec,
} from './decimal';
import { invalidValue } from './errors';
import { characterBoundaries, isWhiteSpace, normalizeNFC } from './unicode';
import {
  parseUnit,
  sameDimension,
  ownUnit,
  toBase,
  UnitError,
  unitText,
  type UnitSpec,
} from './units';

/** The kinds implemented so far; the rest of chapter 3's follow with #126. */
export type Kind =
  | 'nothing'
  | 'boolean'
  | 'number'
  | 'quantity'
  | 'text'
  | 'bytes'
  | 'list'
  | 'map'
  | 'range'
  | 'instant'
  | 'civil date'
  | 'pattern'
  | 'function'
  | 'object';
type Pairs = readonly (readonly [string, Value])[];
/**
 * A Function Value (chapter 3, ADR 0025): its Home Script, where its code is,
 * its captured values in capture-slot order, and its may-suspend flag. `code`
 * is the Abstract Machine's own reference, which no Host or Script sees.
 */
export type FunctionRef = {
  readonly captures: Pairs;
  readonly code: unknown;
  /** The extension unit used in the display form, while home remains the Script. */
  readonly displayHome?: string;
  /** The Core's Group identity; rebound by same-family restore. */
  readonly group?: object;
  readonly home: string;
  /** Equal for the same Lambda or named function in the same Home Script. */
  readonly identity: string;
  readonly maySuspend: boolean;
  /** Where its code is, as its display form shows it: `12:3`, `tax`, `text:pad`. */
  readonly place: string;
};
/** A Text Pattern: its canonical source, and the matcher's own data. */
export type PatternRef = {
  readonly data: unknown;
  /** The number of instructions in its compiled program. */
  readonly program: number;
  readonly source: string;
};
/**
 * A Host Object (chapter 3): its kind and its id, and the Group's own handle,
 * whose identity is the object's, so two are equal only when they are one.
 */
export type ObjectRef = {
  readonly handle: unknown;
  readonly id: string;
  readonly kind: string;
};
/** A Quantity: its number and its Unit, in Kind order (chapter 3). */
export type QuantityRef = { readonly number: Decimal; readonly unit: UnitSpec };
type Payload =
  | bigint
  | CivilRef
  | Uint8Array
  | QuantityRef
  | PatternRef
  | undefined
  | boolean
  | TextStorage
  | Decimal
  | ListStorage
  | MapStorage
  | readonly [Value, Value]
  | FunctionRef
  | ObjectRef;
const valueToken = Symbol('Value');
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const frozenParts = (parts: Dec): Dec =>
  Object.freeze({
    coefficient: parts.coefficient,
    exponent: parts.exponent,
    negative: parts.negative && parts.coefficient !== 0n,
  });
const decimalToken = Symbol('Decimal');
let makeValue: (kind: Kind, payload: Payload) => Value;
let extendListValue: (
  current: Value,
  part: Value,
  prepend: boolean,
  all: boolean,
) => Value;
let editListValue: (
  current: Value,
  i: number,
  value: Value | undefined,
) => Value;
let editMapValue: (
  current: Value,
  key: string,
  value: Value | undefined,
) => Value;
let makeDecimal: (canonical: string | undefined, parts: Dec) => Decimal;
let makeSmallDecimal: (n: number) => Decimal;
/** Internal: a Decimal's cached, immutable arithmetic representation. */
export let decimalParts: (decimal: Decimal) => Dec;
/**
 * Internal: a Decimal's value as a JS number when it is a safe integer
 * written with exponent 0, or NaN. The fast paths compute on it directly.
 */
export let smallInteger: (decimal: Decimal) => number;
export let isDecimal: (input: unknown) => input is Decimal;
/** Internal: owned Map pairs. Never pass these arrays to a Host. */
export let ownedMapPairs: (value: Value) => Pairs | undefined;
/** Internal: immutable Text storage and its cached derived facts. */
export let textStorage: (value: Value) => TextStorage;
let textValue: (storage: TextStorage) => Value;

export class Decimal {
  // Arithmetic results make their text on first use. Small integers also
  // defer their BigInt parts until arithmetic needs them.
  #canonical: string | undefined;
  #parts: Dec | undefined;
  readonly #small: number;
  private constructor(
    token: symbol,
    canonical: string | undefined,
    parts: Dec | undefined,
    small: number,
  ) {
    if (token !== decimalToken) {
      invalidValue('Use a numeric constructor');
    }
    this.#canonical = canonical;
    this.#parts = parts && frozenParts(parts);
    this.#small = small;
    Object.preventExtensions(this);
  }
  static {
    isDecimal = (input): input is Decimal =>
      typeof input === 'object' && input !== null && #small in input;
    makeDecimal = (canonical, parts) =>
      new Decimal(
        decimalToken,
        canonical,
        parts,
        parts.exponent === 0 && parts.coefficient <= SAFE
          ? Number(parts.coefficient) * (parts.negative ? -1 : 1) + 0
          : Number.NaN,
      );
    makeSmallDecimal = n => new Decimal(decimalToken, undefined, undefined, n);
    decimalParts = decimal =>
      (decimal.#parts ??= frozenParts({
        coefficient: BigInt(Math.abs(decimal.#small)),
        exponent: 0,
        negative: decimal.#small < 0,
      }));
    smallInteger = decimal => decimal.#small;
  }
  toString(): string {
    return (this.#canonical ??= this.#parts
      ? formatDec(this.#parts)
      : String(this.#small));
  }
  toBigInt(): bigint {
    const parts = decimalParts(this);
    if (!isInteger(parts)) {
      invalidValue('Decimal is not an integer');
    }
    return integerOf(parts);
  }
  toNumberLossy(): number {
    return Number(this.toString());
  }
}

/** Immutable, opaque value. Host code uses the named constructors. */
export class Value {
  readonly #data: Payload;
  readonly #kind: Kind;
  private constructor(token: symbol, kind: Kind, payload: Payload) {
    if (token !== valueToken) {
      invalidValue('Use a named Value constructor');
    }
    this.#kind = kind;
    this.#data = payload;
    // Private fields hold the state; prevent Host code from shadowing its reads.
    Object.preventExtensions(this);
  }
  static {
    makeValue = (kind, payload) => new Value(valueToken, kind, payload);
    ownedMapPairs = value =>
      value.#kind === 'map' ? (value.#data as MapStorage).pairs() : undefined;
    textStorage = value => value.#data as TextStorage;
    textValue = storage => makeValue('text', storage);
    editListValue = (current, i, value) =>
      makeValue('list', (current.#data as ListStorage).set(i, value));
    editMapValue = (current, key, value) => {
      const storage = current.#data as MapStorage;
      const next = storage.set(key, value);
      return next === storage ? current : makeValue('map', next);
    };
    extendListValue = (current, part, prepend, all) => {
      const storage = current.#data as ListStorage;
      const added = all ? (part.#data as ListStorage) : undefined;
      const result = storage.extend(
        added?.length ?? 1,
        i => (added ? added.index(i)! : part),
        prepend,
      );
      return result === storage ? current : makeValue('list', result);
    };
  }
  static isValue(input: unknown): input is Value {
    return typeof input === 'object' && input !== null && #data in input;
  }
  get kind(): Kind {
    return this.#kind;
  }
  /** Returns the text payload, or undefined for kinds other than text. */
  asText(): string | undefined {
    return this.kind === 'text' ? (this.#data as TextStorage).text : undefined;
  }
  asBool(): boolean | undefined {
    return this.kind === 'boolean' ? (this.#data as boolean) : undefined;
  }
  asDecimal(): Decimal | undefined {
    return this.kind === 'number' ? (this.#data as Decimal) : undefined;
  }
  /** A Quantity's number and its Unit in normal form, as the Host reads it. */
  asQuantity(): { number: Decimal; unit: string } | undefined {
    if (this.kind !== 'quantity') {
      return undefined;
    }
    const q = this.#data as QuantityRef;
    return { number: q.number, unit: unitText(q.unit) };
  }
  /** The Abstract Machine's view of a Quantity: its Unit's slots. */
  asQuantityRef(): QuantityRef | undefined {
    return this.kind === 'quantity' ? (this.#data as QuantityRef) : undefined;
  }
  /** An Instant as epoch microseconds. */
  asInstant(): bigint | undefined {
    return this.kind === 'instant' ? (this.#data as bigint) : undefined;
  }
  /** A Civil Date's fields; a date-only value has no time fields. */
  asCivilDate(): ReturnType<typeof civilFields> | undefined {
    return this.kind === 'civil date'
      ? civilFields(this.#data as CivilRef)
      : undefined;
  }
  /** The Abstract Machine's view of a Civil Date. */
  civilRef(): CivilRef | undefined {
    return this.kind === 'civil date' ? (this.#data as CivilRef) : undefined;
  }
  /** A copy of the bytes. */
  asBytes(): Uint8Array | undefined {
    return this.kind === 'bytes'
      ? (this.#data as Uint8Array).slice()
      : undefined;
  }
  /** The Abstract Machine's view of Bytes, which it never writes to. */
  bytesView(): Uint8Array | undefined {
    return this.kind === 'bytes' ? (this.#data as Uint8Array) : undefined;
  }
  asRange(): { from: Value; to: Value } | undefined {
    if (this.kind !== 'range') {
      return undefined;
    }
    const [from, to] = this.#data as readonly [Value, Value];
    return { from, to };
  }
  /** A Function Value's Home Script, its only Host-visible read. */
  homeScript(): string | undefined {
    return this.kind === 'function'
      ? (this.#data as FunctionRef).home
      : undefined;
  }
  /** A Text Pattern's canonical source, for display. */
  patternSource(): string | undefined {
    return this.kind === 'pattern'
      ? (this.#data as PatternRef).source
      : undefined;
  }
  asPattern(): PatternRef | undefined {
    return this.kind === 'pattern' ? (this.#data as PatternRef) : undefined;
  }
  /** The Host Object handle this value stands for (chapter 9). */
  asObject(): HostObject | undefined {
    return this.kind === 'object'
      ? ((this.#data as ObjectRef).handle as { handle: HostObject }).handle
      : undefined;
  }
  /** A Host Object's kind, id and handle. */
  asObjectRef(): ObjectRef | undefined {
    return this.kind === 'object' ? (this.#data as ObjectRef) : undefined;
  }
  /** The Abstract Machine's view of a Function Value. */
  asFunction(): FunctionRef | undefined {
    return this.kind === 'function' ? (this.#data as FunctionRef) : undefined;
  }
  get length(): number {
    return this.kind === 'list' ? (this.#data as ListStorage).length : 0;
  }
  index(i: number): Value {
    if (this.kind !== 'list' || !Number.isInteger(i) || i < 1) {
      return nothing;
    }
    return (this.#data as ListStorage).index(i - 1) ?? nothing;
  }
  get(key: string): Value {
    const nfc = normalizeNFC(key);
    return this.kind === 'map'
      ? ((this.#data as MapStorage).get(nfc) ?? nothing)
      : nothing;
  }
  /** A detached view, including copies of the individual pairs. */
  mapPairs(): Pairs | undefined {
    return this.kind === 'map' ? this.entries() : undefined;
  }
  get mapSize(): number {
    return this.kind === 'map' ? (this.#data as MapStorage).length : 0;
  }
  hasKey(key: string): boolean {
    return (
      this.kind === 'map' && (this.#data as MapStorage).has(normalizeNFC(key))
    );
  }
  entries(): [string, Value][] {
    return this.kind === 'map'
      ? (this.#data as MapStorage).pairs().map(([k, v]) => [k, v])
      : [];
  }
  equals(other: Value): boolean {
    requireValue(other);
    // Pairs already proven equal are not walked again: a shared part
    // counts once per distinct pair of nodes, not once per path to it
    // (#890). Values are acyclic, so a pair is proven when its children
    // finish, and no pair is its own descendant.
    const proven = new Map<Value, Set<Value>>();
    const pending: [Value, Value, boolean][] = [[this, other, false]];
    while (pending.length) {
      const [left, right, finish] = pending.pop()!;
      if (finish) {
        let set = proven.get(left);
        if (!set) {
          set = new Set();
          proven.set(left, set);
        }
        set.add(right);
        continue;
      }
      if (left === right || proven.get(left)?.has(right)) {
        continue;
      }
      if (left.kind !== right.kind) {
        return false;
      }
      switch (left.kind) {
        case 'nothing':
          break;
        case 'text':
          if (left.asText() !== right.asText()) {
            return false;
          }
          break;
        case 'boolean':
        case 'instant':
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
          pending.push([left, right, true]);
          for (let i = 1; i <= left.length; i++) {
            pending.push([left.index(i), right.index(i), false]);
          }
          break;
        }
        case 'pattern':
          if (left.patternSource() !== right.patternSource()) {
            return false;
          }
          break;
        case 'civil date': {
          const a = left.#data as CivilRef;
          const b = right.#data as CivilRef;
          if (
            a.year !== b.year ||
            a.month !== b.month ||
            a.day !== b.day ||
            a.us !== b.us
          ) {
            return false;
          }
          break;
        }
        case 'bytes':
          if (
            compareBytes(left.#data as Uint8Array, right.#data as Uint8Array)
          ) {
            return false;
          }
          break;
        case 'quantity':
          if (!quantitiesEqual(left.asQuantityRef()!, right.asQuantityRef()!)) {
            return false;
          }
          break;
        case 'range': {
          const a = left.asRange()!;
          const b = right.asRange()!;
          pending.push(
            [left, right, true],
            [a.from, b.from, false],
            [a.to, b.to, false],
          );
          break;
        }
        case 'object':
          if (left.asObjectRef()!.handle !== right.asObjectRef()!.handle) {
            return false;
          }
          break;
        case 'function': {
          const a = left.asFunction()!;
          const b = right.asFunction()!;
          if (
            a.home !== b.home ||
            a.identity !== b.identity ||
            a.captures.length !== b.captures.length
          ) {
            return false;
          }
          pending.push([left, right, true]);
          a.captures.forEach(([, v], i) =>
            pending.push([v, b.captures[i]![1], false]),
          );
          break;
        }
        case 'map': {
          const rhs = new Map(right.entries());
          const entries = (left.#data as MapStorage).pairs();
          if (entries.length !== rhs.size) {
            return false;
          }
          pending.push([left, right, true]);
          for (const [k, v] of entries) {
            const match = rhs.get(k);
            if (!match) {
              return false;
            }
            pending.push([v, match, false]);
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
          output.push(displayText(next.asText()!));
          break;
        case 'list': {
          output.push('[');
          pending.push(']');
          const items = next.#data as ListStorage;
          for (let i = items.length - 1; i >= 0; i--) {
            if (i < items.length - 1) {
              pending.push(', ');
            }
            pending.push(items.index(i)!);
          }
          break;
        }
        case 'range': {
          const { from, to } = next.asRange()!;
          pending.push(to, '..', from);
          break;
        }
        case 'pattern':
          output.push(next.patternSource()!);
          break;
        case 'instant':
          output.push(formatInstant(next.#data as bigint));
          break;
        case 'civil date':
          output.push(civilText(next.#data as CivilRef));
          break;
        case 'bytes':
          output.push(bytesDisplay(next.#data as Uint8Array));
          break;
        case 'quantity': {
          const q = next.asQuantityRef()!;
          const n = q.number.toString();
          output.push(`${n} ${unitText(q.unit, n)}`);
          break;
        }
        case 'object': {
          const o = next.asObjectRef()!;
          output.push(`<object ${o.kind} ${displayText(o.id)}>`);
          break;
        }
        case 'function': {
          const fn = next.asFunction()!;
          output.push(`<function ${fn.displayHome ?? fn.home}:${fn.place}`);
          pending.push('>');
          if (fn.captures.length) {
            pending.push(makeValue('map', MapStorage.copy(fn.captures)), ' ');
          }
          break;
        }
        case 'map': {
          output.push('{');
          pending.push('}');
          const entries = (next.#data as MapStorage).pairs();
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
export const text = (s: string): Value =>
  textValue(new TextStorage(normalizeNFC(s)));
/** Internal: concatenate normalized Text Values without rescanning ASCII. */
export const concatText = (left: Value, right: Value): Value =>
  textValue(textStorage(left).concat(textStorage(right)));
/** Internal: a contiguous slice at Character boundaries is already NFC. */
export const sliceText = (value: Value, from: number, to: number): Value =>
  textValue(textStorage(value).slice(from, to));

export const trimWhiteSpace = (s: string): string => {
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

/** Decimal digits of an unsigned number-syntax literal, or null past chapter 3's limits. */
export const literalDigits = (
  s: string,
): { fraction: string; whole: string } | null => {
  if (s.startsWith('0x')) {
    // A valid value cannot require more than 29 significant hex digits.
    const hex = s.slice(2).replace(/^0+/, '') || '0';
    if (hex.length > 29) {
      return null;
    }
    s = BigInt(`0x${hex}`).toString();
  }
  const [integer, fraction = ''] = s.split('.');
  const whole = integer!.replace(/^0+/, '') || '0';
  const coefficient = (whole + fraction).replace(/^0+/, '');
  return coefficient.length > 34 || whole.length > 34 || fraction.length > 6176
    ? null
    : { whole, fraction };
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
  const digits = literalDigits(negative ? s.slice(1) : s);
  if (!digits) {
    invalidValue('Decimal exceeds the value limits');
  }
  const { whole, fraction } = digits;
  const zero = !/[1-9]/.test(whole + fraction);
  const canonical = `${negative && !zero ? '-' : ''}${whole}${fraction.length ? `.${fraction}` : ''}`;
  return makeValue(
    'number',
    makeDecimal(canonical, {
      coefficient: BigInt(whole + fraction),
      exponent: fraction.length ? -fraction.length : 0,
      negative: negative && !zero,
    }),
  );
};

/** Internal: a checked arithmetic result, retaining its coefficient directly. */
/** A safe integer as a number Value, without BigInt or text work. */
export const smallNumber = (n: number): Value =>
  makeValue('number', makeSmallDecimal(n + 0));

export const canonicalNumber = (parts: Dec): Value =>
  makeValue('number', makeDecimal(undefined, parts));

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
/** Two numbers, or two Quantities of one dimension, kept as given (ADR 0034). */
export const range = (from: Value, to: Value): Value => {
  requireValue(from);
  requireValue(to);
  const numbers = from.kind === 'number' && to.kind === 'number';
  const quantities =
    from.kind === 'quantity' &&
    to.kind === 'quantity' &&
    sameDimension(from.asQuantityRef()!.unit, to.asQuantityRef()!.unit);
  if (!numbers && !quantities) {
    invalidValue(
      'A range needs two numbers, or two Quantities of one dimension',
    );
  }
  return makeValue('range', Object.freeze([from, to] as const));
};

/**
 * A Quantity of a number Value in a Unit spelled as a Script spells it, such
 * as `"kg"`. A Unit whose slots all drop, such as `"m/m"`, leaves the number.
 */
export const quantity = (n: Value, unit: string): Value => {
  requireValue(n);
  if (n.kind !== 'number') {
    invalidValue('A Quantity needs a number');
  }
  if (typeof unit !== 'string') {
    invalidValue('A Quantity needs a Unit');
  }
  let spec: UnitSpec;
  try {
    spec = parseUnit(unit);
  } catch (error) {
    if (error instanceof UnitError) {
      return invalidValue(`Not a Unit: ${unit}: ${error.message}`);
    }
    throw error;
  }
  return spec.length ? quantityOf(n.asDecimal()!, spec) : n;
};
/** A Quantity of a Unit already in Kind order; the Abstract Machine's constructor. */
export const quantityOf = (n: Decimal, unit: UnitSpec): Value =>
  makeValue('quantity', Object.freeze({ number: n, unit: ownUnit(unit) }));

// Equal when their dimensions match and their values in Base Units do.
const quantitiesEqual = (a: QuantityRef, b: QuantityRef): boolean =>
  sameDimension(a.unit, b.unit) &&
  compareDec(
    toBase(decimalParts(a.number), a.unit),
    toBase(decimalParts(b.number), b.unit),
  ) === 0;
/** An Instant, from epoch microseconds; a JS Date is never accepted. */
export const instant = (epochMicros: bigint): Value => {
  if (typeof epochMicros !== 'bigint') {
    invalidValue('An Instant needs epoch microseconds as a bigint');
  }
  try {
    return instantOf(checkInstant(epochMicros));
  } catch (error) {
    if (error instanceof DateRangeError) {
      return invalidValue(`An Instant ${error.message}`);
    }
    throw error;
  }
};
export const instantOf = (us: bigint): Value => makeValue('instant', us);
type DateFields = Parameters<typeof civilFromFields>[0];
/** A Civil Date, from its fields or from text in the `as civil date` form. */
export const civilDate = (f: DateFields | string): Value => {
  if (typeof f === 'string') {
    let c: CivilRef | undefined;
    try {
      c = parseCivil(f);
    } catch (error) {
      if (!(error instanceof DateRangeError)) {
        throw error;
      }
    }
    return c ? civilOf(c) : invalidValue(`Not a Civil Date: ${f}`);
  }
  if (typeof f !== 'object' || f === null) {
    invalidValue('A Civil Date needs fields or text');
  }
  const c = civilFromFields(f);
  return typeof c === 'string'
    ? invalidValue(`Not a Civil Date: ${c}`)
    : civilOf(c);
};
export const civilOf = (c: CivilRef): Value =>
  makeValue('civil date', Object.freeze({ ...c }));
/** Bytes, copied in. */
export const bytes = (b: Uint8Array): Value => {
  if (
    !ArrayBuffer.isView(b) ||
    Object.prototype.toString.call(b) !== '[object Uint8Array]'
  ) {
    invalidValue('Bytes need a Uint8Array');
  }
  return bytesOf(b.slice());
};
/** Bytes the Abstract Machine made, and never writes to again. */
export const bytesOf = (b: Uint8Array): Value => makeValue('bytes', b);
/** Bytes ordered byte by byte, unsigned, with a prefix first. */
export const compareBytes = (a: Uint8Array, b: Uint8Array): -1 | 0 | 1 => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return a[i]! < b[i]! ? -1 : 1;
    }
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};
/** Bytes' display form, their `<<…>>` build: `<<0x0D, 0x0A>>`. */
const bytesDisplay = (b: Uint8Array): string =>
  `<<${Array.from(b, x => `0x${x.toString(16).toUpperCase().padStart(2, '0')}`).join(', ')}>>`;
/** A Text Pattern value; only the Abstract Machine makes one. */
export const patternValue = (ref: PatternRef): Value =>
  makeValue('pattern', Object.freeze({ ...ref }));
/** A Host Object value; only a Group makes one. */
export const objectValue = (ref: ObjectRef): Value =>
  makeValue('object', Object.freeze({ ...ref }));
/** A Function Value; only the Abstract Machine makes one. */
export const functionValue = (ref: FunctionRef): Value =>
  makeValue(
    'function',
    Object.freeze({ ...ref, captures: Object.freeze([...ref.captures]) }),
  );
// Readers use this array form to avoid JS argument-count limits. It is not a Host API.
export const listValues = (vs: readonly Value[]): Value => {
  vs.forEach(requireValue);
  return makeValue('list', ListStorage.copy(vs));
};
/** Internal List growth; the operation validates both operands' kinds. */
export const extendList = (
  current: Value,
  part: Value,
  prepend: boolean,
  all: boolean,
): Value => extendListValue(current, part, prepend, all);
/** Internal: replace or delete one existing List item, zero-based. */
export const listWithItem = (
  v: Value,
  i: number,
  value: Value | undefined,
): Value => editListValue(v, i, value);
/**
 * Internal: a Map with one normalised key set, or removed when `value` is
 * undefined. Other pairs are already checked and privately owned, so they are shared.
 */
export const mapWithEntry = (
  m: Value,
  nfc: string,
  value: Value | undefined,
): Value => editMapValue(m, nfc, value);
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
    // MapStorage owns its pairs; this validation buffer stays local.
    pairs.push([nfc, value]);
  }
  return makeValue('map', MapStorage.copy(pairs));
};
/**
 * Internal: a map literal's keys, normalised and checked once, so each build
 * of the literal is one pass over its values.
 */
export const mapLayout = (keys: readonly string[]): MapLayout => {
  const nfc = keys.map(normalizeNFC);
  const seen = new Set<string>();
  for (const key of nfc) {
    if (seen.has(key)) {
      invalidValue(`Duplicate map key: ${displayText(key)}`);
    }
    seen.add(key);
  }
  return MapStorage.layout(nfc);
};
/** Internal: a map literal's values, in its layout's key order. */
export const mapOfLayout = (
  layout: MapLayout,
  items: readonly Value[],
): Value => {
  items.forEach(requireValue);
  return makeValue('map', MapStorage.fromLayout(layout, items));
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
// Matches each code point `hiddenCodePoint` accepts, and the quote.
const quoteOrHidden =
  // eslint-disable-next-line no-control-regex -- C0 controls are hidden code points.
  /[\u0000-\u001f"\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;
export const displayText = (s: string): string => {
  if (!quoteOrHidden.test(s)) {
    return `"${s}"`;
  }
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
// A Word key is bare, except `offer`, which source reserves as a key (chapter 2).
const displayKey = (key: string): string => {
  if (key !== 'offer' && /^[A-Z_a-z]\w*$/.test(key)) {
    return key;
  }
  const display = displayText(key);
  return display.startsWith('"') ? display : `"" & ${display}`;
};

/** Every Function reachable through a Host value must belong to its receiving Group. */
export const functionsBelongTo = (
  values: readonly Value[],
  group: object | undefined,
): boolean => {
  const work = [...values];
  const seen = new Set<Value>();
  while (work.length) {
    const value = work.pop()!;
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    if (value.kind === 'function') {
      const fn = value.asFunction()!;
      if (fn.group !== group) {
        return false;
      }
      for (const [, capture] of fn.captures) {
        work.push(capture);
      }
    } else if (value.kind === 'list') {
      for (let i = 1; i <= value.length; i++) {
        work.push(value.index(i));
      }
    } else if (value.kind === 'map') {
      for (const [, entry] of value.entries()) {
        work.push(entry);
      }
    }
  }
  return true;
};

/**
 * Tooling's source form: the display form, with the substitutions that make it
 * source that reads back as an equal value with the same display form. Nothing
 * about it is normative (ADR 0028). An unreadable value keeps its display form.
 */
export const sourceForm = (value: Value): string => {
  const pending: (Value | string)[] = [value];
  const output: string[] = [];
  while (pending.length) {
    const next = pending.pop()!;
    if (typeof next === 'string') {
      output.push(next);
      continue;
    }
    switch (next.kind) {
      case 'text':
        output.push(sourceText(next.asText()!));
        break;
      case 'civil date':
        output.push(`(${displayText(next.toString())} as civil date)`);
        break;
      case 'instant':
        output.push(`(${displayText(next.toString())} as instant)`);
        break;
      case 'list': {
        output.push('[');
        pending.push(']');
        for (let i = next.length; i >= 1; i--) {
          if (i < next.length) {
            pending.push(', ');
          }
          pending.push(next.index(i));
        }
        break;
      }
      case 'range': {
        const { from, to } = next.asRange()!;
        pending.push(to, '..', from);
        break;
      }
      case 'map': {
        output.push('{');
        pending.push('}');
        const entries = next.entries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const [k, v] = entries[i]!;
          if (i < entries.length - 1) {
            pending.push(', ');
          }
          pending.push(v, `${sourceKey(k)}: `);
        }
        break;
      }
      default:
        output.push(next.toString());
    }
  }
  return output.join('');
};
/** A value is readable when it contains no Function Value or Host Object. */
export const isReadable = (value: Value): boolean => {
  const work = [value];
  while (work.length) {
    const next = work.pop()!;
    if (next.kind === 'function' || next.kind === 'object') {
      return false;
    }
    if (next.kind === 'list') {
      for (let i = 1; i <= next.length; i++) {
        work.push(next.index(i));
      }
    } else if (next.kind === 'map') {
      work.push(...next.entries().map(([, v]) => v));
    } else if (next.kind === 'range') {
      const { from, to } = next.asRange()!;
      work.push(from, to);
    }
  }
  return true;
};
// One quoted piece stays as the display form shows it; other Text is one
// hole-free backtick literal, valid wherever a literal is required.
const sourceText = (s: string): string => {
  const display = displayText(s);
  return display === `"${s}"` ? display : backtickText(s);
};
const sourceKey = (key: string): string =>
  key !== 'offer' && /^[A-Z_a-z]\w*$/.test(key) ? key : sourceText(key);
const backtickText = (s: string): string => {
  let out = '';
  const chars = [...s];
  chars.forEach((ch, i) => {
    const cp = ch.codePointAt(0)!;
    if (ch === '`' || ch === '\\' || (ch === '$' && chars[i + 1] === '{')) {
      out += `\\${ch}`;
    } else if (hiddenCodePoint(cp)) {
      out +=
        cp === 10
          ? String.raw`\n`
          : cp === 9
            ? String.raw`\t`
            : String.raw`\u{${cp.toString(16).toUpperCase()}}`;
    } else {
      out += ch;
    }
  });
  return `\`${out}\``;
};
