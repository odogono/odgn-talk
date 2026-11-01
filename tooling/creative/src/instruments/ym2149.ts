// The YM2149 Instrument kind (#1894): the Atari ST's sound chip, with one
// voice per tone channel, its envelope and its noise.
import type { Chip } from '../audio/chip-host';
import { Ym2149, YM_CLOCK_HERTZ } from '../audio/ym2149';
import {
  parameterStore,
  type InstrumentCommand,
  type InstrumentEngine,
  type InstrumentSetup,
} from './kind';
import { noteFrequency, panGains } from './notes';
import { allocate, type Voice } from './voices';

const parameters = {
  tone: {
    shape: 'boolean',
    default: true,
    description: 'Whether each voice plays its square-wave tone.',
  },
  noise: {
    shape: 'boolean',
    default: false,
    description: "Whether each voice plays the chip's noise.",
  },
  noisePeriod: {
    shape: 'number',
    min: 0,
    max: 31,
    whole: true,
    default: 16,
    description: 'The noise period, 0 (brightest) to 31.',
  },
  volume: {
    shape: 'number',
    min: 0,
    max: 15,
    whole: true,
    default: 13,
    description:
      "A note's level at full velocity, 0 to 15, without the envelope.",
  },
  envelope: {
    shape: 'boolean',
    default: false,
    description:
      "Whether notes follow the chip's envelope instead of a fixed volume.",
  },
  envelopeShape: {
    shape: 'number',
    min: 0,
    max: 15,
    whole: true,
    default: 9,
    description:
      'The envelope shape, 0 to 15, as the chip numbers them; 9 decays once and stays silent.',
  },
  envelopePeriod: {
    shape: 'number',
    min: 1,
    max: 65_535,
    whole: true,
    default: 3000,
    description: 'The envelope period, in 256-cycle steps of the 2 MHz clock.',
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

/** The tone period the chip needs for a note, clamped to its 12 bits. */
export const tonePeriod = (note: number): number =>
  Math.max(
    1,
    Math.min(4095, Math.round(YM_CLOCK_HERTZ / 16 / noteFrequency(note))),
  );

type Channel = Voice & { index: number };

const chip = (setup: InstrumentSetup): Chip<InstrumentCommand> => {
  const ym = new Ym2149(setup.sampleRate);
  const values = parameterStore(ym2149Engine, setup.parameters);
  const channels: Channel[] = Array.from(
    { length: setup.voices },
    (_, index) => ({
      active: false,
      age: 0,
      index,
      note: 0,
    }),
  );
  let started = 0;
  const velocities = [0, 0, 0];

  // The mixer and noise registers follow the parameters.
  const writeMixer = () => {
    let mixer = 0xff;
    for (const channel of channels) {
      if (values.flag('tone')) {
        mixer &= ~(1 << channel.index);
      }
      if (values.flag('noise')) {
        mixer &= ~(8 << channel.index);
      }
    }
    ym.write(7, mixer & 0x3f);
    ym.write(6, values.number('noisePeriod'));
  };
  const writeLevel = (channel: Channel) => {
    const level = channel.active
      ? values.flag('envelope')
        ? 0x10
        : Math.round(values.number('volume') * velocities[channel.index]!)
      : 0;
    ym.write(8 + channel.index, level);
  };
  const silence = (match: (channel: Channel) => boolean) => {
    for (const channel of channels) {
      if (channel.active && match(channel)) {
        channel.active = false;
        writeLevel(channel);
      }
    }
  };
  writeMixer();

  return {
    apply: command => {
      switch (command.kind) {
        case 'note': {
          const channel = allocate(channels);
          channel.active = true;
          channel.age = ++started;
          channel.note = command.note;
          velocities[channel.index] = Math.max(
            0,
            Math.min(1, command.velocity),
          );
          const period = tonePeriod(command.note);
          ym.write(channel.index * 2, period & 0xff);
          ym.write(channel.index * 2 + 1, period >> 8);
          writeLevel(channel);
          if (values.flag('envelope')) {
            const envelope = values.number('envelopePeriod');
            ym.write(11, envelope & 0xff);
            ym.write(12, envelope >> 8);
            // Writing the shape restarts the envelope for the new note.
            ym.write(13, values.number('envelopeShape'));
          }
          break;
        }
        case 'release':
          silence(channel => channel.note === command.note);
          break;
        case 'stop':
          silence(() => true);
          break;
        case 'set':
          if (values.set(command.parameter, command.value)) {
            writeMixer();
            for (const channel of channels) {
              writeLevel(channel);
            }
          }
          break;
      }
    },
    channels: 2,
    render: count => {
      const mono = ym.render(count);
      const [left, right] = panGains(values.number('pan'));
      const gain = values.number('gain');
      const output = new Float32Array(mono.length * 2);
      for (let frame = 0; frame < mono.length; frame++) {
        output[frame * 2] = mono[frame]! * gain * left;
        output[frame * 2 + 1] = mono[frame]! * gain * right;
      }
      return output;
    },
    reset: () => {
      ym.reset();
      for (const channel of channels) {
        channel.active = false;
      }
      writeMixer();
    },
  };
};

export const ym2149Engine: InstrumentEngine = {
  name: 'ym2149',
  description:
    "The Atari ST's YM2149 sound chip: three square-wave voices, noise and a shared envelope.",
  maxVoices: 3,
  voices: 3,
  parameters,
  chip,
};
