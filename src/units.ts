// Units (chapter 3, Quantities): a Unit is one Unit per Unit Kind, each
// with a non-zero exponent, kept in Kind order. Values convert through Base
// Units, multiplying and dividing by each factor in turn, every step rounded.
import { divide, multiply, parseDec, type Dec } from './decimal';
import { unitKindTable, unitKinds, units } from './generated/syntax';

/** One slot of a Unit: a Unit of a Unit Kind, and its exponent. */
export type Slot = { readonly exponent: number; readonly unit: string };
/** A Unit's slots in Kind order. An empty Unit is a plain number. */
export type UnitSpec = readonly Slot[];

/** A Unit that can't be written, or a combination chapter 3 refuses. */
export class UnitError extends Error {
  override name = 'UnitError';
}

type Entry = {
  calendar: boolean;
  factor: readonly [Dec, Dec];
  kind: string;
  name: string;
  plural?: string;
};
const entries = new Map<string, Entry>();
for (const u of units) {
  const entry: Entry = {
    name: u.name,
    kind: u.kind,
    calendar: u.calendar,
    factor: [parseDec(u.factor[0]!), parseDec(u.factor[1]!)],
    ...('plural' in u && u.plural ? { plural: u.plural } : {}),
  };
  entries.set(u.name, entry);
  if (entry.plural) {
    entries.set(entry.plural, entry);
  }
}
const kindOrder = new Map(unitKinds.map((k, i) => [k, i]));
const kinds = new Map(
  unitKindTable.map(k => [
    k.name,
    { dimension: k.dimension, factor: parseDec(k.factor) },
  ]),
);
export const unitEntry = (name: string): Entry | undefined => entries.get(name);
const entryOf = (slot: Slot) => entries.get(slot.unit)!;

/**
 * Read a Unit as source spells it (chapter 1, Units): factors joined by `*`,
 * at most one `/`, exponents after `^`, and a leading `1/` for a Unit with
 * only a denominator. A Unit has one Unit in each slot, so a Unit Kind's
 * factors name one Unit, and their exponents add (`m*m` is `m^2`).
 */
export const parseUnit = (text: string): UnitSpec => {
  const body = text.startsWith('1/') ? text.slice(2) : text;
  let sign = text.startsWith('1/') ? -1 : 1;
  const slots: Slot[] = [];
  let calendar = false;
  const parts = body.split(/([*/])/);
  let slashes = sign < 0 ? 1 : 0;
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i - 1] === '/') {
      sign = -1;
      slashes++;
    }
    const [name, power] = parts[i]!.split('^');
    const entry = entries.get(name!);
    if (!entry) {
      throw new UnitError(`\`${name}\` is not a Unit`);
    }
    if (power !== undefined && !/^[1-9]\d*$/.test(power)) {
      throw new UnitError('an exponent must be a positive integer');
    }
    const exponent = sign * (power ? Number(power) : 1);
    const slot = slots.find(s => entryOf(s).kind === entry.kind);
    if (slot && slot.unit !== entry.name) {
      throw new UnitError(
        `\`${slot.unit}\` and \`${entry.name}\` are two Units of the Unit Kind ${entry.kind}`,
      );
    }
    if (slot) {
      (slot as { exponent: number }).exponent += exponent;
    } else {
      slots.push({ unit: entry.name, exponent });
    }
    calendar ||=
      entry.calendar && (parts.length > 1 || power !== undefined || sign < 0);
  }
  if (slashes > 1) {
    throw new UnitError('a Compound Unit has at most one `/`');
  }
  if (calendar) {
    throw new UnitError("a Calendar Unit can't be part of a Compound Unit");
  }
  return ordered(slots);
};

const ordered = (slots: Slot[]): UnitSpec =>
  slots
    .filter(slot => slot.exponent !== 0)
    .sort(
      (a, b) =>
        kindOrder.get(entryOf(a).kind)! - kindOrder.get(entryOf(b).kind)!,
    );

const factor = (slot: Slot) =>
  Math.abs(slot.exponent) === 1
    ? slot.unit
    : `${slot.unit}^${Math.abs(slot.exponent)}`;

/**
 * A Unit in normal form (chapter 3): numerator factors, then `/` and the
 * denominator's, each in Kind order. A word Unit standing alone is plural
 * unless the magnitude is exactly 1, when `number` is given.
 */
