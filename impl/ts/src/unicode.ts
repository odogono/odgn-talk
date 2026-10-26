// Spec chapter 1; Unicode 18 UAX #15 / UAX #29 revision 49.
// No platform normalization, segmentation, case mapping or Unicode regexes.
import {
  caseIgnorable as packedCaseIgnorable,
  cased as packedCased,
  category as packedCategory,
  combining as packedCombining,
  compositionExclusions as packedCompositionExclusions,
  decomposition as packedDecomposition,
  finalSigma as packedFinalSigma,
  folding as packedFolding,
  grapheme as packedGrapheme,
  indic as packedIndic,
  lowercase as packedLowercase,
  pictographic as packedPictographic,
  uppercase as packedUppercase,
  whitespace as packedWhitespace,
} from './generated/unicode';
import { invalidValue } from './errors';

// The generator packs each table as unsigned varints of five bits per digit,
// least significant first, with 32 marking a following digit.
const unpack = (text: string): number[] => {
  const numbers: number[] = [];
  let value = 0,
    scale = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Digits are A-Z, a-z, 0-9, + and /.
    const digit =
      c >= 97
        ? c - 71
        : c >= 65
          ? c - 65
          : c >= 48
            ? c + 4
            : c === 43
              ? 62
              : 63;
    value += (digit & 31) * scale;
    if (digit & 32) {
      scale *= 32;
    } else {
      numbers.push(value);
      value = 0;
      scale = 1;
    }
  }
  return numbers;
};
const unzigzag = (n: number) => (n & 1 ? -(n + 1) / 2 : n / 2);

type Ranges<T> = {
  ends: Uint32Array;
  indexes: Uint8Array | undefined;
  starts: Uint32Array;
  values: readonly T[];
};
// Fields are packed column by column; see tools/unicode/generate.ts.
const ranges = <T>(text: string, values: readonly T[]): Ranges<T> => {
  const numbers = unpack(text);
  const count = numbers[0]!;
  const starts = new Uint32Array(count);
  const ends = new Uint32Array(count);
  const indexes = values.length > 1 ? new Uint8Array(count) : undefined;
  let previous = -1;
  for (let i = 0; i < count; i++) {
    starts[i] = previous + 1 + numbers[1 + i]!;
    previous = ends[i] = starts[i]! + numbers[1 + count + i]!;
    if (indexes) {
      indexes[i] = numbers[1 + 2 * count + i]!;
    }
  }
  return { ends, indexes, starts, values };
};
const set = (text: string) => ranges(text, [1]);

const lookup = <T>(table: Ranges<T>, cp: number, fallback: T): T => {
  const { starts, ends } = table;
  let lo = 0,
    hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (cp < starts[mid]!) {
      hi = mid - 1;
    } else if (cp > ends[mid]!) {
      lo = mid + 1;
    } else {
      return table.values[table.indexes ? table.indexes[mid]! : 0]!;
    }
  }
  return fallback;
};

const mapping = (text: string, lists: boolean): Map<number, number[]> => {
  const numbers = unpack(text);
  const [count, fromPrevious] = numbers as [number, number];
  const lengths = lists ? 2 + count : 0;
  const firsts = 2 + (lists ? 2 : 1) * count;
  let next = firsts + count;
  const result = new Map<number, number[]>();
  let key = -1,
    first = 0,
    other = 0;
  for (let i = 0; i < count; i++) {
    key += numbers[2 + i]! + 1;
    first = (fromPrevious ? first : key) + unzigzag(numbers[firsts + i]!);
    const values = [first];
    for (let n = lists ? numbers[lengths + i]! : 1; n > 1; n--) {
      other += unzigzag(numbers[next++]!);
      values.push(other);
    }
    result.set(key, values);
  }
  return result;
};

const category = ranges(...packedCategory);
const combining = ranges(...packedCombining);
const grapheme = ranges(...packedGrapheme);
const indicTable = ranges(...packedIndic);
const pictographic = set(packedPictographic);
const whitespace = set(packedWhitespace);
const cased = set(packedCased);
const caseIgnorable = set(packedCaseIgnorable);
const decomposition = mapping(packedDecomposition, true);
const folding = new Map(
  Array.from(mapping(packedFolding, false), ([cp, [folded]]) => [cp, folded!]),
);
const uppercase = mapping(packedUppercase, true);
const lowercase = mapping(packedLowercase, true);
const finalSigma = mapping(packedFinalSigma, true);
// Every two-part canonical decomposition composes unless it is excluded.
const composition = new Map<number, number>();
{
  const excluded = new Set<number>();
  let key = -1;
  for (const gap of unpack(packedCompositionExclusions)) {
    excluded.add((key += gap + 1));
  }
  for (const [cp, parts] of decomposition) {
    if (parts.length === 2 && !excluded.has(cp)) {
      composition.set(parts[0]! * 0x11_00_00 + parts[1]!, cp);
    }
  }
}

/** Decoded tables, for checking the packing against the generator. */
export const unicodeTables = {
  category,
  combining,
  grapheme,
  indic: indicTable,
  pictographic,
  whitespace,
  cased,
  caseIgnorable,
  decomposition,
  composition,
  folding,
  uppercase,
  lowercase,
  finalSigma,
};

const surrogate = /[\uD800-\uDFFF]/;
const surrogatePair = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

