import { describe, expect, test } from 'bun:test';
import {
  checkSource,
  compileSource,
  parseEntry,
  parseSource,
  syntaxText,
} from '../src/index';
import { SessionHost } from '../src/session';

const say = (expression: string) => {
  const host = new SessionHost({ now: () => 0n });
  return host.input(`say ${expression}`).join('\n');
};

describe('fenced text values', () => {
  test('evaluates a standalone interpolated Session Entry', () => {
    const host = new SessionHost({ now: () => 0n });
    expect(host.input('`answer ${2 + 3}`')).toEqual(['"answer 5"']);
  });

  test('evaluates ordinary expressions and leaves JSON braces literal', () => {
    expect(say('`{"answer": ${2 + 3}}`')).toBe('{"answer": 5}');
  });

  test('accepts nested interpolated text and maps inside a hole', () => {
    expect(say('`outer ${`inner ${the value of {value: 3}}`}`')).toBe(
      'outer inner 3',
    );
  });

  test('allows multiline expressions inside holes', () => {
    expect(say('`sum ${1 +\n2}`')).toBe('sum 3');
  });

  test('inserts values once without interpreting their placeholders', () => {
    expect(say('`value ${"${missing}"}`')).toBe('value ${missing}');
  });

  test('raw text preserves placeholders, backslashes and shorter quote runs', () => {
    expect(say('"""${name} \\n "two" end"""')).toBe('${name} \\n "two" end');
  });

  test('a longer raw fence permits embedded triple quotes', () => {
    expect(say('""""a """ b""""')).toBe('a """ b');
  });

  test('strips the closing margin and only the boundary newlines', () => {
    expect(say('`\n  first  \n\n    second\n  \n  `')).toBe(
      'first  \n\n  second\n',
    );
  });

  test('uses an exact mixed tab and space margin', () => {
    expect(say('"""\n\t first\n\t\n\t second\n\t """')).toBe('first\n\nsecond');
  });

  test.each(['\n', '\r\n', '\r'])('normalizes source line endings %j', eol => {
    expect(say(['"""', '  first', '  second', '  """'].join(eol))).toBe(
      'first\nsecond',
    );
  });

  test('preserves inline-start whitespace across lines', () => {
    expect(say('` first\n  second `')).toBe(' first\n  second ');
  });

  test('does not indent a multiline inserted value', () => {
    expect(say('`\n  > ${"""a\nb"""}\n  `')).toBe('> a\nb');
  });

  test('normalizes NFC across literal and hole boundaries', () => {
    expect(say('`e${"́"}`')).toBe('é');
  });

  test('decodes JavaScript escapes, identity escapes and escaped interpolation', () => {
    expect(say('`\\x41\\u0042\\u{1F600}\\q \\${name} \\``')).toBe(
      'AB😀q ${name} `',
    );
  });

  test('combines escaped surrogate pairs into a Unicode scalar', () => {
    expect(say('`\\uD83D\\uDE00`')).toBe('😀');
  });

  test('strips margins before processing a backslash line continuation', () => {
    expect(say('`\n  first\\\n  second\n  `')).toBe('firstsecond');
  });

  test('retains existing double-quoted text as literal', () => {
    expect(say('"${name} \\n"')).toBe('${name} \\n');
  });
});

describe('fenced text compilation', () => {
  test('preserves original source including hole trivia losslessly', () => {
    const source = 'constant x = `\r\n\t ${1 + -- comment\r\n2}\r\n\t `';
    const result = parseSource(source);
    expect(result.error).toBeNull();
    expect(syntaxText(result.tree!)).toBe(source);
  });

  test('allows hole-free forms in map keys and Text Patterns', () => {
    expect(checkSource('constant m = {`key`: 1, """other""": 2}').ok).toBe(
      true,
    );
    expect(checkSource('constant p = <`a`, """b""">').ok).toBe(true);
  });

  test('allows earlier Constants in holes', () => {
    const host = new SessionHost({ now: () => 0n });
    expect(host.input('constant n = 3')).toEqual([]);
    expect(host.input('constant message = `n=${n}`')).toEqual([]);
    expect(host.input('say message')).toEqual(['n=3']);
  });

  test('retains Guard restrictions inside holes', () => {
    const result = checkSource(
      'function f\n return 1\nend f\non t where `${f()}` = "1"\nend t',
    );
    expect(result.error).toBeNull();
    expect(result.diagnostics.map(d => d.code)).toContain('not in a guard');
  });

  test('lowers holes without folding, retaining the empty initial literal', () => {
    const result = compileSource('on t\n return `${1}${2}x`\nend t', {
      name: 'test',
    });
    expect(result.error).toBeNull();
    expect(result.diagnostics).toEqual([]);
    const unit = result.unit!;
    const body = unit.bodies[1]!;
    expect(
      unit.code
        .slice(body.start, body.start + 7)
        .map(i => [i.op, i.line, i.col]),
    ).toEqual([
      ['const', 2, 9],
      ['const', 2, 12],
      ['concat', 2, 10],
      ['const', 2, 16],
      ['concat', 2, 14],
      ['const', 2, 14],
      ['concat', 2, 14],
    ]);
  });
});

