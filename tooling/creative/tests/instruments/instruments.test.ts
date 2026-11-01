import { describe, expect, test } from 'bun:test';
import { renderOffline, type SoundBatch } from '../../src/audio/chip-host';
import {
  defaultParameters,
  type InstrumentCommand,
  type InstrumentEngine,
  type SampleBuffer,
} from '../../src/instruments/kind';
import { noteFrequency, noteNumber } from '../../src/instruments/notes';
import {
  createInstrument,
  INSTRUMENT_KINDS,
  instrumentProblems,
  SESSION_VOICES,
} from '../../src/instruments/registry';
import { samplerEngine } from '../../src/instruments/sampler';
import { synthEngine } from '../../src/instruments/synth';
import { tonePeriod, ym2149Engine } from '../../src/instruments/ym2149';
import { createProject } from '../../src/model';
import {
  migrateProjectJson,
  readProjectFile,
  serializeProject,
  validateProjectJson,
  writeProjectFile,
} from '../../src/project-file';

const RATE = 44_100;

const render = (
  kind: InstrumentEngine,
  seconds: number,
  batches: SoundBatch<InstrumentCommand>[],
  options: {
    parameters?: Record<string, number | string | boolean>;
    samples?: Map<string, SampleBuffer>;
    voices?: number;
  } = {},
) =>
  renderOffline(
    kind.chip({
      parameters: { ...defaultParameters(kind), ...options.parameters },
      sampleRate: RATE,
      samples: options.samples ?? new Map(),
      voices: options.voices ?? kind.voices,
    }),
    RATE,
    seconds,
    batches,
  );

/** One channel of interleaved stereo, between two times. */
const channel = (
  output: Float32Array,
  side: 0 | 1,
  from = 0,
  to = output.length / 2 / RATE,
) => {
  const start = Math.round(from * RATE);
  const end = Math.round(to * RATE);
  return Float32Array.from(
    { length: end - start },
    (_, i) => output[(start + i) * 2 + side]!,
  );
};

const peak = (samples: Float32Array) =>
  samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);

/** The dominant frequency, from upward zero crossings. */
const pitch = (samples: Float32Array) => {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1]! < 0 && samples[i]! >= 0) {
      crossings++;
    }
  }
  return (crossings * RATE) / samples.length;
};

const note = (
  at: number,
  value: number,
  extra: { sound?: string; velocity?: number } = {},
): SoundBatch<InstrumentCommand> => ({
  at,
  commands: [{ kind: 'note', note: value, velocity: 1, ...extra }],
});

const command = (
  at: number,
  value: InstrumentCommand,
): SoundBatch<InstrumentCommand> => ({ at, commands: [value] });

const sine = (hertz: number, seconds: number): SampleBuffer => ({
  sampleRate: 22_050,
  channels: [
    Float32Array.from({ length: 22_050 * seconds }, (_, i) =>
      Math.sin((2 * Math.PI * hertz * i) / 22_050),
    ),
  ],
});

/** A synth note's peak level through the filter at `cutoff`. */
const energy = (cutoff: number) =>
  peak(
    channel(
      render(synthEngine, 0.3, [note(0, 84)], { parameters: { cutoff } }),
      0,
      0.1,
      0.3,
    ),
  );

describe('notes', () => {
  test('names and numbers become MIDI notes', () => {
    expect(noteNumber('c4')).toBe(60);
    expect(noteNumber('C3')).toBe(48);
    expect(noteNumber('a4')).toBe(69);
    expect(noteNumber('f#4')).toBe(66);
    expect(noteNumber('fs4')).toBe(66);
    expect(noteNumber('eb2')).toBe(39);
    expect(noteNumber('c-1')).toBe(0);
    expect(noteNumber(127)).toBe(127);
    expect(noteNumber(128)).toBeUndefined();
    expect(noteNumber(60.5)).toBeUndefined();
    expect(noteNumber('h2')).toBeUndefined();
    expect(noteNumber('c10')).toBeUndefined();
    expect(noteFrequency(69)).toBe(440);
  });
});

