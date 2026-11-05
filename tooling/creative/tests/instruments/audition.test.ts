import { expect, test } from 'bun:test';
import { StackEditor } from '../../src/editing';
import { createProject, type Asset } from '../../src/model';
import {
  auditionMessages,
  auditionSound,
  canAudition,
  keyboardNote,
  keyboardOctave,
  noteOff,
  noteOn,
} from '../../src/instruments/audition';
import { INSTRUMENT_KINDS } from '../../src/instruments/registry';
import type { InstrumentKind } from '../../src/instruments/kind';
import { SYNTH_KIND, YM2149_KIND } from '../helpers/instruments';

const sound = (name: string): Asset => ({
  fileName: `${name}.wav`,
  hash: `hash-${name}`,
  mediaType: 'audio/wav',
  name,
  size: 4,
});

const band = (...sounds: string[]) => {
  const project = createProject('Band');
  project.assets.push(...sounds.map(sound));
  const editor = new StackEditor(project);
  editor.edit(({ tree }) => {
    tree.addInstrument(SYNTH_KIND, 'lead');
    tree.addInstrument(YM2149_KIND, 'chip');
    tree.addInstrument('sampler', 'drums');
  });
  const [lead, chip, drums] = editor.project.instruments;
  return { chip: chip!, drums: drums!, lead: lead!, project: editor.project };
};

test('▶ plays middle C on the synth and YM2149 and releases it after half a second', () => {
  const { chip, lead } = band();
  for (const instrument of [lead, chip]) {
    expect(auditionMessages(instrument, 'kick')).toEqual([
      {
        at: 0,
        commands: [{ kind: 'note', note: 60, velocity: 1 }],
        instrument: instrument.name,
      },
      {
        at: 0.5,
        commands: [{ kind: 'release', note: 60 }],
        instrument: instrument.name,
      },
    ]);
  }
});

test('▶ plays the sampler’s chosen sound at middle C', () => {
  const { drums } = band('kick', 'snare');
  expect(auditionMessages(drums, 'snare')).toEqual([
    {
      at: 0,
      commands: [{ kind: 'note', note: 60, sound: 'snare', velocity: 1 }],
      instrument: 'drums',
    },
    {
      at: 0.5,
      commands: [{ kind: 'release', note: 60 }],
      instrument: 'drums',
    },
  ]);
  expect(auditionMessages(drums, undefined)).toEqual([]);
});

test('a sampler auditions its chosen sound, else the Project’s first', () => {
  expect(auditionSound(band('kick', 'snare').project, undefined)).toBe('kick');
  expect(auditionSound(band('kick', 'snare').project, 'snare')).toBe('snare');
  // A chosen sound the Project no longer has falls back to the first.
  expect(auditionSound(band('kick').project, 'snare')).toBe('kick');
  expect(auditionSound(band().project, 'snare')).toBeUndefined();
});

test('the keyboard plays a sampler’s sound at each key’s pitch', () => {
  const { drums, lead } = band('kick');
  expect(noteOn(drums, 64, 'kick')).toEqual({
    commands: [{ kind: 'note', note: 64, sound: 'kick', velocity: 1 }],
    instrument: 'drums',
  });
  expect(noteOn(lead, 64, 'kick')).toEqual({
    commands: [{ kind: 'note', note: 64, velocity: 1 }],
    instrument: 'lead',
  });
  expect(noteOff(lead, 64)).toEqual({
    commands: [{ kind: 'release', note: 64 }],
    instrument: 'lead',
  });
});

test('A–K play the white keys from C, W E T Y U the black keys, Z and X move an octave', () => {
  const white = [
    'KeyA',
    'KeyS',
    'KeyD',
    'KeyF',
    'KeyG',
    'KeyH',
    'KeyJ',
    'KeyK',
  ];
  expect(white.map(code => keyboardNote(code, 4))).toEqual([
    60, 62, 64, 65, 67, 69, 71, 72,
  ]);
  const black = ['KeyW', 'KeyE', 'KeyT', 'KeyY', 'KeyU'];
  expect(black.map(code => keyboardNote(code, 4))).toEqual([
    61, 63, 66, 68, 70,
  ]);
  expect(keyboardNote('KeyA', 3)).toBe(48);
  expect(keyboardNote('KeyQ', 4)).toBeUndefined();
  expect(keyboardNote('KeyK', 9)).toBeUndefined();
  expect(keyboardOctave('KeyZ', 4)).toBe(3);
  expect(keyboardOctave('KeyX', 4)).toBe(5);
  expect(keyboardOctave('KeyZ', -1)).toBe(-1);
  expect(keyboardOctave('KeyA', 4)).toBeUndefined();
});

test('only kinds that declare a note Operation audition', () => {
  expect(canAudition(INSTRUMENT_KINDS.get(SYNTH_KIND))).toBe(true);
  expect(canAudition(INSTRUMENT_KINDS.get('sampler'))).toBe(true);
  expect(canAudition(undefined)).toBe(false);
  const silent = {
    ...INSTRUMENT_KINDS.get(SYNTH_KIND)!,
    operations: {},
  } as InstrumentKind;
  expect(canAudition(silent)).toBe(false);
});
