// Folio's built-in sample kits (ADR 0158, #1895): a drum machine and a
// handful of one-shots, so `loop "bd hh sd oh"` plays before anything is
// imported. Every sound is synthesised by the code below rather than
// recorded, so the kits carry no third-party licence: they are dedicated
// to the public domain under CC0 1.0. The build writes each sound to
// `kits/<kit>/<name>.wav`, the service worker precaches them, and
// `tests/build.test.ts` holds them to `KIT_BUDGET_BYTES`.
import { encodeWav } from '../wav';
import {
  attack,
  decay,
  highPass,
  KIT_RATE,
  lowPass,
  noise,
  normalise,
  render,
  sine,
  square,
  sweep,
} from './synth';

/** One sound in a kit; `variants[n]` is what `name:n` plays. */
export type KitSample = {
  readonly description: string;
  readonly name: string;
  readonly variants: readonly (() => Float32Array)[];
};

export type Kit = {
  readonly description: string;
  readonly licence: string;
  readonly name: string;
  readonly samples: readonly KitSample[];
  /** Where the sounds come from. */
  readonly source: string;
};

/** The most bytes every kit's WAV files may take between them. */
export const KIT_BUDGET_BYTES = 512 * 1024;

const SOURCE =
  'Synthesised by tooling/creative/src/kits/kits.ts in the NorthTalk repository; no recordings are used.';
const LICENCE =
  'CC0 1.0 Universal (public domain dedication): https://creativecommons.org/publicdomain/zero/1.0/';

const sample = (
  name: string,
  description: string,
  ...variants: (() => Float32Array)[]
): KitSample => ({ name, description, variants });

const kick = (from: number, tau: number, length: number) => () => {
  const body = sweep(from, 45, 0.04);
  const click = noise(7);
  const clickFilter = lowPass(3000);
  return normalise(
    render(length, t => {
      const tick = clickFilter(click()) * decay(t, 0.003);
      return attack(t) * (body(t) * decay(t, tau) + 0.4 * tick);
    }),
  );
};

const snare =
  (tone: number, tau: number, length: number, seed: number) => () => {
    const random = noise(seed);
    const filter = highPass(1500);
    return normalise(
      render(length, t => {
        const body = 0.5 * sine(tone, t) * decay(t, 0.03);
        return attack(t) * (body + filter(random()) * decay(t, tau));
      }),
    );
  };

// Six detuned squares, the classic metallic source for hats and cymbals.
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];
const hat =
  (tau: number, length: number, cutoff: number, seed: number) => () => {
    const random = noise(seed);
    const filter = highPass(cutoff);
    return normalise(
      render(length, t => {
        const metal = METAL.reduce((sum, f) => sum + square(f * 2.5, t), 0) / 6;
        return attack(t) * filter(0.6 * metal + 0.6 * random()) * decay(t, tau);
      }),
    );
  };

const clap = () => {
  const random = noise(41);
  const filter = highPass(900);
  const bursts = [0, 0.011, 0.023];
  return normalise(
    render(0.3, t => {
      const level = bursts.reduce(
        (sum, start) => sum + (t >= start ? decay(t - start, 0.006) : 0),
        decay(Math.max(0, t - 0.03), 0.07) * (t >= 0.03 ? 0.7 : 0),
      );
      return attack(t) * filter(random()) * level;
    }),
  );
};

const rim = () =>
  normalise(
    render(
      0.06,
      t =>
        attack(t, 0.0003) *
        (0.6 * sine(1700, t) + 0.5 * square(480, t)) *
        decay(t, 0.008),
    ),
  );

const tom = (from: number, to: number) => () => {
  const body = sweep(from, to, 0.1);
  return normalise(render(0.4, t => attack(t) * body(t) * decay(t, 0.12)));
};

const cowbell = () => {
  const filter = lowPass(2500);
  return normalise(
    render(
      0.3,
      t =>
        attack(t) *
        filter(0.5 * square(540, t) + 0.5 * square(800, t)) *
        (0.6 * decay(t, 0.015) + 0.4 * decay(t, 0.12)),
    ),
  );
};

const MIDDLE_C = 261.6256;

// Karplus-Strong: a noise burst circulating in a delay line one period long.
const pluck = () => {
  const random = noise(97);
  const period = Math.round(KIT_RATE / MIDDLE_C);
  const line = Float32Array.from({ length: period }, () => random());
  let at = 0;
  return normalise(
    render(0.8, t => {
      const next = (at + 1) % period;
      const value = line[at]!;
      line[at] = 0.996 * 0.5 * (value + line[next]!);
      at = next;
      return attack(t) * value;
    }),
  );
};

// Two-operator FM with an inharmonic ratio, as a small bell.
const bell = () =>
  normalise(
    render(1, t => {
      const modulator = 3 * decay(t, 0.25) * sine(MIDDLE_C * 3.5, t);
      return (
        attack(t) *
        Math.sin(2 * Math.PI * MIDDLE_C * t + modulator) *
        decay(t, 0.3)
      );
    }),
  );

