// The Script Group's generator for `random(n)`: PCG32, XSH RR, with the
// increment and seeding the Spec fixes (chapter 7, Random numbers; ADR 0096).

const MASK64 = (1n << 64n) - 1n;
const MULTIPLIER = 6_364_136_223_846_793_005n;
const INCREMENT = 1_442_695_040_888_963_407n;
const SPAN = 1n << 32n;

const step = (state: bigint): bigint =>
  (state * MULTIPLIER + INCREMENT) & MASK64;

const output = (state: bigint): bigint => {
  const xorshifted = (((state >> 18n) ^ state) >> 27n) & 0xff_ff_ff_ffn;
  const rot = state >> 59n;
  return ((xorshifted >> rot) | (xorshifted << (-rot & 31n))) & 0xff_ff_ff_ffn;
};

/** The generator state a seed, a whole number 0 to 2^64 - 1, gives. */
export const seedState = (seed: bigint): bigint =>
  step((step(0n) + seed) & MASK64);

/** The largest `n` that `random` takes. */
export const randomLimit = SPAN;

/**
 * The next whole number 1..n, 1 <= n <= 2^32, and the state after it.
 * Draws below (2^32 - n) mod n are rejected, so every result is as likely.
 */
export const nextRandom = (
  state: bigint,
  n: bigint,
): { state: bigint; value: bigint } => {
  const threshold = (SPAN - n) % n;
  for (;;) {
    const r = output(state);
    state = step(state);
    if (r >= threshold) {
      return { state, value: (r % n) + 1n };
    }
  }
};
