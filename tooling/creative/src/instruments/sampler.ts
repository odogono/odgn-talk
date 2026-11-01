// The sampler Instrument kind (#1894): plays the Project's sounds and the
// built-in kits at a pitch or speed, gain and pan. A Script names the sound;
// a note other than middle C plays it higher or lower.
import type { Chip } from '../audio/chip-host';
import {
  parameterStore,
  type InstrumentCommand,
  type InstrumentEngine,
  type InstrumentSetup,
  type SampleBuffer,
} from './kind';
import { panGains } from './notes';
import { allocate, type Voice } from './voices';

/** The note that plays a sound at its recorded pitch. */
export const ROOT_NOTE = 60;

// A released sound fades over this long instead of stopping with a click.
const RELEASE_SECONDS = 0.01;

const parameters = {
  speed: {
    shape: 'number',
    min: 0.0625,
    max: 16,
    default: 1,
    description:
      'Playback speed, which also sets the pitch: 2 is an octave up, 0.5 an octave down.',
  },
  gain: {
    shape: 'number',
    min: 0,
    max: 1,
    default: 0.8,
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

type SamplerVoice = Voice & {
  buffer: SampleBuffer | undefined;
  fade: number;
  position: number;
  rate: number;
  velocity: number;
};

const chip = (setup: InstrumentSetup): Chip<InstrumentCommand> => {
  const { sampleRate, samples } = setup;
  const values = parameterStore(samplerEngine, setup.parameters);
  const fadeStep = 1 / (RELEASE_SECONDS * sampleRate);
  let started = 0;
  const voices: SamplerVoice[] = Array.from({ length: setup.voices }, () => ({
    active: false,
    age: 0,
    buffer: undefined,
    fade: 0,
    note: 0,
    position: 0,
    rate: 0,
    velocity: 0,
  }));
  const releaseWhere = (match: (voice: SamplerVoice) => boolean) => {
    for (const voice of voices) {
      if (voice.active && match(voice)) {
        voice.fade = fadeStep;
      }
    }
  };

  return {
    apply: command => {
      switch (command.kind) {
        case 'note': {
          const buffer =
            command.sound === undefined
              ? undefined
              : samples.get(command.sound);
          if (!buffer?.channels[0]?.length) {
            return;
          }
          const voice = allocate(voices);
          voice.active = true;
          voice.age = ++started;
          voice.buffer = buffer;
          voice.fade = 0;
          voice.note = command.note;
          voice.position = 0;
          voice.rate =
            (buffer.sampleRate / sampleRate) *
            2 ** ((command.note - ROOT_NOTE) / 12);
          voice.velocity = Math.max(0, Math.min(1, command.velocity));
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
      const speed = values.number('speed');
      const gain = values.number('gain');
      const [panLeft, panRight] = panGains(values.number('pan'));
      for (const voice of voices) {
        const buffer = voice.buffer;
        if (!voice.active || !buffer) {
          continue;
        }
        const first = buffer.channels[0]!;
        const second = buffer.channels[1] ?? first;
        const length = first.length;
        let level = 1;
        for (let frame = 0; frame < frames; frame++) {
          const index = Math.floor(voice.position);
          if (index >= length) {
            voice.active = false;
            break;
          }
          if (voice.fade > 0) {
            level = 1 - voice.fade;
            voice.fade += fadeStep;
            if (level <= 0) {
              voice.active = false;
              break;
            }
          }
          // Linear interpolation between neighbouring samples.
          const t = voice.position - index;
          const next = Math.min(index + 1, length - 1);
          const l = first[index]! + (first[next]! - first[index]!) * t;
          const r = second[index]! + (second[next]! - second[index]!) * t;
          const scale = voice.velocity * gain * level;
          output[frame * 2]! += l * scale * panLeft;
          output[frame * 2 + 1]! += r * scale * panRight;
          voice.position += voice.rate * speed;
        }
      }
      return output;
    },
    reset: () => {
      for (const voice of voices) {
        voice.active = false;
        voice.buffer = undefined;
      }
    },
  };
};

export const samplerEngine: InstrumentEngine = {
  name: 'sampler',
  description:
    "A sampler: plays the Project's sounds and the built-in kits, at a pitch or speed.",
  maxVoices: 32,
  voices: 16,
  parameters,
  chip,
};
