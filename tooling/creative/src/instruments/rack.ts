// Every Instrument of a Play Session, mixed (#1894). The AudioWorklet runs
// one rack; tests render it offline. Each Instrument's Chip sits behind its
// own ChipHost, so a command lands on its own sample.
import { ChipHost } from '../audio/chip-host';
import type { Instrument } from '../model';
import type { InstrumentCommand, SampleBuffer } from './kind';
import { INSTRUMENT_ENGINES } from './engines';
import { workletEngine } from './worklet-engines';
import type { InstrumentMessage } from './session';

/** The worklet processor's registered name. */
export const INSTRUMENT_PROCESSOR = 'folio-instruments';

/**
 * What the page posts the worklet: the port the Play worker sends on, or
 * a sound decoded after the rack started (#1958).
 */
export type InstrumentChannel =
  | { port: MessagePort }
  | { name: string; sample: SampleBuffer }
  /** A bound control's change, straight from the page (#1904). */
  | { message: InstrumentMessage };

/** How often the worklet reports output levels for meters, in seconds. */
export const LEVEL_INTERVAL = 1 / 30;

/** Each Instrument's peak output since the last report, from 0 to 1. */
export type LevelReport = { levels: Record<string, number> };

/** What a rack is built from; plain data, so it crosses to the worklet. */
export type RackSetup = {
  readonly instruments: readonly Pick<
    Instrument,
    'kind' | 'name' | 'parameters' | 'voices'
  >[];
  /** Decoded sounds by name, for samplers. */
  readonly samples: readonly (readonly [string, SampleBuffer])[];
};

/** A note as it started, at its time on the audio clock; for tests. */
export type NoteOnset = {
  readonly instrument: string;
  readonly note: number;
  readonly time: number;
};

export class InstrumentRack {
  readonly #hosts = new Map<string, ChipHost<InstrumentCommand>>();
  /** Each Instrument's peak since `levels` was last read (#1904). */
  readonly #peaks = new Map<string, number>();
  /** Shared with every sampler, so a sound added later plays at once. */
  readonly #samples: Map<string, SampleBuffer>;

  constructor(
    setup: RackSetup,
    sampleRate: number,
    onNote?: (onset: NoteOnset) => void,
  ) {
    const samples = new Map(setup.samples);
    this.#samples = samples;
    for (const instrument of setup.instruments) {
      const kind =
        INSTRUMENT_ENGINES.get(instrument.kind) ??
        workletEngine(instrument.kind);
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
        new ChipHost(
          chip,
          sampleRate,
          instrument.name,
          onNote &&
            ((command, time) => {
              if (command.kind === 'note') {
                onNote({
                  instrument: instrument.name,
                  note: command.note,
                  time,
                });
              }
            }),
        ),
      );
    }
  }

  /** Adds a decoded sound for samplers to play from the next note on. */
  addSample(name: string, sample: SampleBuffer): void {
    this.#samples.set(name, sample);
  }

  /** Commands play at `at` on the audio clock, or at the next sample. */
  receive(message: InstrumentMessage): void {
    this.#hosts.get(message.instrument)?.receive({
      at: message.at ?? 0,
      commands: message.commands,
    });
  }

  /** Fills `left` and `right` with every Instrument's sound, summed. */
  process(left: Float32Array, right: Float32Array, currentTime: number): void {
    left.fill(0);
    right.fill(0);
    const frames = Math.min(left.length, right.length);
    const buffer = new Float32Array(frames * 2);
    for (const [name, host] of this.#hosts) {
      host.process(buffer, currentTime);
      let peak = this.#peaks.get(name) ?? 0;
      for (let frame = 0; frame < frames; frame++) {
        const l = buffer[frame * 2]!;
        const r = buffer[frame * 2 + 1]!;
        left[frame]! += l;
        right[frame]! += r;
        peak = Math.max(peak, Math.abs(l), Math.abs(r));
      }
      this.#peaks.set(name, peak);
    }
  }

  /** Each Instrument's peak output since last asked, from 0 to 1. */
  levels(): Record<string, number> {
    const levels: Record<string, number> = {};
    for (const [name, peak] of this.#peaks) {
      levels[name] = Math.min(1, peak);
      this.#peaks.set(name, 0);
    }
    return levels;
  }
}
