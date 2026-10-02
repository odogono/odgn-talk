// Chapter 7's correctly rounded number functions. Each works out its value in
// BigInt fixed point, to a working precision with a known error bound, and
// raises the precision until both ends of that bound round to the same
// number (Ziv's strategy). A value that could sit exactly on a rounding
// boundary is found exactly first, so the loop always ends. Domains are the
// caller's to check.

import {
  ArithmeticError,
  isInteger,
  powerInteger,
  integerOf,
  roundRatio,
  type Dec,
} from './decimal';

const ZERO: Dec = { negative: false, coefficient: 0n, exponent: 0 };
const ONE: Dec = { negative: false, coefficient: 1n, exponent: 0 };
const ten = (n: number) => 10n ** BigInt(n);
const abs = (n: bigint) => (n < 0n ? -n : n);
const digitCount = (n: bigint) => (n === 0n ? 0 : abs(n).toString().length);
const bitLength = (n: bigint) => (n === 0n ? 0 : n.toString(2).length);
const signedOf = (x: Dec) => (x.negative ? -x.coefficient : x.coefficient);
// The position of x's leading digit: 1 for 1 to 9.99…, 0 for 0.1 to 0.99….
const magnitude = (x: Dec) => digitCount(x.coefficient) + x.exponent;
// x as a fixed-point integer at scale q, toward zero.
const fixed = (x: Dec, q: number) =>
  q + x.exponent >= 0
    ? signedOf(x) * ten(q + x.exponent)
    : signedOf(x) / ten(-q - x.exponent);

export const isqrt = (n: bigint): bigint => {
  if (n < 2n) {
    return n;
  }
  let x = 1n << BigInt((bitLength(n) >> 1) + 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) {
      return x;
    }
    x = y;
  }
};
const gcd = (a: bigint, b: bigint): bigint => {
  let [x, y] = [a, b];
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
};
// The integer q-th root of n, if n is a perfect q-th power.
const exactRoot = (n: bigint, q: bigint): bigint | undefined => {
  if (n === 1n) {
    return 1n;
  }
  if (q > BigInt(bitLength(n))) {
    return undefined;
  }
  // Newton's method from above, which only falls until it reaches the root.
  let x = 1n << (BigInt(bitLength(n)) / q + 1n);
  for (;;) {
    const y = ((q - 1n) * x + n / x ** (q - 1n)) / q;
    if (y >= x) {
      break;
    }
    x = y;
  }
  return x ** q === n ? x : undefined;
};

// ---------------------------------------------------------------------------
// Fixed-point kernels: each takes and gives values at scale q, accurate to a
// few units in the last place, working with guard digits inside.
// ---------------------------------------------------------------------------

// arctan(1/n), by its series.
const atanInverse = (n: bigint, g: number): bigint => {
  const n2 = n * n;
  let power = ten(g) / n;
  let sum = 0n;
  for (let k = 1n, sign = 1n; power !== 0n; k += 2n, sign = -sign) {
    sum += (sign * power) / k;
    power /= n2;
  }
  return sum;
};
const cached = (make: (q: number) => bigint) => {
  let best = { q: -1, v: 0n };
  return (q: number): bigint => {
    if (q > best.q) {
      best = { q: q + 20, v: make(q + 20) };
    }
    return best.v / ten(best.q - q);
  };
};
// Machin's formula.
const pi = cached(
  q =>
    (16n * atanInverse(5n, q + 10) - 4n * atanInverse(239n, q + 10)) / ten(10),
);

// e^r for |r| ≤ 3: the series on r/2^12, then squared 12 times.
const expFixed = (r: bigint, q: number): bigint => {
  const g = q + 8;
  const one = ten(g);
  const x = (r * ten(8)) >> 12n;
  let sum = one;
  let term = one;
  for (let n = 1n; term !== 0n; n++) {
    term = (term * x) / (one * n);
    sum += term;
  }
  for (let i = 0; i < 12; i++) {
    sum = (sum * sum) / one;
  }
  return sum / ten(8);
};

