// Golden-render scenarios for the copied audio engines (#1889). Each takes the
// engine modules as arguments, so tools/audio-goldens.ts can run the same
// scenario on the originals in mercenary and wime and on the copies here.
import { createHash } from 'node:crypto';

type Command =
  | { readonly kind: 'reset' }
  | {
      readonly kind: 'write';
      readonly register: number;
      readonly value: number;
    };

type Ym = {
  render(count: number): Float32Array;
  reset(): void;
  write(register: number, value: number): void;
};

type Host = {
  process(output: Float32Array, currentTime: number): void;
  receive(batch: {
    at: number;
    commands: readonly Command[];
    replacePending?: boolean;
  }): void;
};

type Sample = {
  data: Int8Array;
  length: number;
  loopLength: number;
  loopStart: number;
};

export type Modules = {
  readonly buildFilterBank: (wave: Int8Array) => Int8Array;
  readonly createMixer: (sampleRate: number) => {
    mix(
      left: Float32Array,
      right: Float32Array,
      from: number,
      to: number,
    ): void;
    play(voice: number, sample: Sample): void;
    queue(voice: number, sample: Sample): void;
    setPitch(voice: number, hz: number): void;
    setVolume(voice: number, volume: number): void;
    stop(voice: number): void;
  };
  /// Builds a host for a mono chip, as the original's or the copy's ChipHost.
  readonly host: (
    chip: Ym,
    sampleRate: number,
    tick: { hertz: number; run: () => void },
  ) => Host;
  readonly renderWave: (
    output: Int8Array,
    wave: Int8Array,
    byteAfterWave: number,
    shift: number,
    blendRate: number,
    ringRate: number,
    ticksPerBeat: number,
    state: { accumulator: number; direction: number },
  ) => void;
  readonly Ym2149: new (sampleRate: number) => Ym;
};

const RATE = 44_100;

export const sha256 = (view: ArrayBufferView): string =>
  createHash('sha256')
    .update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    .digest('hex');

const saw = (): Int8Array =>
  Int8Array.from({ length: 128 }, (_, index) => index * 2 - 128);

const square = (): Int8Array =>
  Int8Array.from({ length: 128 }, (_, index) => (index < 40 ? 100 : -90));

const writes = (pairs: readonly (readonly [number, number])[]): Command[] =>
  pairs.map(([register, value]) => ({ kind: 'write', register, value }));

/// Tone, noise and an envelope on the YM2149 through a ChipHost, with a 50 Hz
/// driver tick sweeping channel A's period.
const ymSong = (modules: Modules): Float32Array => {
  const chip = new modules.Ym2149(RATE);
  let period = 284;
  const host = modules.host(chip, RATE, {
    hertz: 50,
    run: () => {
      period = period >= 600 ? 200 : period + 7;
      chip.write(0, period & 0xff);
      chip.write(1, period >> 8);
    },
  });
  host.receive({
    at: 0,
    commands: writes([
      [0, 284 & 0xff],
      [1, 284 >> 8],
      [7, 0b11_1110],
      [8, 15],
    ]),
  });
  host.receive({
    at: 0.25,
    commands: writes([
      [2, 0x40],
      [3, 0x01],
      [6, 12],
      [7, 0b11_0100],
      [9, 12],
    ]),
  });
  host.receive({
    at: 0.5,
    commands: writes([
      [4, 0x20],
      [5, 0x02],
      [7, 0b11_0000],
      [10, 0x10],
      [11, 0x00],
      [12, 0x08],
      [13, 0x0e],
    ]),
  });
  host.receive({ at: 0.75, commands: [{ kind: 'reset' }] });
  host.receive({
    at: 0.8,
    commands: writes([
      [0, 90],
      [7, 0b11_1110],
      [8, 10],
    ]),
  });
  const output = new Float32Array(RATE);
  for (let frame = 0; frame < output.length; frame += 128) {
    host.process(output.subarray(frame, frame + 128), frame / RATE);
  }
  return output;
};

/// Every envelope shape, a quarter second each, rendered straight from the chip.
const ymEnvelopes = (modules: Modules): Float32Array => {
  const chip = new modules.Ym2149(RATE);
  const quarter = RATE / 4;
  const output = new Float32Array(quarter * 16);
  for (let shape = 0; shape < 16; shape++) {
    chip.write(7, 0b11_1111);
    chip.write(8, 0x10);
    chip.write(11, 0x80);
    chip.write(12, 0x01);
    chip.write(13, shape);
    output.set(chip.render(quarter), shape * quarter);
  }
  return output;
};

const filterBank = (modules: Modules): Int8Array =>
  modules.buildFilterBank(saw());

/// renderWave over 200 ticks at every shift: a copy, a blend and a ring.
const waveTicks = (modules: Modules): Int8Array => {
  const bank = modules.buildFilterBank(square());
  const ticks = 200;
  const output = new Int8Array(ticks * 3 * 128);
  const modes = [
    [0, 0],
    [0x30, 0],
    [0x50, 0x60],
  ] as const;
  modes.forEach(([blend, ring], mode) => {
    const state = { accumulator: 0, direction: 1 };
    for (let tick = 0; tick < ticks; tick++) {
      const band = (tick * 3) % 64;
      const offset = (mode * ticks + tick) * 128;
      modules.renderWave(
        output.subarray(offset, offset + 128),
        bank.subarray(band * 128, band * 128 + 128),
        bank[(band + 1) * 128] ?? 0,
        tick % 6,
        blend,
        ring,
        0x80_00,
        state,
      );
    }
  });
  return output;
};

const loop = (data: Int8Array): Sample => ({
  data,
  length: data.length,
  loopLength: data.length,
  loopStart: 0,
});

/// The four-voice mixer: loops, a one-shot, a queued sample, pitch and volume.
const mixer = (modules: Modules): Float32Array => {
  const mix = modules.createMixer(RATE);
  const left = new Float32Array(RATE);
  const right = new Float32Array(RATE);
  mix.play(0, loop(saw()));
  mix.setPitch(0, 440 * 128);
  mix.play(1, { data: square(), length: 128, loopLength: 0, loopStart: 0 });
  mix.setPitch(1, 8000);
  mix.setVolume(1, 0.5);
  mix.mix(left, right, 0, RATE / 4);
  mix.queue(0, { ...loop(square()), loopStart: 20, loopLength: 60 });
  mix.play(2, loop(square()));
  mix.setPitch(2, 220 * 128);
  mix.setVolume(3, 0.25);
  mix.queue(3, loop(saw()));
  mix.setPitch(3, 330 * 128);
  mix.mix(left, right, RATE / 4, RATE / 2);
  mix.stop(2);
  mix.setPitch(0, 0);
  mix.mix(left, right, RATE / 2, RATE);
  const output = new Float32Array(RATE * 2);
  output.set(left);
  output.set(right, RATE);
  return output;
};

export const scenarios: Readonly<
  Record<string, (modules: Modules) => ArrayBufferView>
> = {
  'sonix-filter-bank': filterBank,
  'sonix-mixer': mixer,
  'sonix-wave-ticks': waveTicks,
  'ym2149-envelopes': ymEnvelopes,
  'ym2149-song': ymSong,
};
