// The display forms of the constants a code unit's pool holds (chapter 11, In
// a disassembly): numbers and Quantities in canonical text, text in NFC, and
// Text Patterns as their canonical source, with splices numbered `(1)`, ….
import { unitKinds, units } from './generated/syntax';
import { runTask, type Task } from './tasks';
import { normalizeNFC } from './unicode';
import { displayText, literalDigits } from './values';
import type { Expr, PatternElement, TextPattern } from './view';

/** The canonical text of a number literal, negated if asked. */
export const numberText = (literal: string, negative = false): string => {
  const digits = literalDigits(literal);
  if (!digits) {
    throw new Error(`number literal ${literal} is past the value limits`);
  }
  const { whole, fraction } = digits;
  const zero = !/[1-9]/.test(whole + fraction);
  return `${negative && !zero ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
};

/** A text value's display form, after the NFC every text value has. */
export const textDisplay = (value: string): string =>
  displayText(normalizeNFC(value));

/** A Unit literal whose value chapter 3 doesn't settle. */
export class UnitError extends Error {
  override name = 'UnitError';
}

type UnitEntry = { kind: string; name: string; plural?: string };
const unitByName = new Map<string, UnitEntry>();
for (const unit of units as readonly UnitEntry[]) {
  unitByName.set(unit.name, unit);
  if (unit.plural) {
    unitByName.set(unit.plural, unit);
  }
}

/**
 * A Quantity literal's display form: its number, then its Unit in normal form
 * (chapter 3, Compound Units and Printing Quantities). A Unit whose slots all
 * drop leaves a plain number.
 */
export const quantityText = (number: string, unit: string): string => {
  const slots = new Map<string, { exponent: number; unit: UnitEntry }>();
  const body = unit.startsWith('1/') ? unit.slice(2) : unit;
  let sign = unit.startsWith('1/') ? -1 : 1;
  for (const [i, part] of body.split(/([*/])/).entries()) {
    if (i % 2) {
      if (part === '/') {
        sign = -1;
      }
      continue;
    }
    const [name, power] = part.split('^');
    const entry = unitByName.get(name!);
    if (!entry) {
      throw new Error(`${name} is not a Unit`);
    }
    const exponent = sign * (power ? Number(power) : 1);
    const slot = slots.get(entry.kind);
    if (slot && slot.unit !== entry) {
      // Chapter 3 gives a Unit one Unit per slot, and leaves a literal that
      // names two (such as `m*ft`) unsettled.
      throw new UnitError(`the Unit ${unit} names two Units of one Unit Kind`);
    }
    slots.set(entry.kind, {
      unit: entry,
      exponent: (slot?.exponent ?? 0) + exponent,
    });
  }
  const ordered = unitKinds.flatMap(kind => {
    const slot = slots.get(kind);
    return slot && slot.exponent ? [slot] : [];
  });
  if (!ordered.length) {
    return number;
  }
  const factor = ({ unit, exponent }: { exponent: number; unit: UnitEntry }) =>
    Math.abs(exponent) === 1 ? unit.name : `${unit.name}^${Math.abs(exponent)}`;
  const top = ordered.filter(slot => slot.exponent > 0);
  const bottom = ordered.filter(slot => slot.exponent < 0);
  if (top.length === 1 && !bottom.length && top[0]!.exponent === 1) {
    // A word Unit standing alone is plural unless the magnitude is exactly 1.
    const { name, plural } = top[0]!.unit;
    const one = /^-?1(?:\.0+)?$/.test(number);
    return `${number} ${plural && !one ? plural : name}`;
  }
  const text =
    (top.length ? top.map(factor).join('*') : '1') +
    (bottom.length ? `/${bottom.map(factor).join('*')}` : '');
  return `${number} ${text}`;
};

/** A Text Pattern's splices, in source order: each one's expression. */
export const splicesOf = (pattern: TextPattern): Expr[] => {
  const out: Expr[] = [];
  const work: PatternElement[] = [...pattern.els].reverse();
  while (work.length) {
    const e = work.pop()!;
    switch (e.k) {
      case 'splice':
        out.push(e.e);
        break;
      case 'group':
        work.push(...[...e.els].reverse());
        break;
      case 'alternation':
        work.push(...[...e.options].reverse());
        break;
      case 'count':
      case 'capture':
      case 'repeat':
      case 'suffixed':
        work.push(e.e);
        break;
    }
  }
  return out;
};

/** The names a Text Pattern's Captures bind, in order, splices excluded. */
export const capturesOf = (pattern: TextPattern) => {
  const out: Extract<PatternElement, { k: 'capture' }>['name'][] = [];
  const work: PatternElement[] = [...pattern.els].reverse();
  while (work.length) {
    const e = work.pop()!;
    switch (e.k) {
      case 'capture':
        out.push(e.name);
        work.push(e.e);
        break;
      case 'group':
        work.push(...[...e.els].reverse());
        break;
      case 'alternation':
        work.push(...[...e.options].reverse());
        break;
      case 'count':
      case 'repeat':
      case 'suffixed':
        work.push(e.e);
        break;
    }
  }
  return out;
};

/**
 * A Text Pattern's canonical source (chapter 11), with each splice written
 * `(n)` by its position, as a template constant shows it.
 */
export const patternSource = (pattern: TextPattern): string => {
  let splice = 0;
  // A nested `<>` is left out, since it matches only where the rest would.
  const empty = (e: PatternElement): boolean =>
    e.k === 'group' && e.els.every(empty);
  const list = function* (els: readonly PatternElement[]): Task<string> {
    const parts: string[] = [];
    for (const e of els) {
      if (!empty(e)) {
        parts.push((yield element(e)) as string);
      }
    }
    // No canonical source starts with `<<`, which starts Bytes.
    return `<${parts[0]?.startsWith('<') ? ' ' : ''}${parts.join(', ')}>`;
  };
  const element = function* (e: PatternElement): Task<string> {
    switch (e.k) {
      case 'text': {
        const display = textDisplay(e.value);
        return /^"[^"]*"$/.test(display) ? display : `(${display})`;
      }
      case 'count':
        return `${numberText(e.n)} ${(yield element(e.e)) as string}`;
      case 'group':
        return (yield list(e.els)) as string;
      case 'splice':
        return `(${++splice})`;
      case 'capture':
        return `${e.name.text}: ${(yield element(e.e)) as string}`;
      case 'words':
        return e.words;
      case 'typed':
        return `a ${e.kind}`;
      case 'repeat':
        return `${e.phrase} ${(yield element(e.e)) as string}`;
      case 'alternation': {
        const options: string[] = [];
        for (const option of e.options) {
          options.push((yield element(option)) as string);
        }
        return options.join(' or ');
      }
      case 'suffixed':
        return (
          ((yield element(e.e)) as string) +
          (e.as ? ` as ${e.as}` : '') +
          (e.fold ? ' ignoring case' : '') +
          (e.lazily ? ' lazily' : '')
        );
    }
  };
  return runTask(list(pattern.els));
};
