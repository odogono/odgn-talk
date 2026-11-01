// The Sonix waveform synth as a Chip (#1889): the 128-sample wavetable,
// its 64-band filter bank and per-octave decimation from synth.ts, played on
// the four-voice mixer from mixer.ts. New for Folio; it follows the Sonix
// driver's synthesised-note path (wime's engine.ts synthRenderTick and
// synthPitchTick) without envelopes, slides, blends or the score engine.

import type { Chip } from '../chip-host';
import { createMixer } from './mixer';
import {
  buildFilterBank,
  decimationShift,
  FILTER_BANDS,
  renderWave,
  WAVE_LENGTH,
} from './synth';
import { PAULA_CLOCK_PAL, synthPeriod } from './tables';

export type WaveSynthVoice = 0 | 1 | 2 | 3;

export type WaveSynthCommand =
  | { readonly kind: 'reset' }
  /// A voice's waveform: 128 signed 8-bit samples.
  | {
      readonly kind: 'wave';
      readonly voice: WaveSynthVoice;
      readonly wave: Int8Array;
    }
  /// Starts a note, a MIDI number from 36 to 107, at `band` of the filter
  /// bank (0 brightest, 63 darkest) and `volume` from 0 to 1.
  | {
      readonly band?: number;
      readonly kind: 'note';
      readonly note: number;
      readonly voice: WaveSynthVoice;
      readonly volume?: number;
    }
  | { readonly kind: 'stop'; readonly voice: WaveSynthVoice };

const VOICES = 4;

/// Four synth voices, stereo as the Amiga's: voices 0 and 3 left, 1 and 2 right.
export const waveSynthChip = (sampleRate: number): Chip<WaveSynthCommand> => {
  const mixer = createMixer(sampleRate);
  const banks: (Int8Array | undefined)[] = Array.from({ length: VOICES });
  const silence = () => {
    for (let voice = 0; voice < VOICES; voice++) {
      mixer.stop(voice);
      banks[voice] = undefined;
    }
  };

  const startNote = (
    voice: WaveSynthVoice,
    note: number,
    band: number,
    volume: number,
  ) => {
    const bank = banks[voice];
    if (bank === undefined) {
      return;
    }
    const index = Math.max(0, Math.min(FILTER_BANDS - 1, Math.round(band)));
    const wave = bank.subarray(index * WAVE_LENGTH, (index + 1) * WAVE_LENGTH);
    const period = synthPeriod(note);
    const shift = decimationShift(period);
    const buffer = new Int8Array(WAVE_LENGTH);
    renderWave(buffer, wave, 0, shift, 0, 0, 0, {
      accumulator: 0,
      direction: 1,
    });
    const length = WAVE_LENGTH >> shift;
    mixer.play(voice, {
      data: buffer,
      length,
      loopLength: length,
      loopStart: 0,
    });
    mixer.setPitch(voice, PAULA_CLOCK_PAL / (period >> (5 - shift) || 1));
    mixer.setVolume(voice, Math.max(0, Math.min(1, volume)));
  };

  return {
    apply: command => {
      switch (command.kind) {
        case 'wave':
          if (command.wave.length !== WAVE_LENGTH) {
            throw new Error(`a wave holds ${WAVE_LENGTH} samples`);
          }
          banks[command.voice] = buildFilterBank(command.wave);
          break;
        case 'note':
          startNote(
            command.voice,
            command.note,
            command.band ?? 0,
            command.volume ?? 1,
          );
          break;
        case 'stop':
          mixer.stop(command.voice);
          break;
      }
    },
    channels: 2,
    render: count => {
      const frames = Math.max(0, count);
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      mixer.mix(left, right, 0, frames);
      const output = new Float32Array(frames * 2);
      for (let frame = 0; frame < frames; frame++) {
        output[frame * 2] = left[frame]!;
        output[frame * 2 + 1] = right[frame]!;
      }
      return output;
    },
    reset: silence,
  };
};
