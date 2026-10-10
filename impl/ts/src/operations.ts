// The value operations the Abstract Machine's instructions perform, as
// chapters 3 and 4 define them. Each raises catalogue errors as a `ScriptError`, and
// reports what its Cost Model rate measures, such as `scanned` and `steps`.
import {
  add,
  compareDec,
  decOf,
  div,
  divide,
  formatDec,
  integerOf,
  isInteger,
  mod,
  multiply,
  negate,
  powerInteger,
  subtract,
  withinLimits,
  ArithmeticError,
  type Dec,
} from './decimal';
import { functionHead } from './code-unit';
import { cacheListExtension, itemsOf } from './costs';
import { BINARY32, BINARY64, readFloat, writeFloat } from './floats';
import {
  acos,
  asin,
  atan,
  atan2,
  cos,
  exp,
  ln,
  log10,
  power,
  sin,
  sqrt,
  tan,
} from './math';
import {
  addMonths,
  checkInstant,
  civilDays,
  civilNs,
  civilOfDays,
  civilOfNs,
  dayOfYear,
  DateRangeError,
  isoWeek,
  NS_PER_DAY,
  NS_PER_SECOND,
  parseCivil,
  parseInstantText,
  weekday,
} from './dates';
import {
  compile,
  literalProgram,
  matchSearch,
  patternData,
  runProgram,
  type Found,
  type PatternData,
  type Program,
  type RunKind,
} from './patterns';
import { characters } from './text';
import {
  isWhiteSpace,
  lower,
  normalizeNFC,
  simpleFold,
  upper,
} from './unicode';
import {
  bool,
  bytesOf,
  civilOf,
  compareBytes,
  instantOf,
  dec,
  extendList,
  list,
  listValues,
  map,
  nothing,
  num,
  patternValue,
  quantity,
  quantityOf,
  range,
  text,
  trimWhiteSpace,
  Value,
  type QuantityRef,
  canonicalNumber,
  decimalParts,
  mapWithEntry,
} from './values';
import {
  combine,
  fromBase,
  parseUnit,
  powerOf,
  sameDimension,
  toBase,
  UnitError,
  unitText,
  type UnitSpec,
} from './units';
import type { PatternElement } from './view';

/** A catalogue error an operation raises, before the machine adds `message` and `at`. */
export class ScriptError extends Error {
  constructor(
    readonly code: string,
    readonly fields: readonly (readonly [string, Value])[] = [],
    /** Raised after, or instead of, the instruction's charge. */
    readonly uncharged = false,
  ) {
    super(code);
    this.name = 'ScriptError';
  }
}
/** Behaviour this Core doesn't implement yet; never a Script error. */
export class NotImplementedError extends Error {
  override name = 'NotImplementedError';
}

export const kindName = (v: Value): string => v.kind;
export const wrongKind = (expected: string, v: Value) =>
  new ScriptError('wrong kind', [
    ['expected', text(expected)],
    ['got', text(kindName(v))],
    ['value', v],
  ]);
export const outOfRange = (field: string, value: Value) =>
  new ScriptError('out of range', [
    ['field', text(field)],
    ['value', value],
  ]);
const outOfDomain = (fn: string, value: Value) =>
  new ScriptError('out of domain', [
    ['function', text(fn)],
    ['value', value],
  ]);

const decOfValue = (v: Value): Dec => decimalParts(v.asDecimal()!);
// Arithmetic results already fit the limits, so they skip `dec`'s re-parse.
export const numberValue = (d: Dec): Value =>
  withinLimits(d) ? canonicalNumber(d) : dec(formatDec(d));
export const integerValue = (n: bigint): Value => numberValue(decOf(n));
const textOf = (v: Value) => v.asText()!;
const utf8 = new TextEncoder();
// Strict UTF-8 (no surrogates, overlongs or truncation), keeping a BOM.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Bytes' strict UTF-8 decoding, or undefined; `text` then normalises it. */
export const decodeUtf8 = (b: Uint8Array): string | undefined => {
  try {
    return strictUtf8.decode(b);
  } catch {
    return undefined;
  }
};
const bytesOperand = (v: Value): Uint8Array => {
  const b = v.bytesView();
  if (!b) {
    throw wrongKind('bytes', v);
  }
  return b;
};
/** A value that must be one byte: an integer from 0 to 255. */
export const byteOf = (v: Value, field: string): number => {
  if (v.kind !== 'number') {
    throw wrongKind('number', v);
  }
  const d = decOfValue(v);
  if (!isInteger(d)) {
    throw wrongKind('integer', v);
  }
  const n = integerOf(d);
  if (n < 0n || n > 255n) {
    throw outOfRange(field, v);
  }
  return Number(n);
};

/** A value's text form (chapter 3): text is itself, and the rest their display form. */
export const textForm = (v: Value): string =>
  v.kind === 'text' ? textOf(v) : v.toString();

// ---------------------------------------------------------------------------
// Equality and ordering
// ---------------------------------------------------------------------------

/** Equality, with what the compare rate's `scanned` counts. */
export const equals = (
  a: Value,
  b: Value,
  fold: boolean,
): { equal: boolean; scanned: number } => {
  const scanned = scannedPairs(a, b, fold);
  if (!fold) {
    return { equal: a.equals(b), scanned };
  }
  return { equal: foldedEquals(a, b), scanned };
};

// Deep equality comparing texts by their simple case foldings.
const foldedEquals = (a: Value, b: Value): boolean => {
  const pending: [Value, Value][] = [[a, b]];
  while (pending.length) {
    const [x, y] = pending.pop()!;
    if (x.kind !== y.kind) {
      return false;
    }
    if (x.kind === 'text') {
      if (simpleFold(textOf(x)) !== simpleFold(textOf(y))) {
        return false;
      }
    } else if (x.kind === 'list') {
      if (x.length !== y.length) {
        return false;
      }
      for (let i = 1; i <= x.length; i++) {
        pending.push([x.index(i), y.index(i)]);
      }
    } else if (x.kind === 'map') {
      const rhs = new Map(y.entries());
      if (x.entries().length !== rhs.size) {
        return false;
      }
      for (const [k, v] of x.entries()) {
        const other = rhs.get(k);
        if (!other) {
          return false;
        }
        pending.push([v, other]);
      }
    } else if (!x.equals(y)) {
      return false;
    }
  }
  return true;
};

const foldText = (s: string, fold: boolean) => (fold ? simpleFold(s) : s);

/**
 * The Characters, items or entries a comparison examines before its answer
 * is known: pairs in order, through the first that differs, or to the end of
 * the shorter (chapter 8, the `compare` rate).
 */
const scannedPairs = (a: Value, b: Value, fold: boolean): number => {
  if (a.kind !== b.kind) {
    return 0;
  }
  if (a.kind === 'text') {
    const x = characters(foldText(textOf(a), fold));
    const y = characters(foldText(textOf(b), fold));
    let i = 0;
    while (i < x.length && i < y.length) {
      i++;
      if (x[i - 1] !== y[i - 1]) {
        break;
      }
    }
    return i;
  }
  if (a.kind === 'bytes') {
    const x = a.bytesView()!;
    const y = b.bytesView()!;
    let i = 0;
    while (i < x.length && i < y.length) {
      i++;
      if (x[i - 1] !== y[i - 1]) {
        break;
      }
    }
    return i;
  }
  if (a.kind === 'list') {
    let i = 0;
    while (i < a.length && i < b.length) {
      i++;
      if (!equals(a.index(i), b.index(i), fold).equal) {
        break;
      }
    }
    return i;
  }
  if (a.kind === 'map') {
    let i = 0;
    for (const [k, v] of a.entries()) {
      i++;
      const other = b.entries().find(([key]) => key === k);
      if (!other || !equals(v, other[1], fold).equal) {
        break;
      }
    }
    return i;
  }
  return 0;
};

