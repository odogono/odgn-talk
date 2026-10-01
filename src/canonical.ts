// The display forms of the constants a code unit's pool holds (chapter 11, In
// a disassembly): numbers and Quantities in canonical text, text in NFC, and
// Text Patterns as their canonical source, with splices numbered `(1)`, ….
import { runTask, type Task } from './tasks';
import { normalizeNFC } from './unicode';
import { parseUnit, unitText } from './units';
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

/**
 * A Quantity literal's display form: its number, then its Unit in normal form
 * (chapter 3, Compound Units and Printing Quantities). The lexer has checked
 * the Unit. A Unit whose slots all drop leaves a plain number.
 */
export const quantityText = (number: string, unit: string): string => {
  const spec = parseUnit(unit);
  return spec.length ? `${number} ${unitText(spec, number)}` : number;
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