describe('the synth', () => {
  for (const waveform of ['sine', 'triangle', 'saw', 'square']) {
    test(`a ${waveform} note sounds at its pitch`, () => {
      const output = render(synthEngine, 0.5, [note(0, 57)], {
        parameters: { waveform, cutoff: 20_000 },
      });
      const left = channel(output, 0, 0.1, 0.5);
      expect(peak(left)).toBeGreaterThan(0.05);
      expect(Math.abs(pitch(left) - 220)).toBeLessThan(6);
      expect(peak(channel(output, 1, 0.1, 0.5))).toBeCloseTo(peak(left), 5);
    });
  }

  test('a released note fades out over the release time', () => {
    const output = render(synthEngine, 1, [
      note(0, 60),
      command(0.3, { kind: 'release', note: 60 }),
    ]);
    expect(peak(channel(output, 0, 0.2, 0.3))).toBeGreaterThan(0.05);
    expect(peak(channel(output, 0, 0.55, 1))).toBe(0);
  });

  test('the filter cutoff darkens the sound', () => {
    expect(energy(200)).toBeLessThan(energy(10_000) / 4);
  });

  test('pan and gain follow set commands', () => {
    const output = render(synthEngine, 0.6, [
      note(0, 60),
      command(0.2, { kind: 'set', parameter: 'pan', value: 1 }),
      command(0.4, { kind: 'set', parameter: 'gain', value: 0 }),
    ]);
    expect(peak(channel(output, 0, 0.25, 0.4))).toBeLessThan(1e-6);
    expect(peak(channel(output, 1, 0.25, 0.4))).toBeGreaterThan(0.05);
    expect(peak(channel(output, 1, 0.41, 0.6))).toBe(0);
  });

  test('a note beyond the voice cap steals the oldest voice', () => {
    const output = render(
      synthEngine,
      0.6,
      [note(0, 48), note(0.1, 72), command(0.3, { kind: 'release', note: 72 })],
      { voices: 1, parameters: { release: 0.01 } },
    );
    // The first note was stolen, so releasing the second leaves silence.
    expect(peak(channel(output, 0, 0.35, 0.6))).toBe(0);
  });
});

describe('the sampler', () => {
  const samples = new Map([['tone', sine(220, 1)]]);

  test('a sound plays at its recorded pitch on middle C, then ends', () => {
    const output = render(
      samplerEngine,
      1.5,
      [note(0, 60, { sound: 'tone' })],
      {
        samples,
      },
    );
    expect(Math.abs(pitch(channel(output, 0, 0, 0.9)) - 220)).toBeLessThan(3);
    expect(peak(channel(output, 0, 1.01, 1.5))).toBe(0);
  });

  test('a note an octave up and double speed both double the pitch', () => {
    const octave = render(
      samplerEngine,
      0.4,
      [note(0, 72, { sound: 'tone' })],
      {
        samples,
      },
    );
    const fast = render(samplerEngine, 0.4, [note(0, 60, { sound: 'tone' })], {
      samples,
      parameters: { speed: 2 },
    });
    for (const output of [octave, fast]) {
      expect(Math.abs(pitch(channel(output, 0, 0, 0.4)) - 440)).toBeLessThan(5);
    }
  });

  test('an unknown sound or no sound stays silent', () => {
    const output = render(
      samplerEngine,
      0.2,
      [note(0, 60, { sound: 'missing' }), note(0, 60)],
      { samples },
    );
    expect(peak(output)).toBe(0);
  });

  test('stop fades every voice out', () => {
    const output = render(
      samplerEngine,
      0.5,
      [note(0, 60, { sound: 'tone' }), command(0.2, { kind: 'stop' })],
      { samples },
    );
    expect(peak(channel(output, 0, 0.1, 0.2))).toBeGreaterThan(0.5);
    expect(peak(channel(output, 0, 0.22, 0.5))).toBe(0);
  });
});

describe('the YM2149', () => {
  test('a note writes its tone period and sounds at its pitch', () => {
    expect(tonePeriod(69)).toBe(284);
    const output = render(ym2149Engine, 0.5, [note(0, 69)]);
    const left = channel(output, 0, 0.1, 0.5);
    expect(peak(left)).toBeGreaterThan(0.05);
    expect(Math.abs(pitch(left) - 440)).toBeLessThan(10);
  });

  test('three notes take the three channels; release silences one', () => {
    const output = render(ym2149Engine, 0.6, [
      note(0, 60),
      note(0, 64),
      note(0, 67),
      command(0.2, { kind: 'release', note: 64 }),
      command(0.4, { kind: 'stop' }),
    ]);
    const chord = peak(channel(output, 0, 0.1, 0.2));
    const pair = peak(channel(output, 0, 0.25, 0.4));
    expect(pair).toBeGreaterThan(0.05);
    expect(pair).toBeLessThan(chord);
    // The DC blocker leaves a short tail after the last level write.
    expect(peak(channel(output, 0, 0.5, 0.6))).toBeLessThan(0.01);
  });

  test('the envelope decays a note without a release', () => {
    const output = render(ym2149Engine, 0.8, [note(0, 60)], {
      parameters: { envelope: true, envelopeShape: 9, envelopePeriod: 1500 },
    });
    expect(peak(channel(output, 0, 0, 0.1))).toBeGreaterThan(0.05);
    expect(peak(channel(output, 0, 0.6, 0.8))).toBeLessThan(0.01);
  });

  test('noise without tone is not a pitched note', () => {
    const output = render(ym2149Engine, 0.3, [note(0, 69)], {
      parameters: { tone: false, noise: true, noisePeriod: 1 },
    });
    const left = channel(output, 0, 0.05, 0.3);
    expect(peak(left)).toBeGreaterThan(0.05);
    expect(pitch(left)).toBeGreaterThan(2000);
  });
});

