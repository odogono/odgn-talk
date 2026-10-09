// Cost Model 0 (chapter 8, The Cost Model): each rate's Fuel and allocation
// formulas, the logical sizes of values, and the measures they're taken over.
import { costModel } from './generated/machine';
import { characters } from './text';
import { integerOf, isInteger, parseDec } from './decimal';
import type { Value } from './values';

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
type Term = {
  divide: number;
  measure: string | null;
  subject: string | null;
  times: number;
};
type Formula = readonly Term[];

/** A formula: whole numbers and measures, each optionally `n *` and `/ d`. */
const parse = (formula: string): Formula =>
  formula.split('+').map(raw => {
    const text = raw.trim();
    if (/^\d+$/.test(text)) {
      return { times: Number(text), measure: null, subject: null, divide: 1 };
    }
    const m =
      /^(?:(\d+) \* )?([a-z][\da-z]*)(?:\(([\da-z]+)\))?(?: \/ (\d+))?$/.exec(
        text,
      );
    if (!m) {
      throw new Error(`Unreadable Cost Model term: ${text}`);
    }
    return {
      times: m[1] ? Number(m[1]) : 1,
      measure: m[2]!,
      subject: m[3] ?? null,
      divide: m[4] ? Number(m[4]) : 1,
    };
  });

const rates = new Map(
  Object.entries(costModel.rates).map(([key, { fuel, alloc }]) => [
    key,
    { fuel: parse(fuel), alloc: parse(alloc) },
  ]),
);
const sizes = new Map(
  Object.entries(costModel.sizes).map(([of, size]) => [of, parse(size)]),
);

const encoder = new TextEncoder();
const known = new WeakMap<Value, number>();
const knownContents = new WeakMap<Value, number>();

/** The measures of one value that aren't sizes. */
const measureOf = (measure: string, v: Value | undefined): number => {
  if (!v) {
    return 0;
  }
  switch (measure) {
    case 'size':
      return sizeOf(v);
    case 'contents':
      return contentsOf(v);
    case 'characters':
      return v.kind === 'text' ? characters(v.asText()!).length : 0;
    case 'scalars':
      return v.kind === 'text' ? Array.from(v.asText()!).length : 0;
    case 'utf8':
      return v.kind === 'text' ? encoder.encode(v.asText()!).length : 0;
    case 'items':
      return itemsOf(v);
    case 'entries':
      return v.kind === 'map' ? v.entries().length : 0;
    case 'digits': {
      // A number's, or a Quantity's number's.
      const n = v.asDecimal() ?? v.asQuantityRef()?.number;
      return n
        ? Math.max(1, parseDec(n.toString()).coefficient.toString().length)
        : 0;
    }
    case 'program':
      return v.kind === 'pattern' ? v.asPattern()!.program : 0;
    case 'bytes':
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
    const a = parseDec(from.asDecimal()!.toString());
    const b = parseDec(to.asDecimal()!.toString());
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
  subject: (name: string) => Value | undefined,
  counts: Measured,
): number => {
  let total = 0;
  for (const term of formula) {
    let m = 1;
    if (
      term.measure === 'size' &&
      term.subject === 'result' &&
      counts.resultSize !== undefined
    ) {
      m = counts.resultSize;
    } else if (
      term.measure === 'size' &&
      term.subject === 'input' &&
      counts.inputSize !== undefined
    ) {
      m = counts.inputSize;
    } else if (term.measure) {
      m = term.subject
        ? measureOf(term.measure, subject(term.subject))
        : ((counts as Record<string, number | undefined>)[term.measure] ?? 0);
    }
    total += Math.ceil((term.times * m) / term.divide);
  }
  return total;
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
    case 'map':
      return v
        .entries()
        .reduce(
          (total, [k, value]) =>
            total + 16 + encoder.encode(k).length + sizeOf(value),
          0,
        );
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
    known.set(
      value,
      evaluate(formula, name => (name === 'v' ? value : undefined), {}),
    );
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
      term.measure === null ? 1 : term.measure === 'items' ? items : contents;
    total += Math.ceil((term.times * m) / term.divide);
  }
  return total;
};

export type Charge = { alloc: number; fuel: number };
/** A rate's Fuel and allocation, over what the instruction worked on. */
export const charge = (key: string, measured: Measured = {}): Charge => {
  const rate = rates.get(key);
  if (!rate) {
    throw new Error(`No Cost Model rate ${key}`);
  }
  const subject = (name: string): Value | undefined =>
    name === 'input'
      ? measured.input
      : name === 'result'
        ? measured.result
        : /^x\d+$/.test(name)
          ? measured.x?.[Number(name.slice(1)) - 1]
          : undefined;
  return {
    fuel: evaluate(rate.fuel, subject, measured),
    alloc: evaluate(rate.alloc, subject, measured),
  };
};
export const hasRate = (key: string) => rates.has(key);
