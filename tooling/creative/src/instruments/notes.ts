// Notes as Instruments take them (ADR 0158): MIDI numbers, or note names
// such as `c3`, `f#4` and `eb2`, with middle C, `c4`, as 60.

const STEPS: Readonly<Record<string, number>> = {
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
  a: 9,
  b: 11,
};

const NOTE_NAME = /^([a-g])(#|b|s)?(-?\d)$/u;

/** The MIDI number of a note name or number from 0 to 127, else undefined. */
export const noteNumber = (note: number | string): number | undefined => {
  if (typeof note === 'number') {
    return Number.isInteger(note) && note >= 0 && note <= 127
      ? note
      : undefined;
  }
  const match = NOTE_NAME.exec(note.toLowerCase());
  if (!match) {
    return undefined;
  }
  const [, letter, accidental, octave] = match;
  const shift = accidental === undefined ? 0 : accidental === 'b' ? -1 : 1;
  return noteNumber(STEPS[letter!]! + shift + (Number(octave) + 1) * 12);
};

/** A MIDI note's frequency in equal temperament, A4 = 440 Hz. */
export const noteFrequency = (note: number): number =>
  440 * 2 ** ((note - 69) / 12);

/** Equal-power gains for `pan` from -1 (left) to 1 (right). */
export const panGains = (pan: number): readonly [number, number] => {
  const angle = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  return [Math.cos(angle), Math.sin(angle)];
};