const cantCompare = (a: Value, b: Value) =>
  new ScriptError("can't compare", [
    ['left', a],
    ['right', b],
  ]);

const codePoints = (s: string) => Array.from(s, ch => ch.codePointAt(0)!);

/** Chapter 3's ordering: -1, 0 or 1, or `can't compare`. */
export const order = (a: Value, b: Value, fold = false): -1 | 0 | 1 => {
  if (a.kind !== b.kind) {
    throw cantCompare(a, b);
  }
  switch (a.kind) {
    case 'number':
      return compareDec(decOfValue(a), decOfValue(b));
    case 'quantity': {
      const x = a.asQuantityRef()!;
      const y = b.asQuantityRef()!;
      if (!sameDimension(x.unit, y.unit)) {
        throw cantCompare(a, b);
      }
      return compareDec(inBase(x), inBase(y));
    }
    case 'text': {
      const x = codePoints(foldText(textOf(a), fold));
      const y = codePoints(foldText(textOf(b), fold));
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        if (x[i] !== y[i]) {
          return x[i]! < y[i]! ? -1 : 1;
        }
      }
      return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
    }
    case 'bytes':
      return compareBytes(a.bytesView()!, b.bytesView()!);
    case 'instant': {
      const x = a.asInstant()!;
      const y = b.asInstant()!;
      return x === y ? 0 : x < y ? -1 : 1;
    }
    case 'civil date': {
      const x = a.civilRef()!;
      const y = b.civilRef()!;
      // A date-only value and a date-time aren't ordered against each other.
      if ((x.ns === null) !== (y.ns === null)) {
        throw cantCompare(a, b);
      }
      const p = civilNs(x);
      const q = civilNs(y);
      return p === q ? 0 : p < q ? -1 : 1;
    }
    case 'list': {
      for (let i = 1; i <= Math.min(a.length, b.length); i++) {
        if (!equals(a.index(i), b.index(i), fold).equal) {
          return order(a.index(i), b.index(i), fold);
        }
      }
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    }
  }
  throw cantCompare(a, b);
};

export const comparison = (
  op: string,
  a: Value,
  b: Value,
  fold: boolean,
): { result: Value; scanned: number } => {
  if (op === 'equal' || op === 'not-equal') {
    const { equal, scanned } = equals(a, b, fold);
    return { result: bool(op === 'equal' ? equal : !equal), scanned };
  }
  const o = order(a, b, fold);
  const scanned = scannedPairs(a, b, fold);
  const result =
    op === 'less'
      ? o < 0
      : op === 'greater'
        ? o > 0
        : op === 'less-or-equal'
          ? o <= 0
          : o >= 0;
  return { result: bool(result), scanned };
};

/** `x is in xs`: a list's equal element, or a range's `a <= x and x <= b`. */
export const member = (
  x: Value,
  xs: Value,
  fold: boolean,
): { result: Value; scanned: number } => {
  if (xs.kind === 'list') {
    for (let i = 1; i <= xs.length; i++) {
      if (equals(x, xs.index(i), fold).equal) {
        return { result: bool(true), scanned: i };
      }
    }
    return { result: bool(false), scanned: xs.length };
  }
  if (xs.kind === 'range') {
    const { from, to } = xs.asRange()!;
    return {
      result: bool(order(from, x, fold) <= 0 && order(x, to, fold) <= 0),
      scanned: 2,
    };
  }
  throw wrongKind('list', xs);
};

// ---------------------------------------------------------------------------
// Arithmetic and building
// ---------------------------------------------------------------------------

const symbols: Record<string, string> = {
  add: '+',
  subtract: '-',
  multiply: '*',
  divide: '/',
  div: 'div',
  mod: 'mod',
  power: '^',
};
const numberOperand = (v: Value): Dec => {
  if (v.kind !== 'number') {
    throw wrongKind('number', v);
  }
  return decOfValue(v);
};

// ---------------------------------------------------------------------------
// Quantities (chapter 3, Quantity arithmetic)
// ---------------------------------------------------------------------------

const numberOf = (q: QuantityRef): Dec => decimalParts(q.number);
const inBase = (q: QuantityRef): Dec => toBase(numberOf(q), q.unit);
const noUnit: UnitSpec = [];
// A number takes part in `*` and `/` as a Quantity with no Unit.
const asQuantityRef = (v: Value): QuantityRef =>
  v.asQuantityRef() ?? { number: v.asDecimal()!, unit: noUnit };
/** A value in a Unit, or the plain number a Unit with no slots leaves. */
const inUnit = (d: Dec, unit: UnitSpec): Value =>
  unit.length ? quantityOf(numberValue(d).asDecimal()!, unit) : numberValue(d);
// The fields name the two Units' display forms; a plain number's Unit is `1`.
const incompatible = (left: UnitSpec, right: UnitSpec) =>
  new ScriptError('incompatible units', [
    ['left', text(unitText(left))],
    ['right', text(unitText(right))],
  ]);
const unitsOf = (op: () => UnitSpec, left: UnitSpec, right: UnitSpec) => {
  try {
    return op();
  } catch (error) {
    if (error instanceof UnitError) {
      throw incompatible(left, right);
    }
    throw error;
  }
};

const quantityArithmetic = (op: string, a: Value, b: Value): Value => {
  for (const v of [a, b]) {
    if (v.kind !== 'number' && v.kind !== 'quantity') {
      throw wrongKind('number', v);
    }
  }
  switch (op) {
    case 'add':
    case 'subtract': {
      if (a.kind !== b.kind) {
        throw wrongKind(a.kind, b);
      }
      const x = a.asQuantityRef()!;
      const y = b.asQuantityRef()!;
      if (!sameDimension(x.unit, y.unit)) {
        throw incompatible(x.unit, y.unit);
      }
      const sum = (op === 'add' ? add : subtract)(inBase(x), inBase(y));
      return inUnit(fromBase(sum, x.unit), x.unit);
    }
    case 'multiply':
    case 'divide': {
      const x = asQuantityRef(a);
      const y = asQuantityRef(b);
      const unit = unitsOf(() => combine(x.unit, y.unit, op), x.unit, y.unit);
      const value = (op === 'multiply' ? multiply : divide)(
        inBase(x),
        inBase(y),
      );
      return inUnit(fromBase(value, unit), unit);
    }
    case 'power': {
      // A Quantity is raised to a positive integer power, and is never one.
      if (b.kind === 'quantity') {
        throw wrongKind('number', b);
      }
      const n = decOfValue(b);
      if (!isInteger(n) || n.negative || n.coefficient === 0n) {
        throw wrongKind('integer', b);
      }
      const x = a.asQuantityRef()!;
      const unit = unitsOf(
        () => powerOf(x.unit, Number(integerOf(n))),
        x.unit,
        noUnit,
      );
      return inUnit(powerInteger(numberOf(x), integerOf(n)), unit);
    }
  }
  // `div` and `mod` take numbers only.
  throw wrongKind('number', a.kind === 'quantity' ? a : b);
};

// ---------------------------------------------------------------------------
// Dates (chapter 3, Date arithmetic)
// ---------------------------------------------------------------------------

const isDate = (v: Value) => v.kind === 'instant' || v.kind === 'civil date';
const SECONDS = parseUnit('s');
const DAYS = parseUnit('days');
const MONTHS = parseUnit('month');
/** A date past the range: `out of range`, with the year it would have been. */
const yearOutOfRange = (error: unknown) =>
  error instanceof DateRangeError
    ? outOfRange('year', integerValue(error.year))
    : error;
