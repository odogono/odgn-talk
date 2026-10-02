// Chapter 3's decimal arithmetic: each result is the exact result, rounded
// half-even once to 34 significant digits (or at exponent -6176), checked for
// overflow, then written with the exponent nearest the operator's ideal one.
// Every step is exact BigInt work, so both Cores agree bit for bit.

/** A number: (-1)^negative × coefficient × 10^exponent, exponent ≤ 0. */
export type Dec = { coefficient: bigint; exponent: number; negative: boolean };
export class ArithmeticError extends Error {
  constructor(readonly code: 'overflow' | 'division by zero') {
    super(code);
    this.name = 'ArithmeticError';
  }
}

const DIGITS = 34;
const MIN_EXPONENT = -6176;
const LIMIT = 10n ** BigInt(DIGITS);

export const parseDec = (canonical: string): Dec => {
  const negative = canonical.startsWith('-');
  const [whole, fraction = ''] = (
    negative ? canonical.slice(1) : canonical
  ).split('.');
  return {
    negative,
    coefficient: BigInt(whole! + fraction),
    exponent: -fraction.length,
  };
};

export const formatDec = ({ coefficient, exponent, negative }: Dec): string => {
  let digits = coefficient.toString();
  if (exponent < 0) {
    digits = digits.padStart(-exponent + 1, '0');
    digits = `${digits.slice(0, exponent)}.${digits.slice(exponent)}`;
  }
  return `${negative && coefficient !== 0n ? '-' : ''}${digits}`;
};

const digitCount = (n: bigint) => (n === 0n ? 0 : n.toString().length);
const pow10 = (n: number) => 10n ** BigInt(n);

// The exact value n/d × 10^e rounded half-even to t: round(n/d × 10^(e-t)).
const roundAt = (n: bigint, d: bigint, e: number, t: number): bigint => {
  let num = n;
  let den = d;
  if (e >= t) {
    num *= pow10(e - t);
  } else {
    den *= pow10(t - e);
  }
  const q = num / den;
  const r = num - q * den;
  const twice = 2n * r;
  if (twice > den || (twice === den && q % 2n === 1n)) {
    return q + 1n;
  }
  return q;
};

/**
 * Round the exact non-negative value n/d × 10^e, then pick the exponent
 * nearest `ideal` among the ways to write the rounded value.
 */
const result = (
  negative: boolean,
  n: bigint,
  d: bigint,
  e: number,
  ideal: number,
): Dec => {
  if (n === 0n) {
    return {
      negative: false,
      coefficient: 0n,
      exponent: Math.min(0, Math.max(MIN_EXPONENT, ideal)),
    };
  }
  // The smallest exponent that keeps at most 34 digits, but not below -6176.
  let t = e + digitCount(n) - digitCount(d) - DIGITS;
  let c = roundAt(n, d, e, t);
  while (digitCount(c) > DIGITS) {
    c = roundAt(n, d, e, ++t);
  }
  for (;;) {
    const finer = roundAt(n, d, e, t - 1);
    if (digitCount(finer) > DIGITS) {
      break;
    }
    t--;
    c = finer;
  }
  if (t < MIN_EXPONENT) {
    t = MIN_EXPONENT;
    c = roundAt(n, d, e, t);
  }
  if (c === 0n) {
    return result(false, 0n, 1n, 0, ideal);
  }
  if (t > 0 || c * pow10(Math.max(0, t)) >= LIMIT) {
    throw new ArithmeticError('overflow');
  }
  // Every exponent from the finest to the coarsest exact writing is allowed.
  let trailing = 0;
  while (c % pow10(trailing + 1) === 0n) {
    trailing++;
  }
  const coarsest = Math.min(0, t + trailing);
  const finest = Math.max(MIN_EXPONENT, t - (DIGITS - digitCount(c)));
  const exponent = Math.min(coarsest, Math.max(finest, ideal));
  const coefficient =
    exponent >= t ? c / pow10(exponent - t) : c * pow10(t - exponent);
  return { negative, coefficient, exponent };
};

