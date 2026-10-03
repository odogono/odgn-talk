import { describe, expect, test } from 'bun:test';
import {
  checkSource,
  checkSyntax,
  compileSource,
  HostError,
  parseSource,
  parseSourceRecovering,
  syntaxText,
  type SyntaxElement,
  type SyntaxNode,
} from '../src';

const productions = (tree: SyntaxNode, rule: SyntaxNode['rule']) => {
  const found: SyntaxNode[] = [];
  const work: SyntaxElement[] = [tree];
  while (work.length) {
    const element = work.pop()!;
    if (element.kind === 'node') {
      if (element.rule === rule) {
        found.push(element);
      }
      work.push(...[...element.children].reverse());
    }
  }
  return found;
};

const lossless = (source: string, tree: SyntaxNode) => {
  expect(syntaxText(tree)).toBe(source);
  const work: SyntaxElement[] = [tree];
  let offset = 0;
  while (work.length) {
    const element = work.pop()!;
    if (element.kind === 'node') {
      expect(element.start).toBe(offset);
      const last = element.children.at(-1);
      expect(element.end).toBe(last?.end ?? element.start);
      work.push(...[...element.children].reverse());
    } else {
      for (const trivia of element.leadingTrivia) {
        expect(trivia.pos).toBe(offset);
        expect(trivia.raw).toBe(source.slice(trivia.pos, trivia.end));
        offset = trivia.end;
      }
      expect(element.pos).toBe(offset);
      expect(element.raw).toBe(source.slice(element.pos, element.end));
      offset = element.end;
    }
  }
  expect(offset).toBe(source.length);
};

