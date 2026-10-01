// Chapter 7's Floats: an IEEE 754 binary64 or binary32 float read as the
// shortest decimal that reads back as the same float, and a number written as
// the nearest float, ties to even. Every step is exact BigInt work, so no
// Host float rounding takes part.

import type { Dec } from './decimal';

export type FloatFormat = { bias: number; bytes: 4 | 8; fraction: number };
export const BINARY64: FloatFormat = { bytes: 8, fraction: 52, bias: 1023 };
export const BINARY32: FloatFormat = { bytes: 4, fraction: 23, bias: 127 };

const pow10 = (n: number) => 10n ** BigInt(n);
const digitCount = (n: bigint) => (n === 0n ? 0 : n.toString().length);
const bitLength = (n: bigint) => (n === 0n ? 0 : n.toString(2).length);

// A non-negative rational, num/den.
type Ratio = { den: bigint; num: bigint };
const binary = (m: bigint, e: number): Ratio =>
  e >= 0 ? { num: m << BigInt(e), den: 1n } : { num: m, den: 1n << BigInt(-e) };
const decimal = (d: bigint, e: number): Ratio =>
  e >= 0 ? { num: d * pow10(e), den: 1n } : { num: d, den: pow10(-e) };
const compare = (a: Ratio, b: Ratio) => {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
};
const distance = (a: Ratio, b: Ratio): Ratio => {
  const n = a.num * b.den - b.num * a.den;
  return { num: n < 0n ? -n : n, den: a.den * b.den };
};
// floor(log10(v)) for v > 0.
const log10Floor = (v: Ratio): number => {
  const guess = digitCount(v.num) - digitCount(v.den);
  return compare(v, decimal(1n, guess)) >= 0 ? guess : guess - 1;
};

const readBits = (b: Uint8Array, little: boolean): bigint => {
  let bits = 0n;
  for (let i = 0; i < b.length; i++) {
    bits = (bits << 8n) | BigInt(b[little ? b.length - 1 - i : i]!);
  }
  return bits;
};
const writeBits = (bits: bigint, size: number, little: boolean) => {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[little ? i : size - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  }
  return out;
};

/**
 * The float in `b` as the shortest decimal that rounds to it, the nearest to
 * it of those, and the even one of two; undefined for NaN and ±Infinity.
 */
export const readFloat = (
  b: Uint8Array,
  format: FloatFormat,
  little: boolean,
): Dec | undefined => {
  const { fraction, bias } = format;
  const width = format.bytes * 8;
  const bits = readBits(b, little);
  const exponentBits = width - 1 - fraction;
  const negative = bits >> BigInt(width - 1) === 1n;
  const biased = Number(
    (bits >> BigInt(fraction)) & ((1n << BigInt(exponentBits)) - 1n),
  );
  const frac = bits & ((1n << BigInt(fraction)) - 1n);
  if (biased === 2 ** exponentBits - 1) {
    return undefined;
  }
  if (biased === 0 && frac === 0n) {
    return { negative: false, coefficient: 0n, exponent: 0 };
  }
  const m = biased === 0 ? frac : frac | (1n << BigInt(fraction));
  const e = (biased === 0 ? 1 : biased) - bias - fraction;
  // The values that round to this float, in quarters of its last place; the
  // gap below is half as wide at the bottom of a binade.
  const v = binary(4n * m, e - 2);
  const low = binary(4n * m - (frac === 0n && biased > 1 ? 1n : 2n), e - 2);
  const high = binary(4n * m + 2n, e - 2);
  const inclusive = m % 2n === 0n;
  const inside = (r: Ratio) => {
    const l = compare(r, low);
    const h = compare(r, high);
    return inclusive ? l >= 0 && h <= 0 : l > 0 && h < 0;
  };
  const lead = log10Floor(v);
  for (let p = 1; ; p++) {
    const q = lead - p + 1;
    const unit = decimal(1n, q);
    const below = (v.num * unit.den) / (v.den * unit.num);
    const choices = [below, below + 1n].filter(d => inside(decimal(d, q)));
    if (choices.length === 0) {
      continue;
    }
    let d = choices[0]!;
    if (choices.length === 2) {
      const order = compare(
        distance(decimal(below, q), v),
        distance(decimal(below + 1n, q), v),
      );
      d = order < 0 || (order === 0 && below % 2n === 0n) ? below : below + 1n;
    }
    let exponent = q;
    while (d % 10n === 0n) {
      d /= 10n;
      exponent++;
    }
    return exponent >= 0
      ? { negative, coefficient: d * pow10(exponent), exponent: 0 }
      : { negative, coefficient: d, exponent };
  }
};

/**
 * The bytes of the float nearest `x`, ties to even. A negative number too
 * small for the format rounds to negative zero.
 */
export const writeFloat = (
  x: Dec,
  format: FloatFormat,
  little: boolean,
): Uint8Array => {
  const { fraction, bias } = format;
  const width = format.bytes * 8;
  const sign =
    x.negative && x.coefficient !== 0n ? 1n << BigInt(width - 1) : 0n;
  if (x.coefficient === 0n) {
    return writeBits(0n, format.bytes, little);
  }
  const v = decimal(x.coefficient, x.exponent);
  const top = 1n << BigInt(fraction + 1);
  const minE = 1 - bias - fraction;
  // The exponent that puts fraction + 1 bits before the point, or the
  // subnormal one.
  let e = Math.max(minE, bitLength(v.num) - bitLength(v.den) - fraction - 1);
  const scaled = (at: number) => {
    const s = binary(1n, at);
    return { num: v.num * s.den, den: v.den * s.num };
  };
  while (e > minE && scaled(e).num < (top >> 1n) * scaled(e).den) {
    e--;
  }
  while (scaled(e).num >= top * scaled(e).den) {
    e++;
  }
  const { num, den } = scaled(e);
  let m = num / den;
  const twice = 2n * (num - m * den);
  if (twice > den || (twice === den && m % 2n === 1n)) {
    m++;
  }
  if (m === top) {
    m >>= 1n;
    e++;
  }
  const hidden = 1n << BigInt(fraction);
  const biased = m >= hidden ? BigInt(e + bias + fraction) : 0n;
  return writeBits(
    sign | (biased << BigInt(fraction)) | (m & (hidden - 1n)),
    format.bytes,
    little,
  );
};