export const assertScalarText = (s: string): void => {
  if (typeof s !== 'string') {
    invalidValue('Text must be a string');
  }
  if (!surrogate.test(s)) {
    return;
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

/** Unicode scalar values in `s`, each lone surrogate counting as one. */
export const scalarCount = (s: string): number =>
  surrogate.test(s)
    ? s.length - (s.match(surrogatePair)?.length ?? 0)
    : s.length;

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
    const parts = decomposition.get(cp);
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
  return composition.get(a * 0x11_00_00 + b);
};

// Below U+0300 nothing has a non-zero combining class, decomposes away under
// NFC or composes with what follows, so such text is already in NFC.
const belowCombining = /^[^\u0300-\uFFFF]*$/;

// A starter which cannot compose backwards is an NFC boundary. Check the
// first scalar of its canonical decomposition, including Hangul V and T.
const backwardComposing = new Set(
  Array.from(composition.keys(), key => key % 0x11_00_00),
);
const nfcBoundaryBefore = (cp: number): boolean => {
  while (decomposition.has(cp)) {
    cp = decomposition.get(cp)![0]!;
  }
  return (
    combiningClass(cp) === 0 &&
    !backwardComposing.has(cp) &&
    !(cp >= VBASE && cp < VBASE + VCOUNT) &&
    !(cp > TBASE && cp < TBASE + TCOUNT)
  );
};
const utf8 = new TextEncoder();

/** Join two scalar NFC strings, normalizing only the affected seam. */
export const joinNFC = (
  left: string,
  right: string,
): { text: string; utf8Delta: number } => {
  if (
    !left.length ||
    !right.length ||
    nfcBoundaryBefore(right.codePointAt(0)!)
  ) {
    return { text: left + right, utf8Delta: 0 };
  }
  let from = left.length;
  // Include the last starter: its decomposition may expose a combining mark
  // which reorders with a leading mark on the right.
  while (from > 0) {
    from--;
    const unit = left.charCodeAt(from);
    if (unit >= 0xdc_00 && unit <= 0xdf_ff) {
      from--;
    }
    if (combiningClass(left.codePointAt(from)!) === 0) {
      break;
    }
  }
  let to = 0;
  while (to < right.length) {
    const cp = right.codePointAt(to)!;
    if (nfcBoundaryBefore(cp)) {
      break;
    }
    to += cp > 0xff_ff ? 2 : 1;
  }
  const seam = left.slice(from) + right.slice(0, to);
  const normalized = normalizeNFC(seam);
  return {
    text: left.slice(0, from) + normalized + right.slice(to),
    utf8Delta:
      normalized === seam
        ? 0
        : utf8.encode(normalized).length - utf8.encode(seam).length,
  };
};

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

/** End of the leading scalars whose grapheme state can depend on a join. */
export const characterJoinEnd = (s: string): number => {
  let end = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    end += ch.length;
    const current = lookup(grapheme, cp, 'Other');
    const indic = lookup(indicTable, cp, 'None');
    // After any other scalar every state variable in characterBoundaries is
    // independent of the left piece. Include its complete Character too.
    if (
      current !== 'Extend' &&
      current !== 'ZWJ' &&
      current !== 'Regional_Indicator' &&
      indic !== 'Extend'
    ) {
      break;
    }
  }
  return end;
};

// eslint-disable-next-line no-control-regex -- ASCII controls are ASCII too.
const asciiOnly = /^[\u0000-\u007f]*$/;
export const isASCII = (s: string): boolean => asciiOnly.test(s);

/** Slices `s` at Character boundaries from characterBoundaries. */
export const charactersAt = (
  s: string,
  boundaries: readonly number[],
): string[] => {
  const result = new Array<string>(boundaries.length - 1);
  for (let i = 0; i < result.length; i++) {
    result[i] = s.slice(boundaries[i], boundaries[i + 1]);
  }
  return result;
};

/** UTF-16 offsets for slicing storage, including both ends; positions count the intervals. */
export const characterBoundaries = (s: string): number[] => {
  assertScalarText(s);
  const boundaries = [0];
  // ASCII has no Extend, Prepend, Indic or emoji state. CRLF is its one
  // multi-scalar Character, including when surrounded by other controls.
  if (isASCII(s)) {
    for (let i = 1; i < s.length; i++) {
      if (s.charCodeAt(i - 1) !== 13 || s.charCodeAt(i) !== 10) {
        boundaries.push(i);
      }
    }
    if (s.length) {
      boundaries.push(s.length);
    }
    return boundaries;
  }
  let offset = 0,
    previous = '',
    regionalCount = 0;
  let linker = false,
    pictographicExtend = false,
    pictographicZWJ = false;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const current = lookup(grapheme, cp, 'Other');
    const indic = lookup(indicTable, cp, 'None');
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
    String.fromCodePoint(folding.get(ch.codePointAt(0)!) ?? ch.codePointAt(0)!),
  ).join('');
};

export const upper = (s: string): string => {
  assertScalarText(s);
  return normalizeNFC(
    Array.from(s, ch =>
      fromPoints(uppercase.get(ch.codePointAt(0)!) ?? [ch.codePointAt(0)!]),
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
    const sigma = context && !afterCased[i] ? finalSigma.get(cp) : undefined;
    output.push(fromPoints(sigma ?? lowercase.get(cp) ?? [cp]));
    if (!lookup(caseIgnorable, cp, 0)) {
      context = Boolean(lookup(cased, cp, 0));
    }
  }
  return normalizeNFC(output.join(''));
};
