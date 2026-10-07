import { describe, expect, test } from 'bun:test';
import { parseSource, syntaxText, type SyntaxNode } from '../src';

const rules = (node: SyntaxNode): string[] => [
  node.rule,
  ...node.children.flatMap(child =>
    child.kind === 'node' ? rules(child) : [],
  ),
];

// A parsed Handler's word leaves, and its first declaration's Handler.
const leaves = (node: SyntaxNode) =>
  node.children.flatMap(child =>
    child.kind === 'token' && child.t === 'word' ? [child.v] : [],
  );
const handler = (source: string) => {
  const declaration = parseSource(source).tree!.children[0] as SyntaxNode;
  return declaration.children[0] as SyntaxNode;
};

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

  test('a Fallback Handler has `any` and `message` leaves and no MessageName', () => {
    const fallback = handler(
      'on any message m where m is 1\n  pass any message\nend any message',
    );
    expect(fallback.rule).toBe('Handler');
    expect(
      fallback.children.flatMap(c => (c.kind === 'node' ? [c.rule] : [])),
    ).toEqual(['Pattern', 'Expression', 'Block']);
    expect(leaves(fallback)).toEqual([
      'on',
      'any',
      'message',
      'where',
      'end',
      'any',
      'message',
    ]);
    expect(rules(handler('on any x\nend any'))).toContain('MessageName');
  });

  test('a spread in `send … with` is a `...` leaf before its Expression', () => {
    const send = parseSource(
      'on t\n  send log with 1, ...xs to me\nend t',
    ).tree!;
    const find = (node: SyntaxNode, rule: string): SyntaxNode | undefined =>
      node.rule === rule
        ? node
        : node.children
            .flatMap(c => (c.kind === 'node' ? [find(c, rule)] : []))
            .find(Boolean);
    const list = find(send, 'ExpressionList')!;
    expect(list.children.map(c => (c.kind === 'node' ? c.rule : c.v))).toEqual([
      'Expression',
      ',',
      '...',
      'Expression',
    ]);
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

test('argument labels preserve source in every message position', () => {
  const source = `on move piece to square where square is "e4", queued
  pass move to
end move
on play
  move "knight" to "e4"
  send to me: move "rook" to "a1" and wait
  wait for move p to sq from me or 1 s
end play`;
  const parsed = parseSource(source);
  expect(parsed.error).toBeNull();
  expect(syntaxText(parsed.tree!)).toBe(source);
});
