// Every Built-in property in every Container statement (#670). The shared
// fixtures are in broken.talk and corpus/load-diagnostics/container-properties/.
import { expect, test } from 'bun:test';
import grammar from '../../spec/data/grammar.toml';
import { parse } from './parser';

const statements = [
  ['put 1 into ', ''],
  ['put 1 before ', ''],
  ['put 1 after ', ''],
  ['put ...[1] after ', ''],
  ['set ', ' to 1'],
  ['add 1 to ', ''],
  ['subtract 1 from ', ''],
  ['multiply ', ' by 2'],
  ['divide ', ' by 2'],
  ['delete ', ''],
  ['replace "a" in ', ' with "b"'],
];

for (const property of grammar.properties) {
  for (const [prefix, suffix] of statements) {
    test(`reject ${prefix}the ${property} of x${suffix}`, () => {
      const { error } = parse(
        `on t x\n  ${prefix}the ${property} of x${suffix}\nend t\n`,
      );
      expect(error?.code).toBe('not a container');
      expect(error?.tok.line).toBe(2);
      expect(error?.tok.col).toBe(3 + prefix!.length);
    });
  }
}

for (const target of [
  'item 1 of the items of x',
  "x's length",
  '(the length of x)',
  'the length of the items of x',
  'the items of x delimited by ","',
  'the foo of item 1 of the items of x',
]) {
  test(`reject intermediate or wrapped property: ${target}`, () => {
    const { error } = parse(`on t x\n  set ${target} to 1\nend t\n`);
    expect(error?.code).toBe('not a container');
    expect(error?.tok.line).toBe(2);
    expect(error?.tok.col).toBe(7);
  });
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
  'set (the "length" of (x)) to 1',
  'set ((the ("length") of x)) to 1',
  'put 1 into (the "length" of x)',
]) {
  test(`allow property reads and ordinary keys: ${statement}`, () => {
    expect(parse(`on t x\n  ${statement}\nend t\n`).error).toBeNull();
  });
}

test('syntax rejection precedes load checking of a constant root and unknown value', () => {
  const { ast, error } = parse(
    'constant x = 1\non t\n  put missing into the length of x\nend t\n',
  );
  expect(ast).toBeNull();
  expect(error?.code).toBe('not a container');
  expect(error?.tok.line).toBe(3);
  expect(error?.tok.col).toBe(20);
});
