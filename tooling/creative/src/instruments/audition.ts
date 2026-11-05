// The Instruments window's audition (#2080): the messages its ▶ button and
// computer keyboard send to hear the selected Instrument in Edit.
import type { Instrument, Project } from '../model';
import type { DeepReadonly } from '../readonly';
import { isSoundAsset } from '../sounds';
import type { InstrumentKind } from './kind';
import { samplerEngine } from './sampler';
import type { InstrumentMessage } from './session';

/** Middle C, which ▶ plays, and which plays a sampler's sound as recorded. */
export const AUDITION_NOTE = 60;
/** How long ▶ holds its note before releasing it, in seconds. */
export const AUDITION_SECONDS = 0.5;

/** Whether `kind` can be auditioned: it declares a note Operation. */
export const canAudition = (kind: InstrumentKind | undefined): boolean =>
  kind !== undefined && 'play' in kind.operations;

export const isSampler = (instrument: DeepReadonly<Instrument>): boolean =>
  instrument.kind === samplerEngine.name;

/** The Project's sounds, in order, by the names a sampler plays them by. */
export const projectSounds = (project: DeepReadonly<Project>): string[] =>
  project.assets.filter(isSoundAsset).map(asset => asset.name);

/**
 * The sound a sampler auditions: the one chosen for it if the Project still
 * has it, else the Project's first, else none.
 */
export const auditionSound = (
  project: DeepReadonly<Project>,
  chosen: string | undefined,
): string | undefined => {
  const sounds = projectSounds(project);
  return chosen !== undefined && sounds.includes(chosen) ? chosen : sounds[0];
};

/** Starts `note` on `instrument`; a sampler plays `sound` at that pitch. */
export const noteOn = (
  instrument: DeepReadonly<Instrument>,
  note: number,
  sound: string | undefined,
  at?: number,
): InstrumentMessage => ({
  ...(at === undefined ? {} : { at }),
  instrument: instrument.name,
  commands: [
    {
      kind: 'note',
      note,
      velocity: 1,
      ...(isSampler(instrument) && sound !== undefined ? { sound } : {}),
    },
  ],
});

export const noteOff = (
  instrument: DeepReadonly<Instrument>,
  note: number,
  at?: number,
): InstrumentMessage => ({
  ...(at === undefined ? {} : { at }),
  instrument: instrument.name,
  commands: [{ kind: 'release', note }],
});

/**
 * What ▶ plays: middle C, released after half a second. A sampler without a
 * sound plays nothing.
 */
export const auditionMessages = (
  instrument: DeepReadonly<Instrument>,
  sound: string | undefined,
): InstrumentMessage[] =>
  isSampler(instrument) && sound === undefined
    ? []
    : [
        noteOn(instrument, AUDITION_NOTE, sound, 0),
        noteOff(instrument, AUDITION_NOTE, AUDITION_SECONDS),
      ];

// The computer keyboard as a piano, by physical key: the home row plays
// the white keys from C, the row above the black keys.
const KEY_STEPS: Readonly<Record<string, number>> = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
};

/** The octave the keyboard starts in: `A` plays middle C. */
export const KEYBOARD_OCTAVE = 4;
const MIN_OCTAVE = -1;
const MAX_OCTAVE = 9;

/** The note a key plays in `octave`, or undefined for other keys. */
export const keyboardNote = (
  code: string,
  octave: number,
): number | undefined => {
  const step = KEY_STEPS[code];
  if (step === undefined) {
    return undefined;
  }
  const note = (octave + 1) * 12 + step;
  return note >= 0 && note <= 127 ? note : undefined;
};

/** The octave after `Z` (down) or `X` (up), or undefined for other keys. */
export const keyboardOctave = (
  code: string,
  octave: number,
): number | undefined =>
  code === 'KeyZ'
    ? Math.max(MIN_OCTAVE, octave - 1)
    : code === 'KeyX'
      ? Math.min(MAX_OCTAVE, octave + 1)
      : undefined;
