// Every Instrument of a Play Session, mixed (#1894). The AudioWorklet runs
// one rack; tests render it offline. Each Instrument's Chip sits behind its
// own ChipHost, so a command lands on its own sample.
import { ChipHost } from '../audio/chip-host';
import type { Instrument } from '../model';
import type { InstrumentCommand, SampleBuffer } from './kind';
import { INSTRUMENT_ENGINES } from './engines';
import type { InstrumentMessage } from './session';

/** The worklet processor's registered name. */
export const INSTRUMENT_PROCESSOR = 'folio-instruments';

/** What a rack is built from; plain data, so it crosses to the worklet. */
export type RackSetup = {
  readonly instruments: readonly Pick<
    Instrument,
    'kind' | 'name' | 'parameters' | 'voices'
  >[];
  /** Decoded sounds by name, for samplers. */
  readonly samples: readonly (readonly [string, SampleBuffer])[];
};

export class InstrumentRack {
  readonly #hosts = new Map<string, ChipHost<InstrumentCommand>>();

  constructor(setup: RackSetup, sampleRate: number) {
    const samples = new Map(setup.samples);
    for (const instrument of setup.instruments) {
      const kind = INSTRUMENT_ENGINES.get(instrument.kind);
      if (!kind) {
        continue;
      }
      const chip = kind.chip({
        parameters: instrument.parameters,
        sampleRate,
        samples,
        voices: Math.min(instrument.voices, kind.maxVoices),
      });
      this.#hosts.set(
        instrument.name,
        new ChipHost(chip, sampleRate, instrument.name),
      );
    }
  }

  /** Commands play at the next sample rendered. */
  receive(message: InstrumentMessage): void {
    this.#hosts.get(message.instrument)?.receive({
      at: 0,
      commands: message.commands,
    });
  }

  /** Fills `left` and `right` with every Instrument's sound, summed. */
  process(left: Float32Array, right: Float32Array, currentTime: number): void {
    left.fill(0);
    right.fill(0);
    const frames = Math.min(left.length, right.length);
    const buffer = new Float32Array(frames * 2);
    for (const host of this.#hosts.values()) {
      host.process(buffer, currentTime);
      for (let frame = 0; frame < frames; frame++) {
        left[frame]! += buffer[frame * 2]!;
        right[frame]! += buffer[frame * 2 + 1]!;
      }
    }
  }
}
