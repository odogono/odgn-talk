// Spec chapter 1; Unicode 18 UAX #15 / UAX #29 revision 49.
// No platform normalization, segmentation, case mapping or Unicode regexes.
import {
  combining,
  category,
  whitespace,
  decomposition,
  composition,
  grapheme,
  indic as tables_indic,
  pictographic,
  folding,
  uppercase,
  caseIgnorable,
  cased,
  finalSigma,
  lowercase,
} from './generated/unicode';
import { invalidValue } from './errors';

type Ranges<T> = readonly (readonly [number, number, T])[];
const lookup = <T>(ranges: Ranges<T>, cp: number, fallback: T): T => {
  let lo = 0,
    hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [start, end, value] = ranges[mid]!;
    if (cp < start) {
      hi = mid - 1;
    } else if (cp > end) {
      lo = mid + 1;
    } else {
      return value;
    }
  }
  return fallback;
};

export const assertScalarText = (s: string): void => {
  if (typeof s !== 'string') {
    invalidValue('Text must be a string');
  }
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp >= 0xd8_00 && cp <= 0xdb_ff) {
      const next = s.charCodeAt(++i);
      if (!(next >= 0xdc_00 && next <= 0xdf_ff)) {
        invalidValue('Text contains a lone surrogate');
      }
    } else if (cp >= 0xdc_00 && cp <= 0xdf_ff) {
      invalidValue('Text contains a lone surrogate');
    }
  }
};

const combiningClass = (cp: number) => lookup(combining, cp, 0);
export const generalCategory = (cp: number) => lookup(category, cp, 'Cn');
export const isWhiteSpace = (cp: number) => lookup(whitespace, cp, 0) === 1;
const fromPoints = (cps: readonly number[]) =>
  cps.map(cp => String.fromCodePoint(cp)).join('');

// Hangul canonical decomposition/composition is algorithmic (UAX #15 §3.12).
const SBASE = 0xac_00,
  LBASE = 0x11_00,
  VBASE = 0x11_61,
  TBASE = 0x11_a7;
const LCOUNT = 19,
  VCOUNT = 21,
  TCOUNT = 28,
  NCOUNT = VCOUNT * TCOUNT,
  SCOUNT = LCOUNT * NCOUNT;
const decompose = (cp: number, output: number[]): void => {
  const index = cp - SBASE;
  if (index >= 0 && index < SCOUNT) {
    output.push(
      LBASE + Math.floor(index / NCOUNT),
      VBASE + Math.floor((index % NCOUNT) / TCOUNT),
    );
    if (index % TCOUNT) {
      output.push(TBASE + (index % TCOUNT));
    }
  } else {
    const parts = decomposition[cp];
    if (parts) {
      for (const part of parts) {
        decompose(part, output);
      }
    } else {
      output.push(cp);
    }
  }
};

const compose = (a: number, b: number): number | undefined => {
  if (a >= LBASE && a < LBASE + LCOUNT && b >= VBASE && b < VBASE + VCOUNT) {
    return SBASE + ((a - LBASE) * VCOUNT + b - VBASE) * TCOUNT;
  }
  const index = a - SBASE;
  if (
    index >= 0 &&
    index < SCOUNT &&
    index % TCOUNT === 0 &&
    b > TBASE &&
    b < TBASE + TCOUNT
  ) {
    return a + b - TBASE;
  }
  return composition[a * 0x11_00_00 + b];
};

// Below U+0300 nothing has a non-zero combining class, decomposes away under
// NFC or composes with what follows, so such text is already in NFC.
const belowCombining = /^[^\u0300-\uFFFF]*$/;

export const normalizeNFC = (s: string): string => {
  if (typeof s === 'string' && belowCombining.test(s)) {
    return s;
  }
  assertScalarText(s);
  const decomposed: number[] = [];
  for (const ch of s) {
    decompose(ch.codePointAt(0)!, decomposed);
  }
  // Stable sorting of each combining run avoids quadratic insertion sorting.
  const ordered: number[] = [];
  let marks: { ccc: number; cp: number }[] = [];
  const flush = () => {
    marks.sort((a, b) => a.ccc - b.ccc);
    for (const mark of marks) {
      ordered.push(mark.cp);
    }
    marks = [];
  };
  for (const cp of decomposed) {
    const ccc = combiningClass(cp);
    if (ccc === 0) {
      flush();
      ordered.push(cp);
    } else {
      marks.push({ cp, ccc });
    }
  }
  flush();
  const result: number[] = [];
  let starter = -1,
    previousClass = 0;
  for (const cp of ordered) {
    const ccc = combiningClass(cp);
    const combined =
      starter >= 0 && (previousClass === 0 || previousClass < ccc)
        ? compose(result[starter]!, cp)
        : undefined;
    if (combined !== undefined) {
      result[starter] = combined;
    } else {
      if (ccc === 0) {
        starter = result.length;
      }
      result.push(cp);
      previousClass = ccc;
    }
  }
  return fromPoints(result);
};

