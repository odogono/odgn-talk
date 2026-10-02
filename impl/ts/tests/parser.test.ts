import { describe, expect, test } from 'bun:test';
import { parseSource, syntaxText, type SyntaxNode } from '../src';

const rules = (node: SyntaxNode): string[] => [
  node.rule,
  ...node.children.flatMap(child =>
    child.kind === 'node' ? rules(child) : [],
  ),
];

describe('lossless Core parser', () => {
  test('preserves source, trivia, continuations and trailing comments', () => {
    const source =
      '\ufeff-- head\r\non t\r\n\tput [1, -- list\r\n 2] into xs -- tail\r\nend t -- eof';
    const result = parseSource(source);
    expect(result.error).toBeNull();
    expect(result.tree).not.toBeNull();
    expect(syntaxText(result.tree!)).toBe(source);
    expect(result.tree!.start).toBe(0);
    expect(result.tree!.end).toBe(source.length);
    expect(rules(result.tree!)).toContain('List');
  });

  test('parses empty source and source containing only trivia', () => {
    for (const source of ['', '\ufeff \t-- comment', '--😀\r\n \t']) {
      const result = parseSource(source);
      expect(result.error).toBeNull();
      expect(syntaxText(result.tree!)).toBe(source);
    }
  });

  test('retains operator precedence, right associative powers and grouping', () => {
    const result = parseSource('constant n = -2^3^4 + (5 * 6)\n');
    expect(result.error).toBeNull();
    expect(rules(result.tree!)).toEqual(
      expect.arrayContaining([
        'Power',
        'Unary',
        'Additive',
        'Multiplicative',
        'Primary',
      ]),
    );
    expect(syntaxText(result.tree!)).toBe('constant n = -2^3^4 + (5 * 6)\n');
  });

  test('first syntax error has its exact code, scalar position and token span', () => {
    const result = parseSource('on t\n put "😀" & return into x\n @\nend t');
    expect(result.tree).toBeNull();
    expect(result.error?.code).toBe('unexpected token');
    expect(result.error?.tok).toMatchObject({
      line: 2,
      col: 12,
      raw: 'return',
    });
  });

  test('container validation reports the container start', () => {
    const result = parseSource('on t\n put 1 into the length of "s"\nend t');
    expect(result.error?.code).toBe('not a container');
    expect(result.error?.tok).toMatchObject({ line: 2, col: 13 });
  });

  test('block lambdas reset continuation depth in a call argument', () => {
    const source =
      'on t\n put apply(given x\n  return x +\n   1\n end given, 2) into answer\nend t';
    const result = parseSource(source);
    expect(result.error).toBeNull();
    expect(syntaxText(result.tree!)).toBe(source);
    expect(rules(result.tree!)).toContain('Lambda');
  });
});

test('valid deeply nested source does not depend on the native call stack', () => {
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{x:', '}'],
  ]) {
    const source =
      'constant n = ' + open!.repeat(3000) + '1' + close!.repeat(3000);
    const result = parseSource(source);
    expect(result.error).toBeNull();
    expect(syntaxText(result.tree!)).toBe(source);
  }
});

test('deep syntax errors retain their normative first code and position', () => {
  const source = 'constant n = ' + '('.repeat(3000) + 'return';
  const result = parseSource(source);
  expect(result.error?.code).toBe('unexpected token');
  expect(result.error?.tok).toMatchObject({ line: 1, col: 3014 });
});
