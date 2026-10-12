import { expect, test } from 'bun:test';
import grammar from '../../../spec/data/grammar.toml';
import {
  checkSource,
  compileSource,
  parseSource,
  parseSourceRecovering,
  syntaxText,
} from '../src';

// Exhaustive Container rejection coverage; shared fixtures were promoted in
// #680 after the Go and Zig parsers conformed (#670, #673).
const statements = [
  ['put 1 into ', ''],
  ['put 1 before ', ''],
  ['put 1 after ', ''],
  ['put ...[1] after ', ''],
  ['put ...[1] before ', ''],
  ['set ', ' to 1'],
  ['add 1 to ', ''],
  ['subtract 1 from ', ''],
  ['multiply ', ' by 2'],
  ['divide ', ' by 2'],
  ['delete ', ''],
  ['replace "a" in ', ' with "b"'],
  ['replace first "a" in ', ' with "b"'],
] as const;

for (const property of grammar.properties) {
  for (const target of [
    `the ${property} of x`,
    `item 1 of the ${property} of x`,
    `the first item of the ${property} of x`,
    `x's ${property}`,
    `(the ${property} of x)`,
    `the ${property} of (x)`,
    `the foo of (x's ${property})`,
    `the ${property} of the items of x`,
    `the foo of item 1 of the ${property} of x`,
  ]) {
    for (const [prefix, suffix] of statements) {
      test(`reject ${prefix}${target}${suffix}`, () => {
        const source = `on t x\n  ${prefix}${target}${suffix}\nend t\n`;
        const parsed = parseSource(source);
        expect(parsed.tree).toBeNull();
        expect(parsed.error?.code).toBe('not a container');
        expect(parsed.error?.tok).toMatchObject({
          line: 2,
          col: 3 + prefix.length,
          pos: source.indexOf(target),
        });
        const recovered = parseSourceRecovering(source);
        expect(recovered.error).toEqual(parsed.error);
        expect(syntaxText(recovered.tree)).toBe(source);
      });
    }
  }
}

for (const target of [
  'the items of x delimited by ","',
  'x\'s items delimited by ","',
  'item 1 of the items of x delimited by ","',
  '(the items of x delimited by ",")',
]) {
  for (const [prefix, suffix] of statements) {
    test(`reject delimited ${prefix}${target}${suffix}`, () => {
      const { error } = parseSource(
        `on t x\n  ${prefix}${target}${suffix}\nend t\n`,
      );
      expect(error?.code).toBe('not a container');
      expect(error?.tok).toMatchObject({ line: 2, col: 3 + prefix.length });
    });
  }
}

for (const statement of [
  'put 1 into the "length" of x',
  'put 1 into the ("length") of x',
  'put 1 into the (the length of x) of x',
  'put 1 into item (the length of x) of x',
  'put 1 into item 1 of x delimited by (the length of x)',
  'put the length of x into x',
  'set the "length" of x to 1',
  'set the ("length") of x to 1',
  'put 1 into (the "length" of x)',
  'put 1 into (x)',
  'put 1 into item 1 of (x)',
  'put 1 into the foo of x',
  "put 1 into x's foo",
  "set the (x's length) of x to the length of x",
  "delete item (x's length) of x delimited by (the length of x)",
  'replace (the length of x) in the foo of x with (the length of x)',
]) {
  test(`allow property reads and ordinary keys: ${statement}`, () => {
    const source = `on t x\n  ${statement}\nend t\n`;
    const parsed = parseSource(source);
    expect(parsed.error).toBeNull();
    expect(syntaxText(parsed.tree!)).toBe(source);
    const compiled = compileSource(source, { name: 'containers' });
    expect(compiled.error).toBeNull();
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.unit).not.toBeNull();
  });
}

test('property Container syntax rejection precedes load checking', () => {
  const source =
    'constant x = 1\non t\n  put missing into the length of x\nend t\n';
  const checked = checkSource(source);
  expect(checked.ok).toBe(false);
  expect(checked.tree).toBeNull();
  expect(checked.diagnostics).toEqual([]);
  expect(checked.error?.code).toBe('not a container');
  expect(checked.error?.tok).toMatchObject({ line: 3, col: 20 });
  const compiled = compileSource(source, { name: 'containers' });
  expect(compiled.error).toEqual(checked.error);
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.unit).toBeNull();
});

test('property Container positions use scalar columns and the outer opener', () => {
  const source =
    'on t x\r\n\tput "😀" into (the foo of (x\'s length))\r\nend t';
  const { error } = parseSource(source);
  expect(error?.code).toBe('not a container');
  expect(error?.tok).toMatchObject({
    line: 2,
    col: 15,
    pos: source.indexOf('('),
    raw: '(',
  });
});