const control = (p: string) => p === 'Control' || p === 'CR' || p === 'LF';

/** UTF-16 offsets for slicing storage, including both ends; positions count the intervals. */
export const characterBoundaries = (s: string): number[] => {
  assertScalarText(s);
  const boundaries = [0];
  let offset = 0,
    previous = '',
    regionalCount = 0;
  let linker = false,
    pictographicExtend = false,
    pictographicZWJ = false;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const current = lookup(grapheme, cp, 'Other');
    const indic = lookup(tables_indic, cp, 'None');
    const pic = lookup(pictographic, cp, 0) === 1;
    let breaks = true;
    if (previous === 'CR' && current === 'LF') {
      breaks = false;
    } // GB3
    else if (control(previous) || control(current)) {
      breaks = true;
    } // GB4/5
    else if (previous === 'L' && ['L', 'V', 'LV', 'LVT'].includes(current)) {
      breaks = false;
    } // GB6
    else if (['LV', 'V'].includes(previous) && ['V', 'T'].includes(current)) {
      breaks = false;
    } // GB7
    else if (['LVT', 'T'].includes(previous) && current === 'T') {
      breaks = false;
    } // GB8
    else if (
      ['Extend', 'ZWJ', 'SpacingMark'].includes(current) ||
      previous === 'Prepend'
    ) {
      breaks = false;
    } // GB9/9a/9b
    else if (linker && indic === 'Consonant') {
      breaks = false;
    } // Unicode 18 GB9c: Linker Extend* × Consonant
    else if (pictographicZWJ && pic) {
      breaks = false;
    } // GB11
    else if (
      previous === 'Regional_Indicator' &&
      current === 'Regional_Indicator' &&
      regionalCount % 2 === 1
    ) {
      breaks = false;
    } // GB12/13
    if (offset > 0 && breaks) {
      boundaries.push(offset);
    }
    linker = indic === 'Linker' || (indic === 'Extend' && linker);
    pictographicZWJ = current === 'ZWJ' && pictographicExtend;
    pictographicExtend = pic || (current === 'Extend' && pictographicExtend);
    regionalCount = current === 'Regional_Indicator' ? regionalCount + 1 : 0;
    previous = current;
    offset += ch.length;
  }
  if (offset > 0) {
    boundaries.push(offset);
  }
  return boundaries;
};

// Simple folding is not full mapping and does not re-normalize the comparison form.
export const simpleFold = (s: string): string => {
  assertScalarText(s);
  return Array.from(s, ch =>
    String.fromCodePoint(folding[ch.codePointAt(0)!] ?? ch.codePointAt(0)!),
  ).join('');
};

export const upper = (s: string): string => {
  assertScalarText(s);
  return normalizeNFC(
    Array.from(s, ch =>
      fromPoints(uppercase[ch.codePointAt(0)!] ?? [ch.codePointAt(0)!]),
    ).join(''),
  );
};

export const lower = (s: string): string => {
  assertScalarText(s);
  const cps = Array.from(s, ch => ch.codePointAt(0)!);
  // Case-ignorable context is skipped in the original text, in linear passes.
  const afterCased: boolean[] = [];
  let context = false;
  for (let i = cps.length - 1; i >= 0; i--) {
    afterCased[i] = context;
    if (!lookup(caseIgnorable, cps[i]!, 0)) {
      context = Boolean(lookup(cased, cps[i]!, 0));
    }
  }
  context = false;
  const output: string[] = [];
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!;
    const sigma = context && !afterCased[i] ? finalSigma[cp] : undefined;
    output.push(fromPoints(sigma ?? lowercase[cp] ?? [cp]));
    if (!lookup(caseIgnorable, cp, 0)) {
      context = Boolean(lookup(cased, cp, 0));
    }
  }
  return normalizeNFC(output.join(''));
};
