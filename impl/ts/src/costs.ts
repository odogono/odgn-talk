// Cost Model 0 (chapter 8, The Cost Model): each rate's Fuel and allocation
// formulas, the logical sizes of values, and the measures they're taken over.
import { costMeasure, costModel, costSubject } from './generated/machine';
import { characters } from './text';
import { scalarCount } from './unicode';
import { digitsOf, integerOf, isInteger } from './decimal';
import { decimalParts, type Value } from './values';

/** What one charge measures: its subjects and the instruction's own counts. */
export type Measured = {
  count?: number;
  declared?: number;
  frames?: number;
  input?: Value;
  /** The logical size of an internal input, such as a message. */
  inputSize?: number;
  result?: Value;
  /** The logical size of an internal value the instruction pushes. */
  resultSize?: number;
  scanned?: number;
  steps?: number;
  /** A Built-in's arguments, x1, x2, …, defaults included. */
  x?: readonly Value[];
};
/** A compiled term: `[measure, subject, factor, divisor]`, by code. */
type Formula = readonly (readonly number[])[];

const rates: readonly { alloc: Formula; fuel: Formula; key: string }[] =
  costModel.rates;
const rateIndex = new Map(rates.map(({ key }, i) => [key, i]));
const sizes = new Map<string, Formula>(Object.entries(costModel.sizes));
const {
  constant: CONSTANT,
  size: SIZE,
  contents: CONTENTS,
  characters: CHARACTERS,
  scalars: SCALARS,
  utf8: UTF8,
  bytes: BYTES,
  items: ITEMS,
  entries: ENTRIES,
  digits: DIGITS,
  scanned: SCANNED,
  steps: STEPS,
  program: PROGRAM,
  frames: FRAMES,
  count: COUNT,
  declared: DECLARED,
} = costMeasure;
const { none: NONE, input: INPUT, result: RESULT, v: V, x1: X1 } = costSubject;
const noCounts: Measured = {};

const encoder = new TextEncoder();
const known = new WeakMap<Value, number>();
const knownContents = new WeakMap<Value, number>();

/** The measures of one value that aren't sizes. */
const measureOf = (measure: number, v: Value | undefined): number => {
  if (!v) {
    return 0;
  }
  switch (measure) {
    case SIZE:
      return sizeOf(v);
    case CONTENTS:
      return contentsOf(v);
    case CHARACTERS:
      return v.kind === 'text' ? characters(v.asText()!).length : 0;
    case SCALARS:
      return v.kind === 'text' ? scalarCount(v.asText()!) : 0;
    case UTF8:
      return v.kind === 'text' ? encoder.encode(v.asText()!).length : 0;
    case ITEMS:
      return itemsOf(v);
    case ENTRIES:
      return v.kind === 'map' ? v.mapSize : 0;
    case DIGITS: {
      // A number's, or a Quantity's number's.
      const n = v.asDecimal() ?? v.asQuantityRef()?.number;
      return n ? digitsOf(decimalParts(n)) : 0;
    }
    case PROGRAM:
      return v.kind === 'pattern' ? v.asPattern()!.program : 0;
    case BYTES:
      return v.bytesView()?.length ?? 0;
  }
  throw new Error(`Unknown measure ${measure}`);
};

/** A list's items, or an integer range's integers. */
export const itemsOf = (v: Value): number => {
  if (v.kind === 'list') {
    return v.length;
  }
  if (v.kind === 'range') {
    const { from, to } = v.asRange()!;
    if (from.kind !== 'number') {
      return 0;
    }
    const a = decimalParts(from.asDecimal()!);
    const b = decimalParts(to.asDecimal()!);
    if (!isInteger(a) || !isInteger(b)) {
      return 0;
    }
    const count = integerOf(b) - integerOf(a) + 1n;
    return count > 0n ? Number(count) : 0;
  }
  return 0;
};

const evaluate = (
  formula: Formula,
  counts: Measured,
  v: Value | undefined,
): number => {
  let total = 0;
  for (const term of formula) {
    const measure = term[0]!;
    const subject = term[1]!;
    let m = 1;
    if (measure === CONSTANT) {
      // A whole number's term is its factor.
    } else if (subject === NONE) {
      m = countOf(measure, counts);
    } else if (
      measure === SIZE &&
      subject === RESULT &&
      counts.resultSize !== undefined
    ) {
      m = counts.resultSize;
    } else if (
      measure === SIZE &&
      subject === INPUT &&
      counts.inputSize !== undefined
    ) {
      m = counts.inputSize;
    } else {
      m = measureOf(
        measure,
        subject === INPUT
          ? counts.input
          : subject === RESULT
            ? counts.result
            : subject === V
              ? v
              : counts.x?.[subject - X1],
      );
    }
    total += Math.ceil((term[2]! * m) / term[3]!);
  }
  return total;
};