const aligned = (a: Dec, b: Dec) => {
  const e = Math.min(a.exponent, b.exponent);
  const sa = (a.negative ? -1n : 1n) * a.coefficient * pow10(a.exponent - e);
  const sb = (b.negative ? -1n : 1n) * b.coefficient * pow10(b.exponent - e);
  return { sa, sb, e };
};
const signed = (value: bigint, d: bigint, e: number, ideal: number) =>
  result(value < 0n, value < 0n ? -value : value, d, e, ideal);

/**
 * The exact value num/den × 10^exponent (den > 0) rounded once, with any
 * trailing zeros after the point dropped: chapter 7's correctly rounded form.
 */
export const roundRatio = (num: bigint, den: bigint, exponent: number): Dec =>
  signed(num, den, exponent, 0);

export const add = (a: Dec, b: Dec): Dec => {
  const { sa, sb, e } = aligned(a, b);
  return signed(sa + sb, 1n, e, e);
};
export const subtract = (a: Dec, b: Dec): Dec => add(a, negate(b));
export const multiply = (a: Dec, b: Dec): Dec =>
  result(
    a.negative !== b.negative,
    a.coefficient * b.coefficient,
    1n,
    a.exponent + b.exponent,
    a.exponent + b.exponent,
  );
export const divide = (a: Dec, b: Dec): Dec => {
  if (b.coefficient === 0n) {
    throw new ArithmeticError('division by zero');
  }
  return result(
    a.negative !== b.negative,
    a.coefficient,
    b.coefficient,
    a.exponent - b.exponent,
    a.exponent - b.exponent,
  );
};
// The integer part of the exact quotient, toward zero.
const quotient = (a: Dec, b: Dec): bigint => {
  if (b.coefficient === 0n) {
    throw new ArithmeticError('division by zero');
  }
  const { sa, sb } = aligned(a, b);
  return sa / sb;
};
export const div = (a: Dec, b: Dec): Dec => signed(quotient(a, b), 1n, 0, 0);
export const mod = (a: Dec, b: Dec): Dec => {
  const { sa, sb, e } = aligned(a, b);
  return signed(sa - quotient(a, b) * sb, 1n, e, e);
};
export const negate = (a: Dec): Dec => ({
  ...a,
  negative: a.coefficient !== 0n && !a.negative,
});

/** `a ^ n` for an integer n: the exact power, rounded once. */
export const powerInteger = (a: Dec, n: bigint): Dec => {
  if (n === 0n) {
    return { negative: false, coefficient: 1n, exponent: 0 };
  }
  const m = n < 0n ? -n : n;
  const negative = a.negative && m % 2n === 1n;
  const ideal = Number(n) * a.exponent;
  if (a.coefficient === 0n) {
    if (n < 0n) {
      throw new ArithmeticError('division by zero');
    }
    return result(false, 0n, 1n, 0, ideal);
  }
  // A power whose digits couldn't be held is decided by its magnitude.
  const magnitude =
    Number(m) *
    (Math.log10(Number(a.coefficient.toString().slice(0, 17))) +
      digitCount(a.coefficient) -
      Math.min(17, digitCount(a.coefficient)) +
      a.exponent);
  if (Number(m) > 100_000 && Math.abs(magnitude) > 7000) {
    if (n > 0n === magnitude > 0) {
      throw new ArithmeticError('overflow');
    }
    return result(false, 0n, 1n, 0, ideal);
  }
  const c = a.coefficient ** m;
  const e = a.exponent * Number(m);
  return n > 0n
    ? result(negative, c, 1n, e, ideal)
    : result(negative, 1n, c, -e, ideal);
};

/** -1, 0 or 1, comparing by value. */
export const compareDec = (a: Dec, b: Dec): -1 | 0 | 1 => {
  const { sa, sb } = aligned(a, b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};
export const isInteger = (a: Dec): boolean =>
  a.exponent === 0 || a.coefficient % pow10(-a.exponent) === 0n;
/** The integer value of a number that is one. */
export const integerOf = (a: Dec): bigint =>
  (a.negative ? -1n : 1n) * (a.coefficient / pow10(-a.exponent));
export const decOf = (n: bigint): Dec => ({
  negative: n < 0n,
  coefficient: n < 0n ? -n : n,
  exponent: 0,
});
export const digitsOf = (a: Dec): number =>
  Math.max(1, digitCount(a.coefficient));
