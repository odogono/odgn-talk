// Copied from odogono/mercenary web/src/sound/ym2149.ts at
// a04a7a9f2b7b4097d223c0f1c11cd963019f7e32 (#1889). Changed: it no longer
// implements Mercenary's `Chip`; `ym2149Engine` below drives it from a ChipHost.

import type { Engine } from './engine';

/// The Atari ST's YM2149 at the register level, for Damocles (#508).
///
/// A project-owned model shared by the live AudioWorklet and deterministic offline tests. It
/// runs the chip's own counters at a quarter-million ticks a second and averages them into each
/// output sample, so a period written by a recovered programme sounds at the pitch the chip
/// would give it. The output stage is an approximation: the level table is the 1.5 dB ladder
/// the datasheet describes rather than a measured one, and the three channels are summed
/// linearly. After them come the STF's C10 low-pass, whose corner depends on whether the chip
/// is pulling the output up or letting R8 pull it down, and a DC blocker for the ST's coupling
/// capacitor. The low-pass corners are the STF schematic's as Hatari's `sound.c` derives them.

/// The ST clocks its YM2149 at 2 MHz.
export const YM_CLOCK_HERTZ = 2_000_000;
/// Tone, noise and envelope counters all advance at the clock over 8.
const TICK_HERTZ = YM_CLOCK_HERTZ / 8;

/// The STF C10 low-pass corners: 0.1 µF against 206.9 Ω while the YM2149 pulls up and 759.1 Ω
/// while R8 pulls down.
const PULL_UP_HERTZ = 7693.7;
const PULL_DOWN_HERTZ = 2096.6;

/// A first-order bilinear low-pass at `corner`, as `[b, a]` for y = b(x + x') − a·y'.
const lowPass = (
  corner: number,
  sampleRate: number,
): readonly [number, number] => {
  const angular = 2 * Math.PI * corner;
  const warp = angular / Math.tan(angular / 2 / sampleRate);
  return [angular / (warp + angular), (angular - warp) / (warp + angular)];
};

/// The 32-step output ladder, 1.5 dB a step, silent at the bottom.
const LEVELS = Array.from({ length: 32 }, (_, step) =>
  step === 0 ? 0 : 2 ** ((step - 31) / 4),
);

/// Sets the loudest the port plays near Hatari's `model` mixing of the same programmes: the
/// shared effect's first 50 ms at −12 dB in its band and the door tone's level 13 at −23 dB,
/// both within about a decibel (docs/research/damocles-lift-ride.md#heard-in-the-working-authority).
const OUTPUT_GAIN = 0.55;

type ToneState = {
  counter: number;
  output: number;
};

/// The mixer's disable bits: tone A–C in bits 0–2, noise A–C in bits 3–5. Active low.
const toneDisabled = (mixer: number, channel: number): boolean =>
  (mixer & (1 << channel)) !== 0;
const noiseDisabled = (mixer: number, channel: number): boolean =>
  (mixer & (8 << channel)) !== 0;

export class Ym2149 {
  private readonly registers = new Uint8Array(16);
  private readonly tones: ToneState[] = [
    { counter: 0, output: 0 },
    { counter: 0, output: 0 },
    { counter: 0, output: 0 },
  ];
  private noiseCounter = 0;
  private noisePrescale = 0;
  private noiseShift = 1;
  private envelopeCounter = 0;
  private envelopeStep = 0;
  private envelopeAttack = false;
  private envelopeHold: number | undefined = 0;
  private tickCarry = 0;
  private filterInput = 0;
  private filterOutput = 0;
  private dcInput = 0;
  private dcOutput = 0;
  private readonly ticksPerSample: number;
  private readonly dcPole: number;
  private readonly pullUp: readonly [number, number];
  private readonly pullDown: readonly [number, number];

  constructor(readonly sampleRate: number) {
    this.ticksPerSample = TICK_HERTZ / sampleRate;
    // About 20 Hz: below the lowest tone Damocles plays, above anything a speaker holds.
    this.dcPole = Math.exp((-2 * Math.PI * 20) / sampleRate);
    this.pullUp = lowPass(PULL_UP_HERTZ, sampleRate);
    this.pullDown = lowPass(PULL_DOWN_HERTZ, sampleRate);
    this.registers[7] = 0xff;
  }

  /// One register write, as the 68000's `move.b` to `$FF8802` after selecting it at `$FF8800`.
  write(register: number, value: number): void {
    if (!Number.isInteger(register) || register < 0 || register > 13) {
      throw new Error(`YM2149 register ${register} is out of range`);
    }
    this.registers[register] = value & 0xff;
    if (register === 13) {
      // Writing the shape restarts the envelope.
      this.envelopeAttack = (value & 4) !== 0;
      this.envelopeStep = 0;
      this.envelopeCounter = 0;
      this.envelopeHold = undefined;
    }
  }

  register(register: number): number {
    return this.registers[register] ?? 0;
  }

