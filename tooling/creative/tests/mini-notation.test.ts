import { expect, test } from 'bun:test';
import { parseMiniNotation, Time, type Pattern } from '../src/mini-notation';

const parse = (text: string): Pattern => {
  const parsed = parseMiniNotation(text);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.pattern;
};

/** A cycle's events as `begin–end name`, for reading at a glance. */
const cycle = (text: string, index = 0) =>
  parse(text)
    .cycle(index)
    .map(e => {
      const { name, index: n } = e.value;
      return `${e.begin}–${e.end} ${name}${n === undefined ? '' : `:${n}`}`;
    });

test('a sequence divides the cycle equally', () => {
  expect(cycle('bd hh sd oh')).toEqual([
    '0–1/4 bd',
    '1/4–1/2 hh',
    '1/2–3/4 sd',
    '3/4–1 oh',
  ]);
  expect(cycle('bd hh', 3)).toEqual(['3–7/2 bd', '7/2–4 hh']);
});

test('a rest takes a step and plays nothing', () => {
  expect(cycle('bd - sd ~')).toEqual(['0–1/4 bd', '1/2–3/4 sd']);
  expect(cycle('-')).toEqual([]);
});

test('brackets subdivide a step', () => {
  expect(cycle('bd [hh hh] sd')).toEqual([
    '0–1/3 bd',
    '1/3–1/2 hh',
    '1/2–2/3 hh',
    '2/3–1 sd',
  ]);
  expect(cycle('[bd [hh [sd sd]]]')).toEqual([
    '0–1/2 bd',
    '1/2–3/4 hh',
    '3/4–7/8 sd',
    '7/8–1 sd',
  ]);
});

test('angle brackets play one child per cycle', () => {
  expect([0, 1, 2, 3].map(c => cycle('bd <hh sd cp>', c))).toEqual([
    ['0–1/2 bd', '1/2–1 hh'],
    ['1–3/2 bd', '3/2–2 sd'],
    ['2–5/2 bd', '5/2–3 cp'],
    ['3–7/2 bd', '7/2–4 hh'],
  ]);
  // A nested alternation advances only when its own turn comes round.
  expect([0, 1, 2, 3].map(c => cycle('<a <b c>>', c))).toEqual([
    ['0–1 a'],
    ['1–2 b'],
    ['2–3 a'],
    ['3–4 c'],
  ]);
});

test('*n repeats a step n times in its place', () => {
  expect(cycle('bd*2 sd')).toEqual(['0–1/4 bd', '1/4–1/2 bd', '1/2–1 sd']);
  expect(cycle('[bd sd]*1.5')).toEqual(['0–1/3 bd', '1/3–2/3 sd', '2/3–1 bd']);
  // A fast alternation moves on with every repeat.
  expect(cycle('<c3 e3 g3>*4', 0)).toEqual([
    '0–1/4 c3',
    '1/4–1/2 e3',
    '1/2–3/4 g3',
    '3/4–1 c3',
  ]);
  expect(cycle('<c3 e3 g3>*4', 1)[0]).toBe('1–5/4 e3');
});

test('/n stretches a step over n of its turns', () => {
  expect([0, 1].map(c => cycle('bd/2', c))).toEqual([['0–2 bd'], []]);
  expect([0, 1].map(c => cycle('[bd sd]/2 hh', c))).toEqual([
    ['0–1/2 bd', '1/2–1 hh'],
    ['1–3/2 sd', '3/2–2 hh'],
  ]);
  expect([0, 1].map(c => cycle('bd [hh sd]/2', c))).toEqual([
    ['0–1/2 bd', '1/2–1 hh'],
    ['1–3/2 bd', '3/2–2 sd'],
  ]);
});

test('commas layer sequences', () => {
  expect(cycle('bd*2, - cp')).toEqual(['0–1/2 bd', '1/2–1 bd', '1/2–1 cp']);
  expect(cycle('[bd, hh hh]')).toEqual(['0–1 bd', '0–1/2 hh', '1/2–1 hh']);
  expect([0, 1].map(c => cycle('<a b, c>', c))).toEqual([
    ['0–1 a', '0–1 c'],
    ['1–2 b', '1–2 c'],
  ]);
});

test('name:n picks a sample by index', () => {
  const [event] = parse('bd:3').cycle(0);
  expect(event?.value).toEqual({ name: 'bd', index: 3 });
});

test('note names carry their MIDI number', () => {
  expect(
    parse('c3 f#4 eb2 c-1 60 bd')
      .cycle(0)
      .map(e => e.value.note),
  ).toEqual([48, 66, 39, 0, 60, undefined]);
});

test('each event keeps its step’s place in the text', () => {
  const text = 'bd [hh:2 sd]*2';
  const events = parse(text).cycle(0);
  expect(events.map(e => text.slice(e.from, e.to))).toEqual([
    'bd',
    'hh:2',
    'sd',
    'hh:2',
    'sd',
  ]);
});

test('a span query returns the events that start in it', () => {
  const events = parse('bd hh sd oh').query(new Time(1, 4), new Time(5, 4));
  expect(events.map(e => `${e.begin} ${e.value.name}`)).toEqual([
    '1/4 hh',
    '1/2 sd',
    '3/4 oh',
    '1 bd',
  ]);
});

for (const [text, message, from, to] of [
  ['', 'Write at least one step.', 0, 0],
  ['bd [hh', 'This “[” has no “]”.', 3, 4],
  ['bd <hh', 'This “<” has no “>”.', 3, 4],
  ['bd ]', 'This “]” closes nothing.', 3, 4],
  ['bd []', 'This group needs at least one step.', 4, 5],
  ['bd, , sd', 'Write at least one step.', 4, 5],
  ['bd*', 'Write a number after “*”, as in bd*2.', 2, 3],
  ['bd/x', 'Write a number after “/”, as in bd/2.', 2, 3],
  ['bd*0', 'A step can’t be sped up by 0.', 2, 4],
  ['bd:', 'Write a whole number after “:”, as in bd:3.', 2, 3],
  ['bd ! sd', '“!” can’t start a step.', 3, 4],
  ['bd[hh]', 'Put a space between steps.', 2, 3],
] as const) {
  test(`“${text}” is an error`, () => {
    expect(parseMiniNotation(text)).toEqual({
      ok: false,
      error: { message, from, to },
    });
  });
}
