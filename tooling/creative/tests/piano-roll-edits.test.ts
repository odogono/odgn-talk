// The Piano Roll's edits (ADR 0175, #2182): each rewrites one step's text
// and never the pattern's bracket structure.
import { expect, test } from 'bun:test';
import {
  addToChord,
  fromRest,
  merge,
  remove,
  rename,
  split,
  toRest,
  type EditResult,
} from '../src/add-ons/piano-roll/edits';
import { parseMiniNotation, type Step } from '../src/mini-notation';

const layers = (text: string): Step[][] => {
  const result = parseMiniNotation(text);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.pattern.layers as Step[][];
};

const apply = (text: string, edit: EditResult): string => {
  if ('problem' in edit) {
    throw new Error(edit.problem);
  }
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
};

const TEXT = 'c4 [e4 e4]@2 - <a4 bd:3>';
const at = (word: string, nth = 0) => {
  let i = -1;
  for (let n = 0; n <= nth; n++) {
    i = TEXT.indexOf(word, i + 1);
  }
  return i;
};

test('a note changes pitch or sound in place', () => {
  expect(apply(TEXT, rename(layers(TEXT), at('c4'), 'c#4'))).toBe(
    'c#4 [e4 e4]@2 - <a4 bd:3>',
  );
  expect(apply(TEXT, rename(layers(TEXT), at('bd'), 'hh'))).toBe(
    'c4 [e4 e4]@2 - <a4 hh>',
  );
});

test('a note becomes a rest, and a rest a note', () => {
  expect(apply(TEXT, toRest(layers(TEXT), at('a4')))).toBe(
    'c4 [e4 e4]@2 - <- bd:3>',
  );
  expect(apply(TEXT, fromRest(layers(TEXT), at('-'), 'g4'))).toBe(
    'c4 [e4 e4]@2 g4 <a4 bd:3>',
  );
});

test('a note splits in two within its step, and merges back', () => {
  const split1 = apply(TEXT, split(layers(TEXT), at('c4')));
  expect(split1).toBe('[c4 c4] [e4 e4]@2 - <a4 bd:3>');
  expect(apply(split1, merge(layers(split1), 1))).toBe(TEXT);
  expect(apply(TEXT, merge(layers(TEXT), at('e4', 1)))).toBe(
    'c4 e4@2 - <a4 bd:3>',
  );
});

test('edits that would change the structure are refused', () => {
  expect(merge(layers(TEXT), at('a4'))).toHaveProperty('problem');
  expect(merge(layers('[c4 e4]'), 1)).toHaveProperty('problem');
  expect(rename(layers(TEXT), at('-'), 'g4')).toHaveProperty('problem');
  expect(fromRest(layers(TEXT), at('c4'), 'g4')).toHaveProperty('problem');
  expect(split(layers(TEXT), at('-'))).toHaveProperty('problem');
});

test('a note added to a step makes a Chord in pitch order (#2187)', () => {
  const t = 'c4@2 g4 bd';
  expect(apply(t, addToChord(layers(t), 0, 'e4', 64))).toBe('[c4,e4]@2 g4 bd');
  expect(apply(t, addToChord(layers(t), 5, 'e4', 64))).toBe('c4@2 [e4,g4] bd');
  expect(apply(t, addToChord(layers(t), 8, 'hh'))).toBe('c4@2 g4 [bd,hh]');
});

test('a note joins an existing Chord between its pitches', () => {
  const t = '[c4,g4] a4';
  expect(apply(t, addToChord(layers(t), 1, 'e4', 64))).toBe('[c4,e4,g4] a4');
  expect(apply(t, addToChord(layers(t), 4, 'b4', 71))).toBe('[c4,g4,b4] a4');
  expect(apply(t, addToChord(layers(t), 1, 'a3', 57))).toBe('[a3,c4,g4] a4');
  expect(addToChord(layers(t), 1, 'g4', 67)).toHaveProperty('problem');
});

test('Delete takes a member out of its Chord, and a lone note rests', () => {
  const t = '[c4,e4,g4]*2 a4';
  expect(apply(t, remove(layers(t), 4))).toBe('[c4,g4]*2 a4');
  expect(apply(t, remove(layers(t), 1))).toBe('[e4,g4]*2 a4');
  expect(apply(t, remove(layers(t), 7))).toBe('[c4,e4]*2 a4');
  const two = '[c4,e4]@2 a4';
  expect(apply(two, remove(layers(two), 4))).toBe('c4@2 a4');
  expect(apply(two, remove(layers(two), 10))).toBe('[c4,e4]@2 -');
});

test('a bracket of a sequence is no Chord', () => {
  const t = '[c4 e4] a4';
  expect(apply(t, remove(layers(t), 1))).toBe('[- e4] a4');
});
