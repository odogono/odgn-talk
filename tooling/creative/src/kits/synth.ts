// The building blocks the Music sounds are synthesised from (#1895):
// oscillators, seeded noise, envelopes and one-pole filters. Every sound
// is computed from code, so the same build always writes the same bytes
// and no third-party recording is involved.

/** The rate every kit sound is rendered at. */
export const KIT_RATE = 22_050;

const TAU = 2 * Math.PI;

/** `seconds` of sound, sample by sample, from `at(t, i)`. */
export const render = (
  seconds: number,
  at: (t: number, i: number) => number,
): Float32Array => {
  const out = new Float32Array(Math.round(seconds * KIT_RATE));
  for (let i = 0; i < out.length; i++) {
    out[i] = at(i / KIT_RATE, i);
  }
  return out;
};

/** White noise in [-1, 1], the same for the same seed. */
export const noise = (seed: number): (() => number) => {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x80_00_00_00 - 1;
  };
};

/** An exponential decay that falls to 1/e after `tau` seconds. */
export const decay = (t: number, tau: number): number => Math.exp(-t / tau);

/** A short linear fade-in, so a sound never starts with a click. */
export const attack = (t: number, seconds = 0.001): number =>
  Math.min(1, t / seconds);

/** A one-pole low-pass filter at `cutoff` Hz, fed one sample at a time. */
export const lowPass = (cutoff: number): ((x: number) => number) => {
  const a = 1 - Math.exp((-TAU * cutoff) / KIT_RATE);
  let y = 0;
  return x => (y += a * (x - y));
};

/** A one-pole high-pass filter at `cutoff` Hz. */
export const highPass = (cutoff: number): ((x: number) => number) => {
  const low = lowPass(cutoff);
  return x => x - low(x);
};

/**
 * A sine whose frequency glides exponentially from `from` to `to` Hz with
 * time constant `tau`; returns a stateful oscillator over time steps.
 */
export const sweep = (
  from: number,
  to: number,
  tau: number,
): ((t: number) => number) => {
  let phase = 0;
  return t => {
    const frequency = to + (from - to) * Math.exp(-t / tau);
    phase += (TAU * frequency) / KIT_RATE;
    return Math.sin(phase);
  };
};

/** A square wave at `frequency` Hz. */
export const square = (frequency: number, t: number): number =>
  Math.sin(TAU * frequency * t) >= 0 ? 1 : -1;

/** A sine at `frequency` Hz. */
export const sine = (frequency: number, t: number): number =>
  Math.sin(TAU * frequency * t);

/** Scales a sound so its loudest sample reaches `peak`. */
export const normalise = (samples: Float32Array, peak = 0.9): Float32Array => {
  let max = 0;
  for (const sample of samples) {
    max = Math.max(max, Math.abs(sample));
  }
  if (max > 0) {
    const scale = peak / max;
    for (let i = 0; i < samples.length; i++) {
      samples[i]! *= scale;
    }
  }
  return samples;
};