/** The drum machine every `loop` and `play` without `on` plays. */
export const DRUMS: Kit = {
  name: 'drums',
  description: 'An analogue-style drum machine.',
  source: SOURCE,
  licence: LICENCE,
  samples: [
    sample(
      'bd',
      'Bass drum; `bd:1` is short and punchy.',
      kick(160, 0.12, 0.45),
      kick(220, 0.05, 0.25),
    ),
    sample(
      'sd',
      'Snare drum; `sd:1` is tighter.',
      snare(185, 0.07, 0.25, 11),
      snare(240, 0.035, 0.15, 13),
    ),
    sample('hh', 'Closed hi-hat.', hat(0.015, 0.08, 7000, 21)),
    sample('oh', 'Open hi-hat.', hat(0.12, 0.45, 7000, 23)),
    sample('cp', 'Hand clap.', clap),
    sample('rim', 'Rim shot.', rim),
    sample('lt', 'Low tom.', tom(130, 80)),
    sample('mt', 'Mid tom.', tom(190, 120)),
    sample('ht', 'High tom.', tom(280, 175)),
    sample('cb', 'Cowbell.', cowbell),
    sample('cr', 'Crash cymbal.', hat(0.35, 1.2, 4000, 31)),
  ],
};

/** One-shots; the pitched ones sound at middle C, the sampler's root note. */
export const SHOTS: Kit = {
  name: 'shots',
  description: 'Short effects and pitched one-shots.',
  source: SOURCE,
  licence: LICENCE,
  samples: [
    sample('blip', 'A square-wave blip at middle C.', () =>
      normalise(
        render(
          0.15,
          t => attack(t) * 0.5 * square(MIDDLE_C, t) * decay(t, 0.05),
        ),
      ),
    ),
    sample('zap', 'A falling laser zap.', () => {
      const body = sweep(1800, 90, 0.06);
      return normalise(
        render(
          0.3,
          t => attack(t) * (body(t) >= 0 ? 0.5 : -0.5) * decay(t, 0.1),
        ),
      );
    }),
    sample('pluck', 'A plucked string at middle C.', pluck),
    sample('bell', 'A small FM bell at middle C.', bell),
    sample('sub', 'A deep sine bass at middle C, two octaves down.', () =>
      normalise(
        render(
          0.6,
          t => attack(t, 0.005) * sine(MIDDLE_C / 4, t) * decay(t, 0.25),
        ),
      ),
    ),
    sample('noise', 'A burst of white noise.', () => {
      const random = noise(53);
      return normalise(render(0.3, t => attack(t) * random() * decay(t, 0.08)));
    }),
  ],
};

/** Every built-in kit. Sample names are unique across kits. */
export const KITS: readonly Kit[] = [DRUMS, SHOTS];

/** The kit a Sound Pattern plays when it names no Instrument. */
export const DEFAULT_KIT = DRUMS;

/**
 * The Instrument name the default kit's sampler plays under. A Script
 * can't write it as a name, so it never clashes with an authored
 * Instrument.
 */
export const DEFAULT_KIT_INSTRUMENT = '#kit';

/** Every kit sample's name, for pattern checks. */
export const KIT_SAMPLE_NAMES: ReadonlySet<string> = new Set(
  KITS.flatMap(kit => kit.samples.map(s => s.name)),
);

/**
 * The sampler's key for `name:index`: `name` for the first variant and
 * `name:n` for the others. An index past the last variant wraps around.
 */
export const kitSampleKey = (name: string, index = 0): string => {
  const found = KITS.flatMap(kit => kit.samples).find(s => s.name === name);
  const count = found?.variants.length ?? 1;
  const n = ((index % count) + count) % count;
  return n === 0 ? name : `${name}:${n}`;
};

/** One kit sound as a file the build writes. */
export type KitFile = {
  /** The sampler's key for it. */
  readonly key: string;
  /** Its path under the app's root, e.g. `kits/drums/bd-1.wav`. */
  readonly path: string;
};

/** Every kit sound's file, in kit order. */
export const KIT_FILES: readonly KitFile[] = KITS.flatMap(kit =>
  kit.samples.flatMap(s =>
    s.variants.map((_, n) => ({
      key: n === 0 ? s.name : `${s.name}:${n}`,
      path: `kits/${kit.name}/${s.name}${n === 0 ? '' : `-${n}`}.wav`,
    })),
  ),
);

/** Renders every kit sound as WAV bytes, keyed by its file's path. */
export const renderKitFiles = (): Map<string, Uint8Array> => {
  const files = new Map<string, Uint8Array>();
  let at = 0;
  for (const kit of KITS) {
    for (const s of kit.samples) {
      for (const variant of s.variants) {
        files.set(KIT_FILES[at++]!.path, encodeWav(variant(), KIT_RATE));
      }
    }
  }
  return files;
};

/** The kits' licence notice, written beside the sounds. */
export const kitNotice = (): string =>
  KITS.map(kit =>
    [
      `${kit.name}: ${kit.description}`,
      `Source: ${kit.source}`,
      `Licence: ${kit.licence}`,
      ...kit.samples.map(s => `  ${s.name}: ${s.description}`),
    ].join('\n'),
  ).join('\n\n') + '\n';