// ln m for m from 1 to 10: 2^24 square roots bring m near 1, where
// ln u = 2 atanh((u - 1)/(u + 1)).
const lnFixed = (m: bigint, q: number): bigint => {
  const g = q + 12;
  const one = ten(g);
  let u = m * ten(12);
  for (let i = 0; i < 24; i++) {
    u = isqrt(u * one);
  }
  const z = ((u - one) * one) / (u + one);
  const z2 = (z * z) / one;
  let sum = 0n;
  let power = z;
  for (let n = 1n; power !== 0n; n += 2n) {
    sum += power / n;
    power = (power * z2) / one;
  }
  return (sum << 25n) / ten(12);
};
const ln10 = cached(q => lnFixed(10n * ten(q), q));

// arctan z for |z| ≤ 1: halved 8 times by z/(1 + √(1 + z²)), then the series.
const atanFixed = (z: bigint, q: number): bigint => {
  const g = q + 6;
  const one = ten(g);
  let x = z * ten(6);
  for (let i = 0; i < 8; i++) {
    x = (x * one) / (one + isqrt(one * one + x * x));
  }
  const x2 = (x * x) / one;
  let sum = 0n;
  let power = x;
  for (let n = 1n, sign = 1n; power !== 0n; n += 2n, sign = -sign) {
    sum += (sign * power) / n;
    power = (power * x2) / one;
  }
  return (sum << 8n) / ten(6);
};

// The angle of (X, Y), for integers at one scale, not both 0.
const atan2Fixed = (y: bigint, x: bigint, q: number): bigint => {
  if (abs(y) <= abs(x)) {
    const a = atanFixed((y * ten(q)) / x, q);
    if (x > 0n) {
      return a;
    }
    return y >= 0n ? a + pi(q) : a - pi(q);
  }
  const a = atanFixed((x * ten(q)) / y, q);
  return y > 0n ? pi(q) / 2n - a : -pi(q) / 2n - a;
};

// sin x and cos x: x less a whole number n of pi/2, then the two series.
const sinCos = (x: Dec, q: number): { c: bigint; s: bigint } => {
  const g = q + 10 + Math.max(0, magnitude(x));
  const one = ten(g);
  const big = fixed(x, g);
  const half = abs(big) * 4n < 3n * one ? 0n : pi(g) / 2n;
  const n =
    half === 0n ? 0n : (2n * big + (big < 0n ? -half : half)) / (2n * half);
  const r = big - n * half;
  const r2 = (r * r) / one;
  let sin = r;
  let cos = one;
  let ts = r;
  let tc = one;
  for (let k = 1n; ts !== 0n || tc !== 0n; k++) {
    ts = (-ts * r2) / (one * (2n * k) * (2n * k + 1n));
    tc = (-tc * r2) / (one * (2n * k - 1n) * (2n * k));
    sin += ts;
    cos += tc;
  }
  const [s, c] = [
    [sin, cos],
    [cos, -sin],
    [-sin, -cos],
    [-cos, sin],
  ][Number(((n % 4n) + 4n) % 4n)]!;
  return { s: s! / ten(g - q), c: c! / ten(g - q) };
};

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------

// v × 10^-scale, within err × 10^-scale of the exact value; or undefined to
// ask for more precision.
type Approx = { err: bigint; scale: number; v: bigint } | undefined;
const OVERFLOW = 'overflow';
const attempt = (v: bigint, scale: number): Dec | typeof OVERFLOW => {
  try {
    return roundRatio(v, 1n, -scale);
  } catch (error) {
    if (error instanceof ArithmeticError) {
      return OVERFLOW;
    }
    throw error;
  }
};
const settle = (approx: (p: number) => Approx): Dec => {
  for (let p = 40; p <= 100_000; p *= 2) {
    const a = approx(p);
    if (!a) {
      continue;
    }
    const lo = attempt(a.v - a.err, a.scale);
    const hi = attempt(a.v + a.err, a.scale);
    if (lo === OVERFLOW && hi === OVERFLOW) {
      throw new ArithmeticError('overflow');
    }
    if (
      lo !== OVERFLOW &&
      hi !== OVERFLOW &&
      lo.negative === hi.negative &&
      lo.coefficient === hi.coefficient &&
      lo.exponent === hi.exponent
    ) {
      return lo;
    }
  }
  throw new Error('no correctly rounded result');
};
const ERR = 1000n;