export const unitText = (spec: UnitSpec, number?: string): string => {
  const top = spec.filter(slot => slot.exponent > 0);
  const bottom = spec.filter(slot => slot.exponent < 0);
  if (
    number !== undefined &&
    top.length === 1 &&
    !bottom.length &&
    top[0]!.exponent === 1
  ) {
    const entry = entryOf(top[0]!);
    const one = /^-?1(?:\.0+)?$/.test(number);
    return entry.plural && !one ? entry.plural : entry.name;
  }
  return (
    (top.length ? top.map(factor).join('*') : '1') +
    (bottom.length ? `/${bottom.map(factor).join('*')}` : '')
  );
};

/** A Unit's dimension: each base dimension's exponent, Calendar Units apart. */
const dimension = (spec: UnitSpec): string => {
  const total = new Map<string, number>();
  for (const slot of spec) {
    for (const part of kinds.get(entryOf(slot).kind)!.dimension.split('*')) {
      const [base, power] = part.split('^');
      total.set(
        base!,
        (total.get(base!) ?? 0) + slot.exponent * (power ? Number(power) : 1),
      );
    }
  }
  return [...total]
    .filter(([, exponent]) => exponent !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([base, exponent]) => `${base}^${exponent}`)
    .join('*');
};
export const sameDimension = (a: UnitSpec, b: UnitSpec): boolean =>
  dimension(a) === dimension(b);

// A Unit's factors (chapter 3, Converting): for each slot in Kind order, as
// many times as its exponent, its Unit's factor and its Kind's, a ratio's
// numerator and denominator on the slot's side and the other.
const factorsOf = (spec: UnitSpec) => {
  const top: Dec[] = [];
  const bottom: Dec[] = [];
  const one = (d: Dec) => d.coefficient === 1n && d.exponent === 0;
  for (const slot of spec) {
    const entry = entryOf(slot);
    const kindFactor = kinds.get(entry.kind)!.factor;
    const [n, d] = entry.factor;
    const [same, other] = slot.exponent > 0 ? [top, bottom] : [bottom, top];
    for (let i = 0; i < Math.abs(slot.exponent); i++) {
      same.push(n);
      if (!one(d)) {
        other.push(d);
      }
      if (!one(kindFactor)) {
        same.push(kindFactor);
      }
    }
  }
  return { top, bottom };
};

/** A value in the Unit, into Base Units: times each numerator factor, then over each denominator one. */
export const toBase = (value: Dec, spec: UnitSpec): Dec => {
  const { top, bottom } = factorsOf(spec);
  let v = value;
  for (const f of top) {
    v = multiply(v, f);
  }
  for (const f of bottom) {
    v = divide(v, f);
  }
  return v;
};

/** A value in Base Units, into the Unit: times each denominator factor, then over each numerator one. */
export const fromBase = (value: Dec, spec: UnitSpec): Dec => {
  const { top, bottom } = factorsOf(spec);
  let v = value;
  for (const f of bottom) {
    v = multiply(v, f);
  }
  for (const f of top) {
    v = divide(v, f);
  }
  return v;
};

const checkCalendar = (spec: UnitSpec) => {
  const calendar = spec.find(slot => entryOf(slot).calendar);
  if (calendar && (spec.length > 1 || calendar.exponent !== 1)) {
    throw new UnitError('a Calendar Unit stands alone');
  }
  return spec;
};

/**
 * The Unit of `a * b` or `a / b` (chapter 3, Quantity arithmetic): the left
 * operand's, with each of the right operand's slots converted into the
 * left's Unit for that slot, its exponents added, or kept when the left has
 * none.
 */
export const combine = (
  a: UnitSpec,
  b: UnitSpec,
  op: 'multiply' | 'divide',
): UnitSpec => {
  const slots = a.map(slot => ({ ...slot }));
  for (const slot of b) {
    const exponent = op === 'multiply' ? slot.exponent : -slot.exponent;
    const kind = entryOf(slot).kind;
    const left = slots.find(s => entryOf(s).kind === kind);
    if (left) {
      (left as { exponent: number }).exponent += exponent;
    } else {
      slots.push({ unit: slot.unit, exponent });
    }
  }
  return checkCalendar(ordered(slots));
};

/** The Unit of `q ^ n`: each exponent times `n`. */
export const powerOf = (spec: UnitSpec, n: number): UnitSpec =>
  checkCalendar(
    spec.map(slot => ({ unit: slot.unit, exponent: slot.exponent * n })),
  );
