// The basic synth Instrument kind (#1894): one oscillator per voice, an
// amplitude envelope and a resonant low-pass filter.
import type { Chip } from '../audio/chip-host';
import {
  parameterStore,
  type InstrumentCommand,
  type InstrumentEngine,
  type InstrumentSetup,
} from './kind';
import { noteFrequency, panGains } from './notes';
import { allocate, type Voice } from './voices';

const WAVEFORMS = ['sine', 'triangle', 'saw', 'square'] as const;
type Waveform = (typeof WAVEFORMS)[number];

const parameters = {
  waveform: {
    shape: 'text',
    choices: WAVEFORMS,
    default: 'saw',
    description: 'The oscillator: sine, triangle, saw or square.',
  },
  attack: {
    shape: 'number',
    min: 0,
    max: 10,
    default: 0.005,
    description: 'Seconds the envelope takes to rise to full.',
  },
  decay: {
    shape: 'number',
    min: 0,
    max: 10,
    default: 0.1,
    description: 'Seconds the envelope takes to fall to the sustain level.',
  },
  sustain: {
    shape: 'number',
    min: 0,
    max: 1,
    default: 0.7,
    description: 'The level a held note stays at, from 0 to 1.',
  },
  release: {
    shape: 'number',
    min: 0,
    max: 10,
    default: 0.2,
    description: 'Seconds a released note takes to fade out.',
  },
  cutoff: {
    shape: 'number',
    min: 20,
    max: 20_000,
    default: 4000,
    description: "The low-pass filter's cutoff, in hertz.",
  },
  resonance: {
    shape: 'number',
    min: 0,
    max: 1,
    default: 0.1,
    description: "The filter's resonance, from 0 to 1.",
  },
  gain: {
    shape: 'number',
    min: 0,
    max: 1,
    default: 0.5,
    description: 'Output level, from 0 to 1.',
  },
  pan: {
    shape: 'number',
    min: -1,
    max: 1,
    default: 0,
    description: 'Stereo position, from -1 (left) to 1 (right).',
  },
} as const;

type Stage = 'attack' | 'decay' | 'sustain' | 'release';

// `band` and `low` are the filter's two integrator states.
type SynthVoice = Voice & {
  band: number;
  increment: number;
  level: number;
  low: number;
  phase: number;
  stage: Stage;
  velocity: number;
};

// A PolyBLEP correction, which takes most of the aliasing out of the saw and
// square's steps.
const blep = (phase: number, increment: number): number => {
  if (phase < increment) {
    const t = phase / increment;
    return t + t - t * t - 1;
  }
  if (phase > 1 - increment) {
    const t = (phase - 1) / increment;
    return t * t + t + t + 1;
  }
  return 0;
};

const oscillator = (waveform: Waveform, voice: SynthVoice): number => {
  const { phase, increment } = voice;
  switch (waveform) {
    case 'sine':
      return Math.sin(2 * Math.PI * phase);
    case 'triangle':
      return 1 - 4 * Math.abs(phase - 0.5);
    case 'saw':
      return 2 * phase - 1 - blep(phase, increment);
    case 'square':
      return (
        (phase < 0.5 ? 1 : -1) +
        blep(phase, increment) -
        blep((phase + 0.5) % 1, increment)
      );
  }
};

const chip = (setup: InstrumentSetup): Chip<InstrumentCommand> => {
  const { sampleRate } = setup;
  const values = parameterStore(synthEngine, setup.parameters);
  let started = 0;
  const voices: SynthVoice[] = Array.from({ length: setup.voices }, () => ({
    active: false,
    age: 0,
    band: 0,
    increment: 0,
    level: 0,
    low: 0,
    note: 0,
    phase: 0,
    stage: 'release',
    velocity: 0,
  }));
  // Per-sample envelope steps: linear rises and falls over the set times.
  const step = (seconds: number) =>
    seconds <= 0 ? 1 : 1 / (seconds * sampleRate);
  const releaseWhere = (match: (voice: SynthVoice) => boolean) => {
    for (const voice of voices) {
      if (voice.active && match(voice)) {
        voice.stage = 'release';
      }
    }
  };

  return {
    apply: command => {
      switch (command.kind) {
        case 'note': {
          const voice = allocate(voices);
          voice.active = true;
          voice.age = ++started;
          voice.note = command.note;
          voice.velocity = Math.max(0, Math.min(1, command.velocity));
          voice.increment = noteFrequency(command.note) / sampleRate;
          voice.stage = 'attack';
          // A stolen voice keeps its phase, level and filter, so it never clicks.
          break;
        }
        case 'release':
          releaseWhere(voice => voice.note === command.note);
          break;
        case 'stop':
          releaseWhere(() => true);
          break;
        case 'set':
          values.set(command.parameter, command.value);
          break;
      }
    },
    channels: 2,
    render: count => {
      const frames = Math.max(0, count);
      const output = new Float32Array(frames * 2);
      const waveform = values.text('waveform') as Waveform;
      const attack = step(values.number('attack'));
      const decay = step(values.number('decay'));
      const release = step(values.number('release'));
      const sustain = values.number('sustain');
      // A topology-preserving state-variable low-pass (Zavalishin), stable
      // at every cutoff and resonance.
      const g = Math.tan(
        (Math.PI * Math.min(values.number('cutoff'), sampleRate * 0.49)) /
          sampleRate,
      );
      const k = 2 - 1.96 * values.number('resonance');
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;
      const [left, right] = panGains(values.number('pan'));
      const gain = values.number('gain');
      for (const voice of voices) {
        if (!voice.active) {
          continue;
        }
        for (let frame = 0; frame < frames; frame++) {
          switch (voice.stage) {
            case 'attack':
              voice.level += attack;
              if (voice.level >= 1) {
                voice.level = 1;
                voice.stage = 'decay';
              }
              break;
            case 'decay':
              voice.level -= decay * (1 - sustain);
              if (voice.level <= sustain) {
                voice.level = sustain;
                voice.stage = 'sustain';
              }
              break;
            case 'sustain':
              voice.level = sustain;
              break;
            case 'release':
              voice.level -= release;
              break;
          }
          if (voice.level <= 0 && voice.stage === 'release') {
            voice.level = 0;
            voice.active = false;
            voice.low = 0;
            voice.band = 0;
            break;
          }
          const input = oscillator(waveform, voice);
          voice.phase = (voice.phase + voice.increment) % 1;
          const v3 = input - voice.low;
          const v1 = a1 * voice.band + a2 * v3;
          const v2 = voice.low + a2 * voice.band + a3 * v3;
          voice.band = 2 * v1 - voice.band;
          voice.low = 2 * v2 - voice.low;
          const sample = v2 * voice.level * voice.velocity * gain;
          output[frame * 2]! += sample * left;
          output[frame * 2 + 1]! += sample * right;
        }
      }
      return output;
    },
    reset: () => {
      for (const voice of voices) {
        voice.active = false;
        voice.level = 0;
        voice.low = 0;
        voice.band = 0;
        voice.phase = 0;
      }
    },
  };
};

export const synthEngine: InstrumentEngine = {
  name: 'synth',
  description:
    'A basic synth: an oscillator, an amplitude envelope and a low-pass filter for each voice.',
  maxVoices: 16,
  voices: 8,
  parameters,
  chip,
};