// e^w for w at scale q: 10^k × e^(w - k ln 10).
const expScaled = (w: bigint, q: number): Approx => {
  const k = BigInt(Math.floor(Number(w / ten(q - 6)) / 1e6 / Math.LN10));
  const g = q + digitCount(k) + 2;
  const r = (w * ten(g - q) - k * ln10(g)) / ten(g - q);
  return { v: expFixed(r, q), scale: q - Number(k), err: ERR };
};
// ln x at scale q, for x > 0: ln of x's digits read as 1 to 10, plus n ln 10.
const lnScaled = (x: Dec, q: number): bigint => {
  const n = BigInt(magnitude(x) - 1);
  const g = q + digitCount(n) + 2;
  const m = fixed({ ...x, exponent: 1 - digitCount(x.coefficient) }, g);
  return (lnFixed(m, g) + n * ln10(g)) / ten(g - q);
};

// ---------------------------------------------------------------------------
// The functions
// ---------------------------------------------------------------------------

/** √x for x ≥ 0, from the integer square root, so always exact. */
export const sqrt = (x: Dec): Dec => {
  if (x.coefficient === 0n) {
    return ZERO;
  }
  const odd = x.exponent % 2 !== 0;
  const c = odd ? x.coefficient * 10n : x.coefficient;
  const e = odd ? x.exponent - 1 : x.exponent;
  // Enough digits that no rounding boundary lies strictly between s and s + 1.
  const j = Math.max(0, Math.ceil((72 - digitCount(c)) / 2));
  const n = c * ten(2 * j);
  const s = isqrt(n);
  const scale = e / 2 - j;
  return s * s === n
    ? roundRatio(s, 1n, scale)
    : roundRatio(2n * s + 1n, 2n, scale);
};

export const exp = (x: Dec): Dec => {
  if (x.coefficient === 0n) {
    return ONE;
  }
  if (!x.negative && magnitude(x) >= 3) {
    throw new ArithmeticError('overflow');
  }
  if (x.negative && magnitude(x) >= 6) {
    return ZERO;
  }
  return settle(p => expScaled(fixed(x, p + 10), p + 10));
};

/** ln x for x > 0. */
export const ln = (x: Dec): Dec => {
  if (x.coefficient === ten(-x.exponent)) {
    return ZERO;
  }
  return settle(p => ({ v: lnScaled(x, p + 10), scale: p + 10, err: ERR }));
};

/** log10 x for x > 0; a power of ten gives its exact integer. */
export const log10 = (x: Dec): Dec => {
  const digits = x.coefficient.toString();
  if (/^10*$/.test(digits)) {
    return roundRatio(BigInt(digits.length - 1 + x.exponent), 1n, 0);
  }
  return settle(p => {
    const q = p + 10;
    return { v: (lnScaled(x, q) * ten(q)) / ln10(q), scale: q, err: ERR };
  });
};

// x^y exactly, when it is rational and small enough to work out: y = p/q and
// x = a/b in lowest terms, with a and b perfect q-th powers. Any other
// rational value has far more digits than a rounding boundary.
const exactPower = (x: Dec, y: Dec): Dec | undefined => {
  const yDen = ten(-y.exponent);
  const yGcd = gcd(y.coefficient, yDen);
  const p = y.coefficient / yGcd;
  const q = yDen / yGcd;
  const xDen = ten(-x.exponent);
  const xGcd = gcd(x.coefficient, xDen);
  const ra = exactRoot(x.coefficient / xGcd, q);
  const rb = exactRoot(xDen / xGcd, q);
  if (
    ra === undefined ||
    rb === undefined ||
    p * BigInt(Math.max(bitLength(ra), bitLength(rb))) > 30_000n
  ) {
    return undefined;
  }
  return y.negative
    ? roundRatio(rb ** p, ra ** p, 0)
    : roundRatio(ra ** p, rb ** p, 0);
};

/**
 * x^y: `x ^ y` for an integer y, and otherwise e^(y ln x) for x ≥ 0. A
 * negative x with a non-integer y is the caller's `out of domain`.
 */