/** A count the instruction measured itself, rather than a value's measure. */
const countOf = (measure: number, counts: Measured): number => {
  switch (measure) {
    case SCANNED:
      return counts.scanned ?? 0;
    case STEPS:
      return counts.steps ?? 0;
    case FRAMES:
      return counts.frames ?? 0;
    case COUNT:
      return counts.count ?? 0;
    case DECLARED:
      return counts.declared ?? 0;
  }
  return 0;
};

/** The sum of the logical sizes of the values a value holds. */
const contentsOf = (v: Value): number => {
  switch (v.kind) {
    case 'list': {
      const cached = knownContents.get(v);
      if (cached !== undefined) {
        return cached;
      }
      let total = 0;
      for (let i = 1; i <= v.length; i++) {
        total += sizeOf(v.index(i));
      }
      knownContents.set(v, total);
      return total;
    }
    case 'map': {
      const cached = knownContents.get(v);
      if (cached !== undefined) {
        return cached;
      }
      const total = v
        .mapPairs()!
        .reduce(
          (sum, [key, value]) =>
            sum + 16 + encoder.encode(key).length + sizeOf(value),
          0,
        );
      knownContents.set(v, total);
      return total;
    }
    case 'range': {
      const { from, to } = v.asRange()!;
      return sizeOf(from) + sizeOf(to);
    }
    case 'function':
      return v
        .asFunction()!
        .captures.reduce((total, [, value]) => total + sizeOf(value), 0);
  }
  return 0;
};

/** Seed a List's contents after growth, without walking its retained items. */
export const cacheListExtension = (
  result: Value,
  current: Value,
  part: Value,
  all: boolean,
): void => {
  const contents =
    contentsOf(current) + (all ? contentsOf(part) : sizeOf(part));
  knownContents.set(result, contents);
  known.set(result, partSize('list', result.length, contents));
};

/** Seed the logical sizes of point edits from their retained collection. */
export const cacheMapWrite = (
  result: Value,
  current: Value,
  key: string,
  part: Value | undefined,
): void => {
  if (result === current) {
    return;
  }
  const previous = current.hasKey(key)
    ? 16 + encoder.encode(key).length + sizeOf(current.get(key))
    : 0;
  const added =
    part === undefined ? 0 : 16 + encoder.encode(key).length + sizeOf(part);
  const contents = contentsOf(current) - previous + added;
  knownContents.set(result, contents);
  known.set(result, partSize('map', result.mapSize, contents));
};
export const cacheListEdit = (
  result: Value,
  current: Value,
  i: number,
  part: Value | undefined,
): void => {
  const contents =
    contentsOf(current) -
    sizeOf(current.index(i + 1)) +
    (part === undefined ? 0 : sizeOf(part));
  knownContents.set(result, contents);
  known.set(result, partSize('list', result.length, contents));
};

/** A value's logical size (chapter 8, Logical sizes), as if nothing were shared. */
export const sizeOf = (v: Value): number => {
  const cached = known.get(v);
  if (cached !== undefined) {
    return cached;
  }
  // Deep values are sized leaves first, so no size recurses far.
  const pending: Value[] = [v];
  const order: Value[] = [];
  while (pending.length) {
    const next = pending.pop()!;
    if (known.has(next)) {
      continue;
    }
    order.push(next);
    for (const child of childrenOf(next)) {
      if (!known.has(child)) {
        pending.push(child);
      }
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const value = order[i]!;
    const formula = sizes.get(value.kind)!;
    known.set(value, evaluate(formula, noCounts, value));
  }
  return known.get(v)!;
};
const childrenOf = (v: Value): Value[] => {
  switch (v.kind) {
    case 'list':
      return Array.from({ length: v.length }, (_, i) => v.index(i + 1));
    case 'map':
      return v.entries().map(([, value]) => value);
    case 'range': {
      const { from, to } = v.asRange()!;
      return [from, to];
    }
    case 'function':
      return v.asFunction()!.captures.map(([, value]) => value);
  }
  return [];
};

/** The logical size of a part of Persistent State, such as a frame. */
export const partSize = (
  of: string,
  items: number,
  contents: number,
): number => {
  const formula = sizes.get(of);
  if (!formula) {
    throw new Error(`No logical size for ${of}`);
  }
  let total = 0;
  for (const term of formula) {
    const m =
      term[0] === CONSTANT
        ? 1
        : term[0] === ITEMS || term[0] === ENTRIES
          ? items
          : contents;
    total += Math.ceil((term[2]! * m) / term[3]!);
  }
  return total;
};

export type Charge = { alloc: number; fuel: number };

/** A Cost Model key's rate, an index that `charge` takes, or -1 if none. */
export const rateOf = (key: string): number => rateIndex.get(key) ?? -1;

/** A rate's Fuel and allocation, over what the instruction worked on. */
export const charge = (rate: number, measured: Measured = noCounts): Charge => {
  const formulas = rates[rate];
  if (!formulas) {
    throw new Error(`No Cost Model rate ${rate}`);
  }
  return {
    fuel: evaluate(formulas.fuel, measured, undefined),
    alloc: evaluate(formulas.alloc, measured, undefined),
  };
};
