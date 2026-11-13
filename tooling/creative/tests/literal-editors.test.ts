// Literal Editors (ADR 0175, #2180): following a pinned literal through edits
// and rewriting it, and which Add-ons provide them.
import { expect, test } from 'bun:test';
import { AddOnLoader } from '../src/add-ons/loader';
import { defineAddOn } from '../src/add-ons/api';
import {
  followLiteral,
  literalAt,
  literalEditorsFor,
  mapOffset,
  replaceInLiteral,
} from '../src/literal-editors';

const SOURCE = 'on click\n  loop "c4 e4" on lead\n  loop "bd sd"\nend click\n';
const LEAD = SOURCE.indexOf('c4');
const DRUMS = SOURCE.indexOf('bd');

test('an offset keeps its place around the one changed span', () => {
  expect(mapOffset('abcdef', 'abXYcdef', 4)).toBe(6);
  expect(mapOffset('abcdef', 'abXYcdef', 1)).toBe(1);
  expect(mapOffset('abcdef', 'abef', 3)).toBe(2);
});

test('a pinned literal is found where it starts', () => {
  expect(literalAt(SOURCE, DRUMS)?.text).toBe('bd sd');
  expect(literalAt(SOURCE, LEAD + 3)?.text).toBe('c4 e4');
  expect(literalAt(SOURCE, 0)).toBeUndefined();
  expect(literalAt('on click\n  loop "c4"\nend click', 0)).toBeUndefined();
});

test('a pin follows its literal when text before it changes', () => {
  const after = `-- lead\n${SOURCE}`;
  const { pin, state } = followLiteral({ at: DRUMS }, SOURCE, after);
  expect(pin.at).toBe(after.indexOf('bd'));
  expect(state.kind).toBe('ready');
  expect(state.kind === 'ready' && state.text).toBe('bd sd');
});

test('a pin follows edits inside its own literal', () => {
  const after = SOURCE.replace('c4 e4', 'g4 e4 a4');
  const { pin, state } = followLiteral({ at: LEAD }, SOURCE, after);
  expect(pin.at).toBe(LEAD);
  expect(state.kind === 'ready' && state.text).toBe('g4 e4 a4');
});

test('a pin follows its literal through a change spanning it', () => {
  const after = `-- tune\n${SOURCE}`.replace('c4 e4', 'g4 e4');
  const { pin, state } = followLiteral({ at: LEAD }, SOURCE, after);
  expect(pin.at).toBe(after.indexOf('g4'));
  expect(state.kind === 'ready' && state.text).toBe('g4 e4');
});

test('a literal whose Mini-Notation breaks shows the error', () => {
  const after = SOURCE.replace('c4 e4', 'c4 [e4');
  const { state } = followLiteral({ at: LEAD }, SOURCE, after);
  expect(state.kind).toBe('invalid');
});

test('a source with a syntax error is unreadable, not removed', () => {
  const after = SOURCE.replace('end click', 'end clack');
  expect(followLiteral({ at: DRUMS }, SOURCE, after).state.kind).toBe(
    'unreadable',
  );
});

test('a deleted literal is removed', () => {
  const after = SOURCE.replace('  loop "bd sd"\n', '');
  expect(followLiteral({ at: DRUMS }, SOURCE, after).state.kind).toBe(
    'removed',
  );
});

const block = (...texts: string[]) =>
  `on click\n${texts.map(text => `  loop "${text}"\n`).join('')}end click\n`;
const nth = (source: string, text: string, n: number) => {
  let at = -1;
  for (let i = 0; i <= n; i++) {
    at = source.indexOf(`"${text}"`, at + 1);
  }
  return at + 1;
};
const without = (source: string, text: string, n: number) => {
  const at = nth(source, text, n);
  const start = source.lastIndexOf('\n', at) + 1;
  return source.slice(0, start) + source.slice(source.indexOf('\n', at) + 1);
};

test('deleting the first of two literals removes it, not its neighbour', () => {
  const before = block('c4', 'e4');
  const after = without(before, 'c4', 0);
  const first = followLiteral({ at: nth(before, 'c4', 0) }, before, after);
  expect(first.state.kind).toBe('removed');
  const second = followLiteral({ at: nth(before, 'e4', 0) }, before, after);
  expect(second.pin.at).toBe(nth(after, 'e4', 0));
  expect(second.state.kind === 'ready' && second.state.text).toBe('e4');
});

test('deleting the middle of three literals removes only it', () => {
  const before = block('c4', 'c4 e4', 'c4 e4 g4');
  const after = without(before, 'c4 e4', 0);
  const pins = ['c4', 'c4 e4', 'c4 e4 g4'].map(text =>
    followLiteral({ at: nth(before, text, 0) }, before, after),
  );
  expect(pins.map(p => p.state.kind)).toEqual(['ready', 'removed', 'ready']);
  expect(pins[0]!.pin.at).toBe(nth(after, 'c4', 0));
  expect(pins[2]!.pin.at).toBe(nth(after, 'c4 e4 g4', 0));
});