describe('unfinished fenced text Entries', () => {
  test.each(['`hello', '"""hello', '`value ${1 +', '`value ${`nested'])(
    'waits for completion of %s',
    source => {
      const result = parseEntry(source, () => false);
      expect(result.error).not.toBeNull();
      expect(result.error && result.incomplete).toBe(true);
    },
  );

  test('blank lines inside a literal do not end the Entry', () => {
    const result = parseEntry('`\nhello\n\n', () => false);
    expect(result.error && result.incomplete).toBe(true);
    expect(parseEntry('`\nhello\n\n`', () => false).error).toBeNull();
  });

  test('a closed literal still waits for its enclosing expression', () => {
    const result = parseEntry('(`hello`', () => false);
    expect(result.error && result.incomplete).toBe(true);
    expect(parseEntry('(`hello`)', () => false).error).toBeNull();
  });
});

describe('fenced text diagnostics', () => {
  test.each([String.raw`\xGG`, '${"""x""""}'])(
    'reports the earlier expression syntax error before a later malformed tail %s',
    tail => {
      const result = parseEntry('`${1 + return}' + tail + '`', () => false);
      expect(result.error?.code).toBe('unexpected token');
      expect(result.error?.tok).toMatchObject({ line: 1, col: 8 });
    },
  );

  test('identity escapes preserve a non-BMP Unicode scalar', () => {
    expect(say('`\\😀`')).toBe('😀');
  });

  test('hole diagnostics count non-BMP source characters as single columns', () => {
    const result = checkSource('on t\n return `\\😀 ${missing}`\nend t');
    expect(result.error).toBeNull();
    expect(
      result.diagnostics.map(d => [d.code, d.span.line, d.span.col]),
    ).toEqual([['unknown name', 2, 15]]);
  });

  test('deeply nested templates do not depend on the native call stack', () => {
    const expression = '`${'.repeat(3000) + '1' + '}`'.repeat(3000);
    const source = 'constant value = ' + expression;
    const result = parseSource(source);
    expect(result.error).toBeNull();
    expect(syntaxText(result.tree!)).toBe(source);
  }, 30_000);

  test.each([
    String.raw`\xGG`,
    String.raw`\u{110000}`,
    String.raw`\uD800`,
    String.raw`\uDC00`,
    String.raw`\01`,
    String.raw`\8`,
  ])('rejects malformed or non-scalar escape %s at its backslash', escape => {
    const result = parseEntry('`a' + escape + '`', () => false);
    expect(result.error?.tok).toMatchObject({ line: 1, col: 3 });
    expect(result.error && result.incomplete).toBe(false);
  });

  test('an indentation mismatch identifies the first differing character', () => {
    const result = parseEntry('`\n \ttext\n  `', () => false);
    expect(result.error?.tok).toMatchObject({ line: 2, col: 2 });
    expect(result.error && result.incomplete).toBe(false);
  });

  test.each(['`', '"""'])(
    'a non-whitespace closing margin identifies its first offending character for %s',
    fence => {
      const result = parseEntry(
        `${fence}\n  first\n \tbad${fence}`,
        () => false,
      );
      expect(result.error?.code).toBe('invalid text indentation');
      expect(result.error?.tok).toMatchObject({ line: 3, col: 3 });
      expect(result.error && result.incomplete).toBe(false);
    },
  );

  test('EOF inside nested text points to the innermost opener', () => {
    const result = parseEntry('`outer ${`inner', () => false);
    expect(result.error?.tok).toMatchObject({ line: 1, col: 10 });
    expect(result.error && result.incomplete).toBe(true);
  });
});