const inRangeDate = (make: () => Value): Value => {
  try {
    return make();
  } catch (error) {
    throw yearOutOfRange(error);
  }
};
// An exact duration in whole nanoseconds, rounded half-even.
const durationNs = (q: QuantityRef): bigint => {
  const ns = roundTo(
    multiply(inBase(q), {
      negative: false,
      coefficient: NS_PER_SECOND,
      exponent: 0,
    }),
    0,
    'half even',
  );
  return (ns.negative ? -1n : 1n) * ns.coefficient;
};
/** `wait d`'s duration in nanoseconds; anything but an exact duration is `wrong kind`. */
export const waitNs = (v: Value): bigint => {
  const q = v.asQuantityRef();
  if (!q) {
    throw wrongKind('quantity', v);
  }
  // A Quantity of another Unit Kind, or a calendar duration, expects `s`.
  if (!sameDimension(q.unit, SECONDS)) {
    throw new ScriptError('wrong kind', [
      ['expected', text('s')],
      ['got', text(unitText(q.unit))],
      ['value', v],
    ]);
  }
  return durationNs(q);
};
// A difference in `s`, with no more decimal places than it needs, at most nine.
const secondsOf = (ns: bigint): Value => {
  let d: Dec = {
    negative: ns < 0n,
    coefficient: ns < 0n ? -ns : ns,
    exponent: -9,
  };
  while (d.exponent < 0 && d.coefficient % 10n === 0n) {
    d = { ...d, coefficient: d.coefficient / 10n, exponent: d.exponent + 1 };
  }
  return inUnit(
    { ...d, negative: d.negative && d.coefficient !== 0n },
    SECONDS,
  );
};

const dateArithmetic = (op: string, a: Value, b: Value): Value => {
  if (!isDate(a)) {
    // A number or a duration on the left of a date.
    throw wrongKind(
      a.kind === 'quantity' ? 'quantity' : 'number',
      a.kind === 'quantity' || a.kind === 'number' ? b : a,
    );
  }
  if (op !== 'add' && op !== 'subtract') {
    throw wrongKind('number', a);
  }
  const sign = op === 'add' ? 1n : -1n;
  const c = a.civilRef();
  if (isDate(b)) {
    const d = b.civilRef();
    if (
      op === 'add' ||
      a.kind !== b.kind ||
      (c && (c.ns === null) !== (d!.ns === null))
    ) {
      throw wrongKind(op === 'add' ? 'quantity' : a.kind, b);
    }
    if (!c) {
      return secondsOf(a.asInstant()! - b.asInstant()!);
    }
    return c.ns === null
      ? inUnit(decOf(civilDays(c) - civilDays(d!)), DAYS)
      : secondsOf(civilNs(c) - civilNs(d!));
  }
  const q = b.asQuantityRef();
  if (!q) {
    throw wrongKind('quantity', b);
  }
  // The Unit the date needs, for `incompatible units`.
  const needs = c?.ns === null ? DAYS : SECONDS;
  if (sameDimension(q.unit, MONTHS) && c) {
    const months = fromBase(inBase(q), MONTHS);
    if (!isInteger(months)) {
      throw incompatible(MONTHS, q.unit);
    }
    return inRangeDate(() => civilOf(addMonths(c, sign * integerOf(months))));
  }
  if (!sameDimension(q.unit, SECONDS)) {
    throw incompatible(needs, q.unit);
  }
  const ns = sign * durationNs(q);
  if (!c) {
    return inRangeDate(() => instantOf(checkInstant(a.asInstant()! + ns)));
  }
  if (c.ns !== null) {
    return inRangeDate(() => civilOf(civilOfNs(civilNs(c) + ns)));
  }
  if (ns % NS_PER_DAY !== 0n) {
    throw incompatible(DAYS, q.unit);
  }
  return inRangeDate(() =>
    civilOf(civilOfDays(civilDays(c) + ns / NS_PER_DAY, null)),
  );
};

export const arithmetic = (op: string, a: Value, b: Value): Value => {
  if (isDate(a) || isDate(b)) {
    try {
      return dateArithmetic(op, a, b);
    } catch (error) {
      throw arithmeticRaise(error, symbols[op]!);
    }
  }
  if (a.kind === 'quantity' || b.kind === 'quantity') {
    try {
      return quantityArithmetic(op, a, b);
    } catch (error) {
      throw arithmeticRaise(error, symbols[op]!);
    }
  }
  const x = numberOperand(a);
  const y = numberOperand(b);
  try {
    switch (op) {
      case 'add':
        return numberValue(add(x, y));
      case 'subtract':
        return numberValue(subtract(x, y));
      case 'multiply':
        return numberValue(multiply(x, y));
      case 'divide':
        return numberValue(divide(x, y));
      case 'div':
        return numberValue(div(x, y));
      case 'mod':
        return numberValue(mod(x, y));
      case 'power':
        if (!inDomain('power', x, y)) {
          throw outOfDomain('power', a);
        }
        return numberValue(power(x, y));
    }
  } catch (error) {
    throw arithmeticRaise(error, symbols[op]!);
  }
  throw new Error(`unknown operator ${op}`);
};
const arithmeticRaise = (error: unknown, operator: string) =>
  error instanceof ArithmeticError
    ? error.code === 'overflow'
      ? new ScriptError('overflow', [['operator', text(operator)]])
      : new ScriptError('division by zero')
    : error;

export const negated = (a: Value): Value => {
  const q = a.asQuantityRef();
  if (q) {
    return inUnit(negate(numberOf(q)), q.unit);
  }
  return numberValue(negate(numberOperand(a)));
};
export const concat = (a: Value, b: Value): Value =>
  text(textForm(a) + textForm(b));
export const makeRange = (a: Value, b: Value): Value => {
  if (a.kind !== 'number' && a.kind !== 'quantity') {
    throw wrongKind('number', a);
  }
  if (b.kind !== a.kind) {
    throw wrongKind(a.kind, b);
  }
  const x = a.asQuantityRef();
  const y = b.asQuantityRef();
  if (x && y && !sameDimension(x.unit, y.unit)) {
    throw incompatible(x.unit, y.unit);
  }
  return range(a, b);
};

// ---------------------------------------------------------------------------
// Kinds and conversion
// ---------------------------------------------------------------------------

