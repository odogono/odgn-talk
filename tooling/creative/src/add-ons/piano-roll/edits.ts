// The Piano Roll's edits (ADR 0175, #2182). Each rewrites one step's
// characters of the Mini-Notation text and never its bracket structure:
// change a note's pitch or sound, turn a note into a rest or a rest into a
// note, split a step in two or merge a split step back. Each answers the
// characters to replace, or why not.
import type { Step } from '../../mini-notation';

export type TextEdit = { from: number; insert: string; to: number };
export type EditResult = TextEdit | { problem: string };

type Word = Extract<Step, { kind: 'word' }>;

const children = (step: Step): Step[] =>
  step.kind === 'sequence' || step.kind === 'alternation'
    ? step.layers.flat()
    : step.kind === 'fast' || step.kind === 'slow' || step.kind === 'weight'
      ? [step.step]
      : [];

/** Every step in `layers`, outermost first. */
export const allSteps = (layers: readonly Step[][]): Step[] => {
  const found: Step[] = [];
  const visit = (step: Step) => {
    found.push(step);
    children(step).forEach(visit);
  };
  layers.flat().forEach(visit);
  return found;
};

/** The word or rest step written at `from`. */
export const stepAt = (
  layers: readonly Step[][],
  from: number,
): Word | Extract<Step, { kind: 'rest' }> | undefined =>
  allSteps(layers).find(
    (s): s is Word | Extract<Step, { kind: 'rest' }> =>
      (s.kind === 'word' || s.kind === 'rest') && s.from === from,
  );

/** The word at `from` renamed `name`, a row's label, as moving a note does. */
export const rename = (
  layers: readonly Step[][],
  from: number,
  name: string,
): EditResult => {
  const step = stepAt(layers, from);
  if (step?.kind !== 'word') {
    return { problem: 'only a note can change' };
  }
  return { from: step.from, to: step.to, insert: name };
};

/** The note at `from` as a rest. */
export const toRest = (layers: readonly Step[][], from: number): EditResult => {
  const step = stepAt(layers, from);
  return step?.kind === 'word'
    ? { from: step.from, to: step.to, insert: '-' }
    : { problem: 'only a note can become a rest' };
};

/** The rest at `from` as the note or sound `name`. */
export const fromRest = (
  layers: readonly Step[][],
  from: number,
  name: string,
): EditResult => {
  const step = stepAt(layers, from);
  return step?.kind === 'rest'
    ? { from: step.from, to: step.to, insert: name }
    : { problem: 'only a rest can become a note' };
};

/** The note at `from` split in two in its own time, as `[c4 c4]`. */
export const split = (layers: readonly Step[][], from: number): EditResult => {
  const step = stepAt(layers, from);
  if (step?.kind !== 'word') {
    return { problem: 'only a note can be split' };
  }
  const word = wordText(step);
  return { from: step.from, to: step.to, insert: `[${word} ${word}]` };
};

/**
 * The bracketed steps holding the note at `from` merged into one, when they
 * are all the same note, as `[c4 c4]` becomes `c4`.
 */
export const merge = (layers: readonly Step[][], from: number): EditResult => {
  const parent = allSteps(layers)
    .filter(
      (s): s is Extract<Step, { kind: 'sequence' }> =>
        s.kind === 'sequence' &&
        s.layers.length === 1 &&
        s.layers[0]!.some(c => c.kind === 'word' && c.from === from),
    )
    .at(-1);
  const words = parent?.layers[0] ?? [];
  const first = words[0];
  if (
    !parent ||
    first?.kind !== 'word' ||
    words.some(w => w.kind !== 'word' || wordText(w) !== wordText(first))
  ) {
    return { problem: 'only brackets of one repeated note can merge' };
  }
  return { from: parent.from, to: parent.to, insert: wordText(first) };
};

const wordText = (step: Word) =>
  step.value.index === undefined
    ? step.value.name
    : `${step.value.name}:${step.value.index}`;

// --- Chords (#2187) ----------------------------------------------------------

type Sequence = Extract<Step, { kind: 'sequence' }>;

/** The Chord the word at `from` is a member of: a bracket of single notes. */
const chordOf = (
  layers: readonly Step[][],
  from: number,
): { chord: Sequence; members: Word[] } | undefined => {
  for (const step of allSteps(layers)) {
    if (
      step.kind === 'sequence' &&
      step.layers.length > 1 &&
      step.layers.every(l => l.length === 1 && l[0]!.kind === 'word') &&
      step.layers.some(l => l[0]!.from === from)
    ) {
      return { chord: step, members: step.layers.map(l => l[0] as Word) };
    }
  }
  return undefined;
};

/**
 * `name` added to the step of the note at `from`, making it a Chord or
 * joining its Chord, in pitch order when `note` gives the pitch.
 */
export const addToChord = (
  layers: readonly Step[][],
  from: number,
  name: string,
  note?: number,
): EditResult => {
  const step = stepAt(layers, from);
  if (step?.kind !== 'word') {
    return { problem: 'only a note can become a Chord' };
  }
  const found = chordOf(layers, from);
  const members = found?.members ?? [step];
  if (members.some(m => wordText(m) === name)) {
    return { problem: `the Chord already has ${name}` };
  }
  const above =
    note === undefined
      ? undefined
      : members.find(m => m.value.note !== undefined && m.value.note > note);
  if (!found) {
    const word = wordText(step);
    return {
      from: step.from,
      to: step.to,
      insert: above ? `[${name},${word}]` : `[${word},${name}]`,
    };
  }
  return above
    ? { from: above.from, to: above.from, insert: `${name},` }
    : { from: members.at(-1)!.to, to: members.at(-1)!.to, insert: `,${name}` };
};

/**
 * The note at `from` removed: out of its Chord, dropping the brackets when
 * one note is left, or as a rest when it plays alone.
 */
export const remove = (layers: readonly Step[][], from: number): EditResult => {
  const found = chordOf(layers, from);
  if (!found) {
    return toRest(layers, from);
  }
  const { chord, members } = found;
  const index = members.findIndex(m => m.from === from);
  if (members.length === 2) {
    const kept = members[1 - index]!;
    return { from: chord.from, to: chord.to, insert: wordText(kept) };
  }
  return index === 0
    ? { from: members[0]!.from, to: members[1]!.from, insert: '' }
    : { from: members[index - 1]!.to, to: members[index]!.to, insert: '' };
};