  /// Silence every channel and return the counters to power-on.
  reset(): void {
    this.registers.fill(0);
    this.registers[7] = 0xff;
    for (const tone of this.tones) {
      tone.counter = 0;
      tone.output = 0;
    }
    this.noiseCounter = 0;
    this.noisePrescale = 0;
    this.noiseShift = 1;
    this.envelopeCounter = 0;
    this.envelopeStep = 0;
    this.envelopeAttack = false;
    this.envelopeHold = 0;
    this.tickCarry = 0;
    this.filterInput = 0;
    this.filterOutput = 0;
    this.dcInput = 0;
    this.dcOutput = 0;
  }

  render(count: number): Float32Array {
    const samples = new Float32Array(Math.max(0, count));
    for (let index = 0; index < samples.length; index += 1) {
      this.tickCarry += this.ticksPerSample;
      const ticks = Math.floor(this.tickCarry);
      this.tickCarry -= ticks;
      let sum = 0;
      for (let tick = 0; tick < ticks; tick += 1) {
        this.tick();
        sum += this.output();
      }
      const level = ticks === 0 ? this.output() : sum / ticks;
      const [b, a] = level >= this.filterOutput ? this.pullUp : this.pullDown;
      const filtered = b * (level + this.filterInput) - a * this.filterOutput;
      this.filterInput = level;
      this.filterOutput = filtered;
      // One-pole DC blocker: the chip's output never swings below zero.
      this.dcOutput = filtered - this.dcInput + this.dcPole * this.dcOutput;
      this.dcInput = filtered;
      samples[index] = this.dcOutput * OUTPUT_GAIN;
    }
    return samples;
  }

  private tick(): void {
    const registers = this.registers;
    for (let channel = 0; channel < 3; channel += 1) {
      const tone = this.tones[channel]!;
      const period =
        registers[channel * 2]! | ((registers[channel * 2 + 1]! & 0x0f) << 8) ||
        1;
      tone.counter += 1;
      if (tone.counter >= period) {
        tone.counter = 0;
        tone.output ^= 1;
      }
    }
    // The noise generator shifts at half the tone rate: 17 bits, taps 0 and 3.
    this.noisePrescale ^= 1;
    if (this.noisePrescale === 0) {
      this.noiseCounter += 1;
      if (this.noiseCounter >= (registers[6]! & 0x1f || 1)) {
        this.noiseCounter = 0;
        const bit = (this.noiseShift ^ (this.noiseShift >> 3)) & 1;
        this.noiseShift = (this.noiseShift >> 1) | (bit << 16);
      }
    }
    this.envelopeCounter += 1;
    if (this.envelopeCounter >= (registers[11]! | (registers[12]! << 8) || 1)) {
      this.envelopeCounter = 0;
      this.stepEnvelope();
    }
  }

  /// Shapes are CONT, ATT, ALT, HOLD in bits 3–0. A cycle is 32 steps.
  private stepEnvelope(): void {
    if (this.envelopeHold !== undefined) {
      return;
    }
    this.envelopeStep += 1;
    if (this.envelopeStep < 32) {
      return;
    }
    const shape = this.registers[13]!;
    const ended = this.envelopeAttack ? 31 : 0;
    if ((shape & 8) === 0) {
      this.envelopeHold = 0;
    } else if ((shape & 1) !== 0) {
      this.envelopeHold = (shape & 2) !== 0 ? 31 - ended : ended;
    } else {
      if ((shape & 2) !== 0) {
        this.envelopeAttack = !this.envelopeAttack;
      }
      this.envelopeStep = 0;
    }
  }

  private envelopeLevel(): number {
    if (this.envelopeHold !== undefined) {
      return this.envelopeHold;
    }
    return this.envelopeAttack ? this.envelopeStep : 31 - this.envelopeStep;
  }

  private output(): number {
    const registers = this.registers;
    const mixer = registers[7]!;
    const noise = this.noiseShift & 1;
    let sum = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const gate =
        (toneDisabled(mixer, channel) || this.tones[channel]!.output === 1) &&
        (noiseDisabled(mixer, channel) || noise === 1);
      if (!gate) {
        continue;
      }
      const amplitude = registers[8 + channel]!;
      // A fixed level of N is the ladder's step 2N + 1; zero stays silent.
      const step =
        (amplitude & 0x10) !== 0
          ? this.envelopeLevel()
          : (amplitude & 0x0f) === 0
            ? 0
            : (amplitude & 0x0f) * 2 + 1;
      sum += LEVELS[step]!;
    }
    return sum;
  }
}

/// Commands for a YM2149: a register write, or a reset to power-on.
export type Ym2149Command =
  | { readonly kind: 'reset' }
  | {
      readonly kind: 'write';
      readonly register: number;
      readonly value: number;
    };

/// A YM2149 as an Engine, mono, driven by register writes.
export const ym2149Engine = (
  sampleRate: number,
  chip = new Ym2149(sampleRate),
): Engine<Ym2149Command> => ({
  apply: command => {
    if (command.kind === 'write') {
      chip.write(command.register, command.value);
    }
  },
  channels: 1,
  render: count => chip.render(count),
  reset: () => chip.reset(),
});