const kindNames = new Set([
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
export const isKind = (v: Value, kind: string): Value => {
  if (kind === 'integer') {
    return bool(v.kind === 'number' && isInteger(decOfValue(v)));
  }
  if (!kindNames.has(kind)) {
    throw new NotImplementedError(`\`is a ${kind}\``);
  }
  return bool(v.kind === kind);
};
export const isEmpty = (v: Value): Value =>
  bool(
    (v.kind === 'text' && textOf(v) === '') ||
      (v.kind === 'list' && v.length === 0) ||
      (v.kind === 'map' && v.entries().length === 0) ||
      (v.kind === 'bytes' && v.bytesView()!.length === 0),
  );

const cantConvert = (value: Value, to: string) =>
  new ScriptError("can't convert", [
    ['value', value],
    ['to', text(to)],
  ]);
export const convert = (v: Value, kind: string): Value => {
  switch (kind) {
    case 'text':
      if (v.kind === 'bytes') {
        const decoded = decodeUtf8(v.bytesView()!);
        if (decoded === undefined) {
          throw cantConvert(v, 'text');
        }
        return text(decoded);
      }
      return text(textForm(v));
    case 'bytes':
      if (v.kind === 'bytes') {
        return v;
      }
      if (v.kind === 'text') {
        return bytesOf(utf8.encode(textOf(v)));
      }
      throw cantConvert(v, 'bytes');
    case 'number':
      if (v.kind === 'number') {
        return v;
      }
      if (v.kind === 'text') {
        try {
          return dec(textOf(v));
        } catch {
          throw cantConvert(v, 'number');
        }
      }
      throw cantConvert(v, 'number');
    case 'civil date':
    case 'instant': {
      if (v.kind === kind) {
        return v;
      }
      if (v.kind !== 'text') {
        throw cantConvert(v, kind);
      }
      const s = trimWhiteSpace(textOf(v));
      try {
        if (kind === 'instant') {
          const ns = parseInstantText(s);
          if (ns !== undefined) {
            return instantOf(ns);
          }
        } else {
          const c = parseCivil(s);
          if (c) {
            return civilOf(c);
          }
        }
      } catch (error) {
        throw yearOutOfRange(error);
      }
      throw cantConvert(v, kind);
    }
  }
  return convertToUnit(v, kind);
};

// `as` with a Unit (chapter 3): a number takes the Unit, a Quantity of its
// dimension converts through Base Units, and text reads as either first.
const convertToUnit = (v: Value, written: string): Value => {
  const unit = parseUnit(written);
  const to = unitText(unit);
  let input = v;
  if (v.kind === 'text') {
    const m = /^(-?(?:0x[\dA-Fa-f]+|\d+(?:\.\d+)?)) *(.*)$/s.exec(
      trimWhiteSpace(textOf(v)),
    );
    try {
      input = !m ? v : m[2] ? quantity(dec(m[1]!), m[2]) : dec(m[1]!);
    } catch {
      throw cantConvert(v, to);
    }
  }
  if (input.kind === 'number') {
    return inUnit(decOfValue(input), unit);
  }
  const q = input.asQuantityRef();
  if (!q || !sameDimension(q.unit, unit)) {
    throw cantConvert(v, to);
  }
  try {
    return inUnit(fromBase(inBase(q), unit), unit);
  } catch (error) {
    // A value past the number limits in the Unit doesn't convert.
    throw error instanceof ArithmeticError ? cantConvert(v, to) : error;
  }
};
export const canConvert = (v: Value, kind: string): Value => {
  try {
    convert(v, kind);
    return bool(true);
  } catch (error) {
    if (error instanceof ScriptError) {
      return bool(false);
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Keys and properties
// ---------------------------------------------------------------------------

export const getKey = (m: Value, key: string): Value => {
  if (m.kind !== 'map') {
    throw wrongKind('map', m);
  }
  return m.get(key);
};
export const keyText = (k: Value): string => {
  if (k.kind !== 'text') {
    throw wrongKind('text', k);
  }
  return textOf(k);
};
export const hasKey = (m: Value, key: string): boolean => {
  if (m.kind !== 'map') {
    throw wrongKind('map', m);
  }
  const nfc = normalizeNFC(key);
  return m.entries().some(([k]) => k === nfc);
};
export const setKey = (m: Value, key: string, value: Value): Value => {
  if (m.kind !== 'map') {
    throw wrongKind('map', m);
  }
  return mapWithEntry(m, normalizeNFC(key), value);
};
export const deleteKey = (m: Value, key: string): Value => {
  if (m.kind !== 'map') {
    throw wrongKind('map', m);
  }
  return mapWithEntry(m, normalizeNFC(key), undefined);
};

const integersOf = (r: Value): Value[] => {
  const { from } = r.asRange()!;
  const start = integerOf(decOfValue(from));
  return Array.from({ length: itemsOf(r) }, (_, i) =>
    integerValue(start + BigInt(i)),
  );
};
const isIntegerRange = (v: Value) => {
  if (v.kind !== 'range') {
    return false;
  }
  const { from, to } = v.asRange()!;
  return (
    from.kind === 'number' &&
    isInteger(decOfValue(from)) &&
    isInteger(decOfValue(to))
  );
};
const texts = (xs: readonly string[]) => listValues(xs.map(x => text(x)));

export const property = (
  name: string,
  v: Value,
  delimiter: Value | null = null,
): Value => {
  switch (name) {
    case 'length':
      if (v.kind === 'text') {
        return integerValue(BigInt(characters(textOf(v)).length));
      }
      if (v.kind === 'list') {
        return integerValue(BigInt(v.length));
      }
      if (v.kind === 'map') {
        return integerValue(BigInt(v.entries().length));
      }
      if (isIntegerRange(v)) {
        return integerValue(BigInt(itemsOf(v)));
      }
      if (v.kind === 'bytes') {
        return integerValue(BigInt(v.bytesView()!.length));
      }
      throw wrongKind('text', v);
    case 'keys':
    case 'values':
      if (v.kind !== 'map') {
        throw wrongKind('map', v);
      }
      return listValues(
        v.entries().map(([k, value]) => (name === 'keys' ? text(k) : value)),
      );
    case 'items': {
      const d = delimiterText(delimiter);
      if (v.kind === 'text') {
        return texts(spans(textOf(v), 'item', d).map(s => s.text));
      }
      if (v.kind === 'list') {
        return v;
      }
      if (isIntegerRange(v)) {
        return listValues(integersOf(v));
      }
      throw wrongKind('list', v);
    }
    case 'lines':
    case 'words':
    case 'characters':
    case 'code points':
      if (v.kind !== 'text') {
        throw wrongKind('text', v);
      }
      return texts(spans(textOf(v), singular(name)).map(s => s.text));
    case 'bytes':
      return listValues(
        Array.from(bytesOperand(v), x => integerValue(BigInt(x))),
      );
  }
  throw new Error(`unknown property ${name}`);
};
const singular = (name: string) =>
  name === 'code points' ? 'code point' : name.slice(0, -1);

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

type Span = { from: number; text: string; to: number };
const delimiterText = (d: Value | null): string => {
  if (d === null) {
    return ',';
  }
  if (d.kind !== 'text') {
    throw wrongKind('text', d);
  }
  if (!characters(textOf(d)).length) {
    throw outOfRange('delimiter', d);
  }
  return textOf(d);
};
const isLineBreak = (ch: string) => ch === '\n' || ch === '\r' || ch === '\r\n';

/**
 * A text's chunks of one kind, as half-open unit offsets: Characters for most
 * kinds, and code points for `code point`.
 */
const spans = (s: string, kind: string, delimiter = ','): Span[] => {
  if (kind === 'code point') {
    return Array.from(s, (ch, i) => ({ from: i, to: i + 1, text: ch }));
  }
  const cs = characters(s);
  const span = (from: number, to: number) => ({
    from,
    to,
    text: cs.slice(from, to).join(''),
  });
  switch (kind) {
    case 'character':
      return cs.map((_, i) => span(i, i + 1));
    case 'word': {
      const out: Span[] = [];
      let start = -1;
      cs.forEach((ch, i) => {
        const space = isWhiteSpace(ch.codePointAt(0)!);
        if (!space && start < 0) {
          start = i;
        } else if (space && start >= 0) {
          out.push(span(start, i));
          start = -1;
        }
      });
      if (start >= 0) {
        out.push(span(start, cs.length));
      }
      return out;
    }
    case 'line':
    case 'item': {
      if (!cs.length) {
        return [];
      }
      const d = kind === 'item' ? characters(delimiter) : [];
      const out: Span[] = [];
      let from = 0;
      for (let i = 0; i < cs.length;) {
        const width =
          kind === 'line'
            ? isLineBreak(cs[i]!)
              ? 1
              : 0
            : d.every((ch, j) => cs[i + j] === ch)
              ? d.length
              : 0;
        if (width) {
          out.push(span(from, i));
          i += width;
          from = i;
        } else {
          i++;
        }
      }
      if (from < cs.length) {
        out.push(span(from, cs.length));
      }
      return out;
    }
  }
  throw new Error(`unknown text chunk ${kind}`);
};

// A chunk index: one integer, or an integer range, each end from 1 or from
// the end when negative.
type Index = { from: bigint; range: boolean; to: bigint; written: Value };
const indexOf = (v: Value): Index => {
  const one = (x: Value): bigint => {
    if (x.kind !== 'number') {
      throw wrongKind('number', x);
    }
    const d = decOfValue(x);
    if (!isInteger(d)) {
      throw wrongKind('integer', x);
    }
    return integerOf(d);
  };
  if (v.kind === 'range') {
    const { from, to } = v.asRange()!;
    return { from: one(from), to: one(to), range: true, written: v };
  }
  const i = one(v);
  return { from: i, to: i, range: false, written: v };
};
const fromEnd = (i: bigint, n: number) => (i < 0n ? BigInt(n) + 1n + i : i);
// The 1-based chunks an index covers among n, clipped, or null if none.
const covered = (index: Index, n: number): [number, number] | null => {
  const a = fromEnd(index.from, n);
  const b = fromEnd(index.to, n);
  if (a > b) {
    return null;
  }
  const lo = a < 1n ? 1n : a;
  const hi = b > BigInt(n) ? BigInt(n) : b;
  if (index.range ? lo > hi : a !== lo || b !== hi) {
    return null;
  }
  return [Number(lo), Number(hi)];
};

const textKinds = new Set(['character', 'word', 'line', 'item', 'code point']);
const joinSpans = (
  s: string,
  kind: string,
  chunks: Span[],
  lo: number,
  hi: number,
) => {
  if (kind === 'code point') {
    return Array.from(s)
      .slice(chunks[lo - 1]!.from, chunks[hi - 1]!.to)
      .join('');
  }
  return characters(s)
    .slice(chunks[lo - 1]!.from, chunks[hi - 1]!.to)
    .join('');
};

/** One chunk level read, with `scanned`: the units from the start to the chunk's end. */
export const chunkGet = (
  kind: string,
  indexValue: Value,
  whole: Value,
  delimiter: Value | null,
): { result: Value; scanned: number } => {
  const index = indexOf(indexValue);
  if (whole.kind === 'text' && textKinds.has(kind)) {
    const s = textOf(whole);
    const chunks = spans(s, kind, delimiterText(delimiter));
    const units =
      kind === 'code point' ? Array.from(s).length : characters(s).length;
    const at = covered(index, chunks.length);
    if (!at) {
      return { result: text(''), scanned: units };
    }
    return {
      result: text(joinSpans(s, kind, chunks, at[0], at[1])),
      scanned: chunks[at[1] - 1]!.to,
    };
  }
  if (kind === 'item' && (whole.kind === 'list' || isIntegerRange(whole))) {
    const items = whole.kind === 'list' ? null : integersOf(whole);
    const n = items ? items.length : whole.length;
    const item = (i: number) => (items ? items[i - 1]! : whole.index(i));
    const at = covered(index, n);
    if (!at) {
      return { result: index.range ? list() : nothing, scanned: n };
    }
    const result = index.range
      ? listValues(
          Array.from({ length: at[1] - at[0] + 1 }, (_, i) => item(at[0] + i)),
        )
      : item(at[0]);
    return { result, scanned: at[1] };
  }
  if (kind === 'byte') {
    const b = bytesOperand(whole);
    const at = covered(index, b.length);
    if (!at) {
      return {
        result: index.range ? bytesOf(new Uint8Array()) : nothing,
        scanned: b.length,
      };
    }
    const result = index.range
      ? bytesOf(b.slice(at[0] - 1, at[1]))
      : integerValue(BigInt(b[at[0] - 1]!));
    return { result, scanned: at[1] };
  }
  throw wrongKind(kind === 'item' ? 'list' : 'text', whole);
};

/** Whether a chunk is there, for `delete`'s tests. */
export const chunkThere = (
  kind: string,
  indexValue: Value,
  whole: Value,
  delimiter: Value | null,
): boolean => {
  const index = indexOf(indexValue);
  const n =
    whole.kind === 'text' && textKinds.has(kind)
      ? spans(textOf(whole), kind, delimiterText(delimiter)).length
      : kind === 'item' && whole.kind === 'list'
        ? whole.length
        : kind === 'item' && isIntegerRange(whole)
          ? itemsOf(whole)
          : kind === 'byte'
            ? bytesOperand(whole).length
            : -1;
  if (n < 0) {
    throw wrongKind(kind === 'item' ? 'list' : 'text', whole);
  }
  return covered(index, n) !== null;
};

const writeOutOfRange = (kind: string, index: Index) =>
  outOfRange(
    kind,
    index.range
      ? list(index.written.asRange()!.from, index.written.asRange()!.to)
      : index.written,
  );

/** One chunk level of a write: the new whole, with `part` in the chunk's place. */
export const chunkSet = (
  kind: string,
  indexValue: Value,
  whole: Value,
  part: Value,
  delimiter: Value | null,
): Value => {
  const index = indexOf(indexValue);
  if (whole.kind === 'text' && textKinds.has(kind)) {
    const d = delimiterText(delimiter);
    let s = textOf(whole);
    let chunks = spans(s, kind, d);
    const n = chunks.length;
    const a = fromEnd(index.from, n);
    const b = fromEnd(index.to, n);
    // Index 0, before the start, or reversed raise for every kind.
    if (a < 1n || b < 1n || a > b) {
      throw writeOutOfRange(kind, index);
    }
    if (b > BigInt(n)) {
      if (kind !== 'item' && kind !== 'line') {
        throw writeOutOfRange(kind, index);
      }
      // Pad with delimiters, or line breaks, up to the chunk written.
      const pad = kind === 'line' ? '\n' : d;
      const cs = characters(s);
      const ends =
        (kind === 'line' && cs.length > 0 && isLineBreak(cs.at(-1)!)) ||
        (kind === 'item' && s.length > 0 && s.endsWith(d));
      const count = Number(b) - n - 1 + (s === '' || ends ? 0 : 1);
      s += pad.repeat(count);
      if (Number(a) > n) {
        // The new chunks are empty, at the very end.
        return text(s + textForm(part));
      }
      chunks = spans(s, kind, d);
    }
    const lo = Number(a);
    const hi = Number(b);
    const units = kind === 'code point' ? Array.from(s) : characters(s);
    const from = chunks[lo - 1]!.from;
    const to = hi <= chunks.length ? chunks[hi - 1]!.to : units.length;
    return text(
      units.slice(0, from).join('') + textForm(part) + units.slice(to).join(''),
    );
  }
  if (kind === 'item' && whole.kind === 'list') {
    const n = whole.length;
    const a = fromEnd(index.from, n);
    const b = fromEnd(index.to, n);
    if (a < 1n || b < 1n || a > b) {
      throw writeOutOfRange(kind, index);
    }
    const items = Array.from({ length: n }, (_, i) => whole.index(i + 1));
    while (items.length < Number(b)) {
      items.push(nothing);
    }
    if (!index.range) {
      items[Number(a) - 1] = part;
      return listValues(items);
    }
    if (part.kind !== 'list') {
      throw wrongKind('list', part);
    }
    const replacement = Array.from({ length: part.length }, (_, i) =>
      part.index(i + 1),
    );
    items.splice(Number(a) - 1, Number(b - a) + 1, ...replacement);
    return listValues(items);
  }
  if (kind === 'byte') {
    // A byte is replaced by one integer, and a range of bytes by Bytes. A
    // write never pads Bytes, so past the end raises.
    const old = bytesOperand(whole);
    const n = old.length;
    const a = fromEnd(index.from, n);
    const b = fromEnd(index.to, n);
    if (a < 1n || b < 1n || a > b || b > BigInt(n)) {
      throw writeOutOfRange(kind, index);
    }
    if (!index.range) {
      const out = old.slice();
      out[Number(a) - 1] = byteOf(part, 'byte');
      return bytesOf(out);
    }
    const replacement = bytesOperand(part);
    const out = new Uint8Array(n - Number(b - a) - 1 + replacement.length);
    out.set(old.subarray(0, Number(a) - 1));
    out.set(replacement, Number(a) - 1);
    out.set(old.subarray(Number(b)), Number(a) - 1 + replacement.length);
    return bytesOf(out);
  }
  throw wrongKind(kind === 'item' ? 'list' : 'text', whole);
};

/** `delete` of one chunk: the whole without it, or as it was when it isn't there. */
export const chunkDelete = (
  kind: string,
  indexValue: Value,
  whole: Value,
  delimiter: Value | null,
): Value => {
  const index = indexOf(indexValue);
  if (whole.kind === 'text' && textKinds.has(kind)) {
    const s = textOf(whole);
    const chunks = spans(s, kind, delimiterText(delimiter));
    const at = covered(index, chunks.length);
    if (!at) {
      return whole;
    }
    const units = kind === 'code point' ? Array.from(s) : characters(s);
    let from = chunks[at[0] - 1]!.from;
    let to = chunks[at[1] - 1]!.to;
    if (kind === 'word' || kind === 'line' || kind === 'item') {
      // A word takes the white space after it, or before it if it's last; a
      // line or item its delimiter after, or before if it's last.
      const next = chunks[at[1]];
      const before = chunks[at[0] - 2];
      if (next) {
        to = next.from;
      } else if (before) {
        from = before.to;
      } else if (kind === 'word') {
        // The only word is also the last: it goes with the white space before it.
        from = 0;
      } else {
        // The only line or item goes with any delimiter after it.
        to = units.length;
      }
    }
    return text(units.slice(0, from).join('') + units.slice(to).join(''));
  }
  if (kind === 'item' && whole.kind === 'list') {
    const at = covered(index, whole.length);
    if (!at) {
      return whole;
    }
    const items = Array.from({ length: whole.length }, (_, i) =>
      whole.index(i + 1),
    );
    items.splice(at[0] - 1, at[1] - at[0] + 1);
    return listValues(items);
  }
  if (kind === 'byte') {
    const b = bytesOperand(whole);
    const at = covered(index, b.length);
    if (!at) {
      return whole;
    }
    const out = new Uint8Array(b.length - (at[1] - at[0] + 1));
    out.set(b.subarray(0, at[0] - 1));
    out.set(b.subarray(at[1]), at[0] - 1);
    return bytesOf(out);
  }
  throw wrongKind(kind === 'item' ? 'list' : 'text', whole);
};

export const appendTo = (
  current: Value,
  e: Value,
  op: 'append' | 'prepend' | 'append-all' | 'prepend-all',
): Value => {
  const after = op === 'append' || op === 'append-all';
  const all = op === 'append-all' || op === 'prepend-all';
  if (all) {
    if (current.kind !== 'list') {
      throw wrongKind('list', current);
    }
    if (e.kind !== 'list') {
      throw wrongKind('list', e);
    }
  }
  if (current.kind === 'list') {
    const result = extendList(current, e, !after, all);
    cacheListExtension(result, current, e, all);
    return result;
  }
  if (current.kind === 'text') {
    return text(
      after ? textOf(current) + textForm(e) : textForm(e) + textOf(current),
    );
  }
  throw wrongKind('text', current);
};

// ---------------------------------------------------------------------------
// Text Patterns
// ---------------------------------------------------------------------------

const folded = new WeakMap<PatternData, Program>();
/** A Text Pattern value from resolved elements. */
export const makePatternValue = (els: readonly PatternElement[]): Value => {
  const data = patternData(els);
  return patternValue({
    source: data.source,
    data,
    program: data.program.code.length,
  });
};
const dataOf = (p: Value) => p.asPattern()!.data as PatternData;
const programOf = (needle: Value, fold: boolean): Program => {
  if (needle.kind === 'text') {
    return literalProgram(textOf(needle), fold);
  }
  if (needle.kind !== 'pattern') {
    throw wrongKind('pattern', needle);
  }
  const data = dataOf(needle);
  if (!fold) {
    return data.program;
  }
  let program = folded.get(data);
  if (!program) {
    program = compile(data.els, true);
    folded.set(data, program);
  }
  return program;
};

/**
 * A template's splices resolved: a spliced pattern becomes a group of its
 * elements and spliced text a literal. Spliced Captures that clash or sit in a
 * repetition raise `can't convert`.
 */
export const splice = (
  template: readonly PatternElement[],
  values: readonly Value[],
): Value => {
  let next = 0;
  const names = new Set<string>();
  let clash: Value | null = null;
  const resolve = (
    els: readonly PatternElement[],
    repeated: boolean,
  ): PatternElement[] => els.map(e => resolveOne(e, repeated));
  const captureNames = (
    els: readonly PatternElement[],
    repeated: boolean,
    from: Value,
  ) => {
    const work = els.map(e => ({ e, repeated }));
    while (work.length) {
      const { e, repeated: r } = work.pop()!;
      if (e.k === 'capture') {
        if (r || names.has(e.name.text)) {
          clash ??= from;
        }
        names.add(e.name.text);
      }
      const inner =
        e.k === 'group'
          ? e.els
          : e.k === 'alternation'
            ? e.options
            : 'e' in e && typeof e.e === 'object' && e.k !== 'splice'
              ? [e.e]
              : [];
      for (const x of inner) {
        work.push({ e: x, repeated: r || e.k === 'repeat' || e.k === 'count' });
      }
    }
  };
  const resolveOne = (e: PatternElement, repeated: boolean): PatternElement => {
    switch (e.k) {
      case 'splice': {
        const v = values[next++]!;
        if (v.kind === 'text') {
          return { k: 'text', value: textOf(v) };
        }
        if (v.kind !== 'pattern') {
          throw wrongKind('pattern', v);
        }
        const els = dataOf(v).els;
        captureNames(els, repeated, v);
        return { k: 'group', els: [...els] };
      }
      case 'capture':
        names.add(e.name.text);
        return { ...e, e: resolveOne(e.e, repeated) };
      case 'group':
        return { k: 'group', els: resolve(e.els, repeated) };
      case 'alternation':
        return {
          k: 'alternation',
          options: e.options.map(x => resolveOne(x, repeated)),
        };
      case 'count':
      case 'repeat':
        return { ...e, e: resolveOne(e.e, true) };
      case 'suffixed':
        return { ...e, e: resolveOne(e.e, repeated) };
    }
    return e;
  };
  const els = resolve(template, false);
  if (clash) {
    throw cantConvert(clash, 'pattern');
  }
  return makePatternValue(els);
};

const subjectText = (s: Value) => {
  if (s.kind !== 'text') {
    throw wrongKind('text', s);
  }
  return characters(textOf(s));
};

// Bytes search as a text literal searches Characters, one position per byte:
// each byte stands for a private-use code point, which is a Character alone.
const byteUnits = (b: Uint8Array): string[] =>
  Array.from(b, x => String.fromCodePoint(0xe0_00 + x));

/** `contains`, `begins with`, `ends with` and `matches`, with their `steps`. */
export const search = (
  op: string,
  subject: Value,
  needle: Value,
  fold: boolean,
): { result: Value; steps: number } => {
  const bytesSearch = subject.kind === 'bytes' && op !== 'matches';
  const cs = bytesSearch
    ? byteUnits(subject.bytesView()!)
    : subjectText(subject);
  const program = bytesSearch
    ? literalProgram(byteUnits(bytesOperand(needle)).join(''), false)
    : programOf(needle, fold);
  const kind: RunKind =
    op === 'contains'
      ? 'search'
      : op === 'begins-with'
        ? 'prefix'
        : op === 'ends-with'
          ? 'suffix'
          : 'whole';
  const run = runProgram(program, cs, 0, kind, true);
  return { result: bool(run.found !== null), steps: run.steps };
};

const capturesOf = (
  program: Program,
  cs: readonly string[],
  found: Found,
): { captures: Value; ranges: Value } => {
  const captures: [string, Value][] = [];
  const ranges: [string, Value][] = [];
  program.captures.forEach(({ name, number }, i) => {
    const from = found.slots[2 * i];
    const to = found.slots[2 * i + 1];
    if (
      from === null ||
      from === undefined ||
      to === null ||
      to === undefined
    ) {
      captures.push([name, nothing]);
      ranges.push([name, nothing]);
      return;
    }
    const matched = cs.slice(from, to).join('');
    let value = text(matched);
    if (number) {
      try {
        value = dec(matched);
      } catch {
        throw cantConvert(value, 'number');
      }
    }
    captures.push([name, value]);
    ranges.push([
      name,
      range(integerValue(BigInt(from + 1)), integerValue(BigInt(to))),
    ]);
  });
  return { captures: map(captures), ranges: map(ranges) };
};
const matchOf = (
  program: Program,
  cs: readonly string[],
  found: Found,
): Value => {
  const { captures, ranges } = capturesOf(program, cs, found);
  return map([
    ['text', text(cs.slice(found.start, found.end).join(''))],
    [
      'range',
      range(
        integerValue(BigInt(found.start + 1)),
        integerValue(BigInt(found.end)),
      ),
    ],
    ['captures', captures],
    ['ranges', ranges],
  ]);
};

/** `match-whole` and `match-search`: the Captures map, or null on no match. */
export const matchCaptures = (
  whole: boolean,
  subject: Value,
  pattern: Value,
  fold: boolean,
): { result: Value | null; steps: number } => {
  if (
    subject.kind !== 'text' ||
    (pattern.kind !== 'pattern' && pattern.kind !== 'text')
  ) {
    // A test never raises on the wrong kind: it fails.
    return { result: null, steps: 0 };
  }
  const cs = subjectText(subject);
  const program = programOf(pattern, fold);
  const run = runProgram(program, cs, 0, whole ? 'whole' : 'search');
  if (!run.found) {
    return { result: null, steps: run.steps };
  }
  return {
    result: capturesOf(program, cs, run.found).captures,
    steps: run.steps,
  };
};

/** The Match Search over a text, as Matches. */
export const matchesOf = (
  pattern: Value,
  subject: Value,
  limit = Infinity,
): {
  cs: readonly string[];
  found: Found[];
  matches: Value[];
  steps: number;
} => {
  const cs = subjectText(subject);
  const program = programOf(pattern, false);
  const { found, steps } = matchSearch(program, cs, limit);
  return { matches: found.map(f => matchOf(program, cs, f)), steps, cs, found };
};

// ---------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------

const roundModes = new Set([
  'half up',
  'half even',
  'up',
  'down',
  'floor',
  'ceiling',
]);
const roundTo = (x: Dec, places: number, mode: string): Dec => {
  const shift = -x.exponent - places;
  if (shift <= 0) {
    // Already that exact: write it with exactly `places` digits.
    return {
      ...x,
      coefficient: x.coefficient * 10n ** BigInt(-shift),
      exponent: -places,
    };
  }
  const unit = 10n ** BigInt(shift);
  const q = x.coefficient / unit;
  const r = x.coefficient % unit;
  const half = 2n * r;
  let up: boolean;
  switch (mode) {
    case 'half up':
      up = half >= unit;
      break;
    case 'half even':
      up = half > unit || (half === unit && q % 2n === 1n);
      break;
    case 'up':
      up = r > 0n;
      break;
    case 'down':
      up = false;
      break;
    case 'floor':
      up = r > 0n && x.negative;
      break;
    default:
      up = r > 0n && !x.negative;
  }
  const coefficient = up ? q + 1n : q;
  return {
    negative: x.negative && coefficient !== 0n,
    coefficient,
    exponent: -places,
  };
};

// `abs`, `floor`, `ceiling`, `truncate` and `round` act on a Quantity's
// number and keep its Unit (chapter 7).
const magnitudeOperand = (v: Value): Dec => {
  const q = v.asQuantityRef();
  return q ? numberOf(q) : numberOperand(v);
};
const sameUnit = (v: Value, d: Dec): Value => {
  const q = v.asQuantityRef();
  return q ? inUnit(d, q.unit) : numberValue(d);
};

// A Civil Date's field (chapter 7, Dates); a time field of a date-only value
// is `out of domain`.
const dateField = (name: string, d: Value): Value => {
  const c = d.civilRef();
  if (!c) {
    throw wrongKind('civil date', d);
  }
  if (name === 'hasTime') {
    return bool(c.ns !== null);
  }
  const date: Record<string, () => number> = {
    year: () => c.year,
    month: () => c.month,
    day: () => c.day,
    weekday: () => weekday(c),
    dayOfYear: () => dayOfYear(c),
    isoWeek: () => isoWeek(c).week,
    isoWeekYear: () => isoWeek(c).year,
  };
  if (date[name]) {
    return integerValue(BigInt(date[name]()));
  }
  if (c.ns === null) {
    throw outOfDomain(name, d);
  }
  const seconds = c.ns / NS_PER_SECOND;
  const field: Record<string, bigint> = {
    hour: seconds / 3600n,
    minute: (seconds / 60n) % 60n,
    second: seconds % 60n,
    nanosecond: c.ns % NS_PER_SECOND,
  };
  return integerValue(field[name]!);
};
// `offset` in `toCivil` and `toInstant`: an exact duration of whole minutes,
// less than 24 hr in magnitude, as nanoseconds.
const offsetOf = (name: string, v: Value): bigint => {
  const q = v.asQuantityRef();
  const seconds = q && sameDimension(q.unit, SECONDS) ? inBase(q) : undefined;
  const whole = seconds && isInteger(seconds) ? integerOf(seconds) : undefined;
  if (
    whole === undefined ||
    whole % 60n !== 0n ||
    whole >= 86_400n ||
    whole <= -86_400n
  ) {
    throw outOfDomain(name, v);
  }
  return whole * NS_PER_SECOND;
};

// Chapter 7's correctly rounded number functions, on plain numbers, with
// their domains.
const unary: Record<string, (x: Dec) => Dec> = {
  sqrt,
  exp,
  ln,
  log10,
  sin,
  cos,
  tan,
  asin,
  acos,
  atan,
};
const ONE: Dec = { negative: false, coefficient: 1n, exponent: 0 };
const inDomain = (name: string, x: Dec, y?: Dec): boolean => {
  switch (name) {
    case 'power':
      return !x.negative || isInteger(y!);
    case 'sqrt':
      return !x.negative;
    case 'ln':
    case 'log10':
      return !x.negative && x.coefficient !== 0n;
    case 'asin':
    case 'acos':
      return compareDec({ ...x, negative: false }, ONE) <= 0;
  }
  return true;
};
const numberFunction = (name: string, args: readonly Value[]): Value => {
  const [x, y] = args.map(numberOperand) as [Dec, Dec | undefined];
  try {
    if (!inDomain(name, x, y)) {
      throw outOfDomain(name, args[0]!);
    }
    if (name === 'power') {
      return numberValue(power(x, y!));
    }
    if (name === 'atan2') {
      if (x.coefficient === 0n && y!.coefficient === 0n) {
        throw outOfDomain(name, args[0]!);
      }
      return numberValue(atan2(x, y!));
    }
    return numberValue(unary[name]!(x));
  } catch (error) {
    throw arithmeticRaise(error, name);
  }
};

// `order` in the Float Built-ins: "big" or "little", as whether it's little.
const littleOrder = (name: string, v: Value): boolean => {
  if (v.kind !== 'text') {
    throw wrongKind('text', v);
  }
  if (textOf(v) !== 'big' && textOf(v) !== 'little') {
    throw outOfDomain(name, v);
  }
  return textOf(v) === 'little';
};
const fromFloat = (name: string, b: Value, order: Value): Value => {
  const format = name === 'fromFloat64' ? BINARY64 : BINARY32;
  const view = b.bytesView();
  if (b.kind !== 'bytes' || !view) {
    throw wrongKind('bytes', b);
  }
  const little = littleOrder(name, order);
  if (view.length !== format.bytes) {
    throw outOfDomain(name, b);
  }
  const d = readFloat(view, format, little);
  if (!d || d.coefficient >= 10n ** BigInt(34 - d.exponent)) {
    throw cantConvert(b, 'number');
  }
  return numberValue(d);
};
const toFloat = (name: string, n: Value, order: Value): Value => {
  const format = name === 'toFloat64' ? BINARY64 : BINARY32;
  const d = numberOperand(n);
  return bytesOf(writeFloat(d, format, littleOrder(name, order)));
};

export type BuiltinResult = { result: Value; scanned?: number; steps?: number };
/** A Built-in call, with its defaults filled in. */
export const builtin = (
  name: string,
  args: readonly Value[],
): BuiltinResult => {
  const [x, y, z] = args;
  switch (name) {
    case 'min':
    case 'max': {
      if (x!.kind !== 'list') {
        throw wrongKind('list', x!);
      }
      if (x!.length === 0) {
        throw outOfDomain(name, x!);
      }
      let best = x!.index(1);
      for (let i = 2; i <= x!.length; i++) {
        const o = order(x!.index(i), best);
        if (name === 'min' ? o < 0 : o > 0) {
          best = x!.index(i);
        }
      }
      return { result: best, scanned: x!.length };
    }
    case 'codePoint': {
      if (x!.kind !== 'text') {
        throw wrongKind('text', x!);
      }
      const points = Array.from(textOf(x!));
      if (points.length !== 1) {
        throw outOfDomain(name, x!);
      }
      return { result: integerValue(BigInt(points[0]!.codePointAt(0)!)) };
    }
    case 'fromCodePoint': {
      if (x!.kind !== 'number') {
        throw wrongKind('number', x!);
      }
      const d = decOfValue(x!);
      const n = isInteger(d) ? integerOf(d) : -1n;
      if (n < 0n || n > 1_114_111n || (n >= 55_296n && n <= 57_343n)) {
        throw outOfDomain(name, x!);
      }
      return { result: text(String.fromCodePoint(Number(n))) };
    }
    case 'upper':
    case 'lower':
      if (x!.kind !== 'text') {
        throw wrongKind('text', x!);
      }
      return { result: text((name === 'upper' ? upper : lower)(textOf(x!))) };
    case 'offset': {
      const cs = subjectText(y!);
      const run = runProgram(programOf(x!, false), cs, 0, 'search');
      return {
        result: integerValue(run.found ? BigInt(run.found.start + 1) : 0n),
        steps: run.steps,
      };
    }
    case 'rangeStart':
    case 'rangeEnd': {
      if (x!.kind !== 'range') {
        throw wrongKind('range', x!);
      }
      const { from, to } = x!.asRange()!;
      return { result: name === 'rangeStart' ? from : to };
    }
    case 'kindOf':
      return { result: text(kindName(x!)) };
    case 'functionArity':
    case 'functionName': {
      if (x!.kind !== 'function') {
        throw wrongKind('function', x!);
      }
      const head = functionHead(x!.asFunction()!.code)!;
      if (name === 'functionName') {
        return { result: head.name === null ? nothing : text(head.name) };
      }
      const { min, max } = head;
      return {
        result: range(integerValue(BigInt(min)), integerValue(BigInt(max))),
      };
    }
    case 'objectKind':
      if (x!.kind !== 'object') {
        throw wrongKind('object', x!);
      }
      // The Core holds the kind beside the id, so a disposed object answers.
      return { result: text(x!.asObjectRef()!.kind) };
    case 'isDisposed':
      if (x!.kind !== 'object') {
        throw wrongKind('object', x!);
      }
      return {
        result: bool(
          (x!.asObjectRef()!.handle as { disposed: boolean }).disposed,
        ),
      };
    case 'year':
    case 'month':
    case 'day':
    case 'hour':
    case 'minute':
    case 'second':
    case 'nanosecond':
    case 'weekday':
    case 'dayOfYear':
    case 'isoWeek':
    case 'isoWeekYear':
    case 'hasTime':
      return { result: dateField(name, x!) };
    case 'toCivil': {
      if (x!.kind !== 'instant') {
        throw wrongKind('instant', x!);
      }
      const offset = offsetOf(name, y!);
      return {
        result: inRangeDate(() => civilOf(civilOfNs(x!.asInstant()! + offset))),
      };
    }
    case 'toInstant': {
      const c = x!.civilRef();
      if (!c) {
        throw wrongKind('civil date', x!);
      }
      if (c.ns === null) {
        throw outOfDomain(name, x!);
      }
      const offset = offsetOf(name, y!);
      return {
        result: inRangeDate(() => instantOf(checkInstant(civilNs(c) - offset))),
      };
    }
    case 'abs':
    case 'floor':
    case 'ceiling':
    case 'truncate': {
      const d = magnitudeOperand(x!);
      if (name === 'abs') {
        return { result: sameUnit(x!, { ...d, negative: false }) };
      }
      const mode =
        name === 'floor' ? 'floor' : name === 'ceiling' ? 'ceiling' : 'down';
      return { result: sameUnit(x!, roundTo(d, 0, mode)) };
    }
    case 'sqrt':
    case 'exp':
    case 'ln':
    case 'log10':
    case 'power':
    case 'sin':
    case 'cos':
    case 'tan':
    case 'asin':
    case 'acos':
    case 'atan':
    case 'atan2':
      return { result: numberFunction(name, args) };
    case 'fromFloat64':
    case 'fromFloat32':
      return { result: fromFloat(name, x!, y!) };
    case 'toFloat64':
    case 'toFloat32':
      return { result: toFloat(name, x!, y!) };
    case 'round': {
      const d = magnitudeOperand(x!);
      const places = numberOperand(y!);
      if (!isInteger(places) || places.negative) {
        throw outOfDomain(name, y!);
      }
      if (z!.kind !== 'text') {
        throw wrongKind('text', z!);
      }
      if (!roundModes.has(textOf(z!))) {
        throw outOfDomain(name, z!);
      }
      const rounded = roundTo(d, Number(integerOf(places)), textOf(z!));
      if (rounded.coefficient >= 10n ** 34n) {
        throw new ScriptError('overflow', [['operator', text(name)]]);
      }
      return { result: sameUnit(x!, rounded) };
    }
  }
  throw new NotImplementedError(`the Built-in ${name}`);
};
/** A Built-in's defaults, from stdlib.toml's call notation. */
export const builtinDefaults: Record<string, Value[]> = {
  round: [num(0), text('half up')],
  fromFloat64: [text('big')],
  fromFloat32: [text('big')],
  toFloat64: [text('big')],
  toFloat32: [text('big')],
};