test('a literal sharing a deleted one’s prefix keeps its own pin', () => {
  const before = block('c4', 'c4 e4');
  const after = without(before, 'c4', 0);
  const kept = followLiteral({ at: nth(before, 'c4 e4', 0) }, before, after);
  expect(kept.pin.at).toBe(nth(after, 'c4 e4', 0));
  expect(kept.state.kind === 'ready' && kept.state.text).toBe('c4 e4');
  const gone = followLiteral({ at: nth(before, 'c4', 0) }, before, after);
  expect(gone.state.kind).toBe('removed');
});

test('of identical literals, a deletion is never moved onto another', () => {
  const before = block('c4', 'c4', 'c4');
  for (const n of [0, 1, 2]) {
    const after = without(before, 'c4', n);
    const pins = [0, 1, 2].map(i =>
      followLiteral({ at: nth(before, 'c4', i) }, before, after),
    );
    // The source cannot tell which one went, so the scan blames the last.
    expect(pins.map(p => p.state.kind)).toEqual(['ready', 'ready', 'removed']);
    expect(pins[0]!.pin.at).toBe(nth(after, 'c4', 0));
    expect(pins[1]!.pin.at).toBe(nth(after, 'c4', 1));
  }
});

test('undoing a deletion leaves a pin on the literal it followed', () => {
  const before = block('e4');
  const after = block('c4', 'e4');
  const kept = followLiteral({ at: nth(before, 'e4', 0) }, before, after);
  expect(kept.pin.at).toBe(nth(after, 'e4', 0));
  expect(kept.state.kind === 'ready' && kept.state.text).toBe('e4');
});

test('a pin outlives a deletion while the source is unreadable', () => {
  const before = block('c4', 'e4');
  const broken = without(before, 'c4', 0).replace('end click', 'end clack');
  const pin = { at: nth(before, 'e4', 0) };
  const first = followLiteral(pin, before, broken);
  expect(first.state.kind).toBe('unreadable');
  const fixed = broken.replace('end clack', 'end click');
  const second = followLiteral(first.pin, broken, fixed);
  expect(second.state.kind === 'ready' && second.state.text).toBe('e4');
});

test('an edit rewrites only its characters of the literal', () => {
  expect(replaceInLiteral(SOURCE, { at: LEAD }, 0, 2, 'd4')).toEqual({
    source: SOURCE.replace('c4 e4', 'd4 e4'),
  });
});

test('an edit maps through a backtick literal’s margin', () => {
  const source = 'on click\n  loop `\n    c4 e4\n    ` on lead\nend click\n';
  const at = literalAt(source, source.indexOf('c4'))!.offset;
  const result = replaceInLiteral(source, { at }, 3, 5, 'g4');
  expect(result).toEqual({ source: source.replace('e4', 'g4') });
});

test('an edit cannot write characters a literal would escape', () => {
  for (const insert of ['"', '`', '\\', '{', '\n']) {
    expect(replaceInLiteral(SOURCE, { at: LEAD }, 0, 2, insert)).toHaveProperty(
      'problem',
    );
  }
  expect(replaceInLiteral(SOURCE, { at: LEAD }, 0, 9, 'x')).toHaveProperty(
    'problem',
  );
});

const ADD_ON = 'https://northtalk.org/add-ons/test-literal';
const echo = defineAddOn({
  id: ADD_ON,
  version: '1.0.0',
  kinds: {},
  literalEditors: {
    echo: {
      label: 'Echo',
      literal: 'mini-notation',
      open: host => ({
        show: state => {
          host.element.textContent = state.kind === 'ready' ? state.text : '';
        },
      }),
    },
  },
});

test('an Add-on’s Literal Editors are offered only to Projects listing it', () => {
  expect(new AddOnLoader().register(echo)).toBeUndefined();
  expect(
    literalEditorsFor([{ id: ADD_ON }], 'mini-notation').map(e => e.label),
  ).toEqual(['Echo']);
  expect(literalEditorsFor([], 'mini-notation')).toEqual([]);
  expect(literalEditorsFor(undefined, 'mini-notation')).toEqual([]);
});

test('a Project Add-on cannot bring a Literal Editor yet', async () => {
  const loader = new AddOnLoader({
    trusted: () => true,
    codeImporter: () => Promise.resolve(echo),
  });
  const problems = await loader.load([
    { id: ADD_ON, version: '1.0.0', code: 'x', hash: 'h' },
  ]);
  expect(problems[0]?.message).toContain('Literal Editors');
});
