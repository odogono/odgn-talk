// The Piano Roll's layout (ADR 0175, #2181): cycles until the pattern
// repeats, pitch or sound rows, and a bar per Pattern Event.
import { expect, test } from 'bun:test';
import {
  cyclesOf,
  MAX_CYCLES,
  noteLabel,
  pianoRollLayout,
  restOffsets,
  restsAsWords,
} from '../src/add-ons/piano-roll/layout';
import { parseMiniNotation, type Pattern } from '../src/mini-notation';

const parse = (text: string): Pattern => {
  const result = parseMiniNotation(text);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.pattern;
};

test('a pattern lays out until it repeats', () => {
  expect(cyclesOf(parse('c4 e4'))).toBe(1);
  expect(cyclesOf(parse('<c4 e4 g4>'))).toBe(3);
  expect(cyclesOf(parse('<[c4 c4] [e4 e4]> <a4 b4 c5>'))).toBe(6);
  expect(cyclesOf(parse('c4/2'))).toBe(2);
});

test('a pattern that repeats late is capped', () => {
  const long = `<${Array.from({ length: 20 }, (_, i) => `c${i % 9}`).join(' ')}>`;
  expect(cyclesOf(parse(long))).toBe(MAX_CYCLES);
});

test('note patterns get a row per pitch, with a margin', () => {
  const layout = pianoRollLayout(parse('c4 e4'));
  expect(layout.mode).toBe('pitch');
  expect(layout.rows[0]!.label).toBe('g4');
  expect(layout.rows.at(-1)!.label).toBe('a3');
  expect(layout.rows.length).toBe(4 + 2 * 3 + 1);
  expect(layout.rows.find(r => r.label === 'c#4')!.black).toBe(true);
  expect(noteLabel(70)).toBe('a#4');
});

test('the full range covers the keyboard', () => {
  const layout = pianoRollLayout(parse('c4'), { fullRange: true });
  expect(layout.rows[0]!.label).toBe('c8');
  expect(layout.rows.at(-1)!.label).toBe('c1');
});

test('repeated notes stay separate bars, and holds are one', () => {
  const repeated = pianoRollLayout(parse('f4 f4'));
  expect(repeated.notes.map(n => [n.begin, n.end])).toEqual([
    [0, 0.5],
    [0.5, 1],
  ]);
  const held = pianoRollLayout(parse('f4 _'));
  expect(held.notes.map(n => [n.begin, n.end])).toEqual([[0, 1]]);
});

test('each alternative fills its own cycle', () => {
  const layout = pianoRollLayout(parse('<[c4 e4] [g4 a4]>'));
  expect(layout.cycles).toBe(2);
  expect(layout.steps).toBe(2);
  const g4 = layout.rows.findIndex(r => r.label === 'g4');
  expect(layout.notes.find(n => n.row === g4)).toMatchObject({
    cycle: 1,
    begin: 0,
    end: 0.5,
    from: 10,
    to: 12,
  });
});

test('sound patterns get a row per name, in the order they first sound', () => {
  const layout = pianoRollLayout(parse('bd [hh hh] sd, - cp:2'));
  expect(layout.mode).toBe('sound');
  expect(layout.rows.map(r => r.label)).toEqual(['bd', 'hh', 'cp:2', 'sd']);
  expect(layout.steps).toBe(6);
  expect(layout.notes.filter(n => n.row === 1).map(n => n.begin)).toEqual([
    1 / 3,
    0.5,
  ]);
});

test('rests are placed when the layout is given them', () => {
  const text = 'c4 - [e4 -]';
  const pattern = parse(text);
  const at = restOffsets(pattern.layers);
  expect(at).toEqual([3, 9]);
  const layout = pianoRollLayout(pattern, {
    rests: { at, pattern: parse(restsAsWords(text, at)) },
  });
  expect(layout.rests.map(r => [r.from, r.begin, r.end])).toEqual([
    [3, 1 / 3, 2 / 3],
    [9, 5 / 6, 1],
  ]);
  expect(layout.steps).toBe(6);
});

// A pattern of rests still has rows to write into (#2214).
test('a rest-only pattern opens on pitch rows around C4', () => {
  for (const text of ['-', '- -']) {
    const layout = pianoRollLayout(parse(text));
    expect(layout.mode).toBe('pitch');
    expect(layout.notes).toEqual([]);
    expect(layout.rows[0]!.label).toBe('d#4');
    expect(layout.rows.at(-1)!.label).toBe('a3');
    expect(layout.rows.length).toBe(2 * 3 + 1);
  }
});

test('a rest-only pattern keeps the rows it is given', () => {
  const pitch = pianoRollLayout(parse('c4 e4')).hint;
  const kept = pianoRollLayout(parse('- -'), { empty: pitch });
  expect(kept.rows.map(r => r.label)).toEqual(
    pianoRollLayout(parse('c4 e4')).rows.map(r => r.label),
  );
  const full = pianoRollLayout(parse('-'), { empty: pitch, fullRange: true });
  expect(full.rows[0]!.label).toBe('c8');
  expect(full.rows.at(-1)!.label).toBe('c1');
  // Full range then fits back to the remembered rows.
  expect(full.hint).toEqual(pitch);

  const sound = pianoRollLayout(parse('bd sn:2')).hint;
  expect(sound).toEqual({ mode: 'sound', labels: ['bd', 'sn:2'] });
  const sounds = pianoRollLayout(parse('-'), { empty: sound });
  expect(sounds.mode).toBe('sound');
  expect(sounds.rows.map(r => r.label)).toEqual(['bd', 'sn:2']);
});

test('a rest-only pattern keeps its rests and steps', () => {
  const text = '- [- -]';
  const at = restOffsets(parse(text).layers);
  const layout = pianoRollLayout(parse(text), {
    rests: { at, pattern: parse(restsAsWords(text, at)) },
  });
  expect(layout.steps).toBe(4);
  expect(layout.rests.map(r => [r.from, r.begin, r.end])).toEqual([
    [0, 0, 0.5],
    [3, 0.5, 0.75],
    [5, 0.75, 1],
  ]);
});