export const power = (x: Dec, y: Dec): Dec => {
  if (isInteger(y)) {
    return powerInteger(x, integerOf(y));
  }
  if (x.coefficient === ten(-x.exponent)) {
    return ONE;
  }
  if (x.coefficient === 0n) {
    if (y.negative) {
      throw new ArithmeticError('division by zero');
    }
    return ZERO;
  }
  // Far past either end, the magnitude alone decides.
  const lead = x.coefficient.toString();
  const log10x =
    Math.log10(Number(`0.${lead.slice(0, 17)}`)) + lead.length + x.exponent;
  const estimate =
    Number(`${y.negative ? '-' : ''}${y.coefficient}e${y.exponent}`) * log10x;
  if (estimate > 34.5) {
    throw new ArithmeticError('overflow');
  }
  if (estimate < -6178) {
    return ZERO;
  }
  const exact = exactPower(x, y);
  if (exact) {
    return exact;
  }
  return settle(p => {
    const q = p + 10;
    const g = q + Math.max(0, magnitude(y)) + 6;
    return expScaled((lnScaled(x, g) * fixed(y, g)) / ten(2 * g - q), q);
  });
};

// The extra digits a result about as small as `lead` says needs.
const below = (lead: number) => Math.max(0, -lead);

export const sin = (x: Dec): Dec => {
  if (x.coefficient === 0n) {
    return ZERO;
  }
  return settle(p => {
    const q = p + 10 + below(magnitude(x));
    return { v: sinCos(x, q).s, scale: q, err: ERR };
  });
};
export const cos = (x: Dec): Dec => {
  if (x.coefficient === 0n) {
    return ONE;
  }
  return settle(p => ({ v: sinCos(x, p + 10).c, scale: p + 10, err: ERR }));
};
export const tan = (x: Dec): Dec => {
  if (x.coefficient === 0n) {
    return ZERO;
  }
  return settle(p => {
    const q = p + 10 + below(magnitude(x));
    const { s, c } = sinCos(x, q);
    if (abs(c) <= 100n) {
      return undefined;
    }
    const t = (s * ten(q)) / c;
    // Each of s and c is within a few units, so t is within this.
    return { v: t, scale: q, err: (16n * (ten(q) + abs(t))) / abs(c) + 4n };
  });
};

// x, and √(1 - x²), at scale q, for |x| ≤ 1.
const unitPair = (x: Dec, q: number) => {
  const k = -x.exponent;
  const g = Math.max(q, k);
  const c = x.coefficient;
  return {
    g,
    s: isqrt((ten(2 * k) - c * c) * ten(2 * g - 2 * k)),
    x: signedOf(x) * ten(g - k),
  };
};
/** arcsin x for |x| ≤ 1. */
export const asin = (x: Dec): Dec => {
  if (x.coefficient === 0n) {
    return ZERO;
  }
  return settle(p => {
    const u = unitPair(x, p + 10 + below(magnitude(x)));
    return { v: atan2Fixed(u.x, u.s, u.g), scale: u.g, err: ERR };
  });
};
/** arccos x for |x| ≤ 1. */
export const acos = (x: Dec): Dec => {
  if (!x.negative && x.coefficient === ten(-x.exponent)) {
    return ZERO;
  }
  return settle(p => {
    const u = unitPair(x, p + 10);
    return { v: atan2Fixed(u.s, u.x, u.g), scale: u.g, err: ERR };
  });
};
export const atan = (x: Dec): Dec => atan2(x, ONE);
/** The angle of (x, y), for x and y not both 0. */
export const atan2 = (y: Dec, x: Dec): Dec => {
  if (y.coefficient === 0n && !x.negative) {
    return ZERO;
  }
  const e = Math.min(y.exponent, x.exponent);
  const ys = signedOf(y) * ten(y.exponent - e);
  const xs = signedOf(x) * ten(x.exponent - e);
  const lead = x.coefficient === 0n ? 0 : magnitude(y) - magnitude(x);
  return settle(p => {
    const q = p + 10 + below(lead);
    return { v: atan2Fixed(ys, xs, q), scale: q, err: ERR };
  });
};