describe('the registry', () => {
  test('every kind declares play, release and stop and valid defaults', () => {
    for (const kind of INSTRUMENT_KINDS.values()) {
      expect(Object.keys(kind.operations).sort()).toEqual([
        'play',
        'release',
        'stop',
      ]);
      expect(kind.voices).toBeLessThanOrEqual(kind.maxVoices);
      expect(
        instrumentProblems([createInstrument(kind.name, kind.name)]),
      ).toEqual([]);
    }
  });

  test('bad Instruments are found with their paths', () => {
    const synth = createInstrument('synth', 'lead');
    expect(
      instrumentProblems([
        { ...synth, name: '2lead' },
        { ...synth, name: 'sound' },
        synth,
        { ...synth, voices: 0 },
        { ...synth, name: 'pad', kind: 'theremin' },
        {
          ...synth,
          name: 'bass',
          parameters: { cutoff: 5, waveform: 'noise', wobble: 1 },
        },
      ]),
    ).toEqual([
      {
        path: 'instruments[0].name',
        message: 'expected a name made of letters, digits and _',
      },
      {
        path: 'instruments[1].name',
        message: '“sound” is already a name Scripts use',
      },
      {
        path: 'instruments[3].name',
        message: 'another Instrument is already called “lead”',
      },
      {
        path: 'instruments[3].voices',
        message: 'expected a whole number from 1 to 16',
      },
      {
        path: 'instruments[4].kind',
        message: 'expected one of sampler, ym2149, synth',
      },
      {
        path: 'instruments[5].parameters.cutoff',
        message: 'expected a number from 20 to 20000',
      },
      {
        path: 'instruments[5].parameters.waveform',
        message: 'expected one of sine, triangle, saw, square',
      },
      {
        path: 'instruments[5].parameters.wobble',
        message: 'a synth has no parameter “wobble”',
      },
    ]);
  });

  test('the Instruments share the session voice cap', () => {
    const many = Array.from({ length: SESSION_VOICES / 16 + 1 }, (_, i) => ({
      ...createInstrument('sampler', `kit${i}`),
      voices: 16,
    }));
    expect(instrumentProblems(many)).toEqual([
      {
        path: 'instruments',
        message: `the Instruments have ${many.length * 16} voices between them; the most is ${SESSION_VOICES}`,
      },
    ]);
  });
});

describe('Instruments in the .folio file', () => {
  test('they round-trip through a Project file', async () => {
    const project = createProject('Band');
    const bass = createInstrument('synth', 'bass');
    bass.parameters.cutoff = 800;
    bass.parameters.waveform = 'square';
    bass.voices = 4;
    project.instruments.push(bass, createInstrument('ym2149', 'chip'), {
      ...createInstrument('sampler', 'drums'),
      id: 7,
    });
    const { project: read } = await readProjectFile(
      await writeProjectFile(project, new Map()),
    );
    expect(read.instruments).toEqual([
      bass,
      createInstrument('ym2149', 'chip'),
      createInstrument('sampler', 'drums'),
    ]);
  });

  test('format 5 Projects gain no Instruments', () => {
    const json = serializeProject(createProject('Old'));
    delete json.instruments;
    const migrated = migrateProjectJson({ ...json, format: 5 });
    expect(migrated.instruments).toEqual([]);
    expect('project' in validateProjectJson(migrated)).toBe(true);
  });

  test('a parameter missing from the file takes its default', () => {
    const json = serializeProject(createProject('Old'));
    const result = validateProjectJson({
      ...json,
      instruments: [
        { name: 'bass', kind: 'synth', voices: 2, parameters: { cutoff: 900 } },
      ],
    });
    expect('project' in result && result.project.instruments[0]).toEqual({
      name: 'bass',
      kind: 'synth',
      voices: 2,
      parameters: { ...defaultParameters(synthEngine), cutoff: 900 },
    });
  });

  test('a damaged Instrument names its path', () => {
    const json = serializeProject(createProject('Bad'));
    const result = validateProjectJson({
      ...json,
      instruments: [{ name: 'bass', kind: 'synth', voices: 99 }],
    });
    expect('issues' in result && result.issues).toEqual([
      { path: 'instruments[0].parameters', message: 'expected an object' },
      {
        path: 'instruments[0].voices',
        message: 'expected a whole number from 1 to 16',
      },
    ]);
  });
});