describe('tooling parser recovery', () => {
  test('valid source has the same tree and no recovery diagnostics', () => {
    for (const source of [
      '',
      '\ufeff --😀\r\n',
      'on t\n put [1, 2] into xs\nend t',
      'on t\n constant x\n use x\n private x\n script x\nend t',
    ]) {
      const recovered = parseSourceRecovering(source);
      expect(recovered.tree).toEqual(parseSource(source).tree!);
      expect(recovered.error).toBeNull();
      expect(recovered.diagnostics).toEqual([]);
      lossless(source, recovered.tree);
    }
  });

  test('recovers statements and lexical errors with the normative first error', () => {
    const source =
      '\ufeff--😀\r\non t x\r\n put 1 into 3 -- bad container\r\n @\r\n put x into kept\r\n return absent\r\nend t -- eof';
    const recovered = parseSourceRecovering(source);
    const strict = parseSource(source);
    expect(recovered.error).toEqual(strict.error);
    expect(
      recovered.diagnostics.map(({ error, recovery }) => [
        error.code,
        error.tok.line,
        recovery,
      ]),
    ).toEqual([
      ['not a container', 3, false],
      ['bad character', 4, true],
    ]);
    expect(productions(recovered.tree, 'Error')).toHaveLength(2);
    lossless(source, recovered.tree);
    const checked = checkSyntax(recovered.tree);
    expect(checked.diagnostics.map(d => [d.code, d.span.line])).toEqual([
      ['unknown name', 6],
    ]);
    expect(
      checked.tree.scopes
        .find(s => s.kind === 'handler')
        ?.bindings.map(b => b.name),
    ).toEqual(['it', 'x', 'kept']);
    expect(checkSource(source)).toMatchObject({
      tree: null,
      diagnostics: [],
      ok: false,
    });
    expect(compileSource(source, { name: 'broken' }).unit).toBeNull();
  });

  test('expression recovery retains following list elements and statements', () => {
    const source =
      'on t\n put [1 + , 2, {x: 3}] into broken\n put 4 into kept\n return kept\nend t';
    const recovered = parseSourceRecovering(source);
    expect(recovered.error).toEqual(parseSource(source).error);
    expect(productions(recovered.tree, 'List')).toHaveLength(1);
    expect(productions(recovered.tree, 'Map')).toHaveLength(1);
    expect(productions(recovered.tree, 'Error')).toHaveLength(1);
    lossless(source, recovered.tree);
    const checked = checkSyntax(recovered.tree);
    expect(checked.diagnostics).toEqual([]);
    expect(
      checked.tree.scopes
        .find(s => s.kind === 'handler')
        ?.bindings.map(b => b.name),
    ).toEqual(['it', 'kept']);
  });

  test('recovers inside nested blocks without consuming their branch endings', () => {
    const source =
      'on t x\n if x then\n  @\n  repeat 2 times\n   put into bad\n   put x into kept\n  end repeat\n else\n  return missing\n end if\nend t\nconstant later = 1';
    const recovered = parseSourceRecovering(source);
    expect(recovered.error).toEqual(parseSource(source).error);
    lossless(source, recovered.tree);
    expect(productions(recovered.tree, 'If')).toHaveLength(1);
    expect(productions(recovered.tree, 'Repeat')).toHaveLength(1);
    const checked = checkSyntax(recovered.tree);
    expect(checked.diagnostics.map(d => [d.code, d.span.line])).toEqual([
      ['unknown name', 9],
    ]);
    expect(checked.tree.scopes[0]!.bindings.map(b => b.name)).toEqual([
      't',
      'later',
    ]);
  });

  test('unfinished blocks retain parsed bindings and later declarations', () => {
    for (const tail of ['', '\nfunction later\n return 1\nend later']) {
      const source = 'on t x\n put x into kept' + tail;
      const recovered = parseSourceRecovering(source);
      expect(recovered.error).toEqual(parseSource(source).error);
      lossless(source, recovered.tree);
      const checked = checkSyntax(recovered.tree);
      expect(
        checked.tree.scopes
          .find(s => s.kind === 'handler')
          ?.bindings.map(b => b.name),
      ).toEqual(['it', 'x', 'kept']);
      if (tail) {
        expect(checked.tree.scopes[0]!.bindings.map(b => b.name)).toEqual([
          't',
          'later',
        ]);
      }
    }
  });

  test('retained Lambdas keep capture identity and load checks keep their options', () => {
    const source =
      'constant fixed = 1\non t x\n @\n put given y: x + y into fn\n put 2 into fixed\n return fn(1)\nend t';
    const recovered = parseSourceRecovering(source);
    const checked = checkSyntax(recovered.tree, {
      unit: 'script',
      objects: ['host'],
    });
    expect(checked.diagnostics.map(d => [d.code, d.span.line])).toEqual([
      ["can't write", 5],
    ]);
    expect(
      checked.tree.scopes[0]!.bindings.some(
        b => b.name === 'host' && b.kind === 'object',
      ),
    ).toBe(true);
    const handler = checked.tree.scopes.find(s => s.kind === 'handler')!;
    const lambda = checked.tree.scopes.find(s => s.kind === 'lambda')!;
    expect(lambda.parent).toBe(handler.id);
    expect(lambda.captures).toHaveLength(1);
    expect(lambda.captures[0]).toBe(handler.bindings.find(b => b.name === 'x'));
  });

  test('resets malformed bracket and continuation state at a physical newline', () => {
    for (const broken of [
      'put [1, @',
      'put "unterminated',
      'put 1 + @',
      'put given x, @',
    ]) {
      const source = `on t\n ${broken}\n put 2 into kept\nend t`;
      const recovered = parseSourceRecovering(source);
      expect(recovered.error).toEqual(parseSource(source).error);
      lossless(source, recovered.tree);
      expect(
        checkSyntax(recovered.tree)
          .tree.scopes.find(s => s.kind === 'handler')
          ?.bindings.some(b => b.name === 'kept'),
      ).toBe(true);
    }
  });

  test('invalid scalar source retains the Host boundary', () => {
    expect(() => parseSourceRecovering('\ud800')).toThrow(HostError);
  });

  test('edits across grammar contexts preserve source and the strict first error', () => {
    const sources = [
      'constant n = [1, {x: 2}, (3 + 4)]\non t x\n put n into x\nend t',
      'function f x = 1\n try\n  if x then\n   return x\n  else\n   throw "bad"\n  end if\n catch e\n  return e\n end try\nend f',
      'on t\n put <n: digit, optional "x"> into p\n put <<1 as uint16, 2 as 8 bits>> into b\n put f(given x: x, 2) into result\nend t',
    ];
    for (const original of sources) {
      for (let at = 0; at < original.length; at += 3) {
        for (const inserted of ['', '@', ',', '\n', 'end', '"']) {
          const source =
            original.slice(0, at) + inserted + original.slice(at + 1);
          const recovered = parseSourceRecovering(source);
          expect(recovered.error).toEqual(parseSource(source).error);
          lossless(source, recovered.tree);
          checkSyntax(recovered.tree);
        }
      }
    }
  });

  test('deep malformed expressions recover without the native call stack', () => {
    const source =
      'on t\n put ' +
      '['.repeat(3000) +
      '@' +
      ']'.repeat(3000) +
      ' into bad\n put 1 into kept\nend t';
    const recovered = parseSourceRecovering(source);
    expect(recovered.error).toEqual(parseSource(source).error);
    lossless(source, recovered.tree);
    expect(
      checkSyntax(recovered.tree)
        .tree.scopes.find(s => s.kind === 'handler')
        ?.bindings.some(b => b.name === 'kept'),
    ).toBe(true);
  });
});
