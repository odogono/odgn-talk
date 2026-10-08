import { expect, test } from 'bun:test';
import { formatSource } from '../src/format';

test('indents blocks and normalises spaces without changing token spelling', () => {
  expect(
    formatSource(
      '  on Greet name\n\tif name="Ann" then\nsay  "Hi"\n else\nsay [ 1,2 ]\nend if\n end Greet',
    ),
  ).toEqual({
    source:
      'on Greet name\n  if name = "Ann" then\n    say "Hi"\n  else\n    say [1, 2]\n  end if\nend Greet',
    error: null,
  });
});

test('keeps comment text, a BOM, line endings and a missing final newline', () => {
  expect(
    formatSource(
      '\uFEFF  on go\r\n --  before  \r\nsay 1-- tail  \r\n -- closing\r\nend go',
    ).source,
  ).toBe(
    '\uFEFFon go\r\n  --  before  \r\n  say 1 -- tail  \r\n  -- closing\r\nend go',
  );
});

test('collapses only blank lines, including whitespace-only lines', () => {
  expect(
    formatSource('\n \n\ton go\n\n \n\t\n say 1\n\n\nend go\n\n\n').source,
  ).toBe('\non go\n\n  say 1\n\nend go\n\n');
});

test('leaves syntax errors untouched and reports the Core error', () => {
  const source = '  on go\n put 1+ into x\nend go\n';
  const result = formatSource(source);
  expect(result.source).toBe(source);
  expect(result.error?.code).toBe('unexpected token');
});

test('formats branch bodies, handler cleanup, joins and block Lambdas', () => {
  const source = [
    'on go',
    'match 1',
    'when 1 then',
    'say 1',
    'else say 2',
    'end match',
    'wait for',
    'when ping then',
    'say 3',
    'after 1 s then say 4',
    'end wait',
    'try',
    'wait for all',
    'send ping to me',
    'end wait',
    'catch e',
    'say e',
    'finally',
    'say 5',
    'end try',
    'put given x',
    'return x+1',
    'end given into f',
    'finally',
    'say 6',
    'end go',
    '',
  ].join('\n');
  expect(formatSource(source).source).toBe(
    [
      'on go',
      '  match 1',
      '    when 1 then',
      '      say 1',
      '    else say 2',
      '  end match',
      '  wait for',
      '    when ping then',
      '      say 3',
      '    after 1 s then say 4',
      '  end wait',
      '  try',
      '    wait for all',
      '      send ping to me',
      '    end wait',
      '  catch e',
      '    say e',
      '  finally',
      '    say 5',
      '  end try',
      '  put given x',
      '    return x + 1',
      '  end given into f',
      'finally',
      '  say 6',
      'end go',
      '',
    ].join('\n'),
  );
});

test('keeps lexical spacing for commands, calls, negative numbers, pins and patterns', () => {
  const source =
    'on go\nsay ( 1+2 )\nput abs(- 1) into x\nput - - 2 into x\nput < "ID-", n: 4 digits > into p\nput << 1 as uint16 , 2 as uint8 >> into b\nlet [^ x,...rest] be [1,2]\nend go\n';
  expect(formatSource(source).source).toBe(
    'on go\n  say (1 + 2)\n  put abs(-1) into x\n  put - -2 into x\n  put <"ID-", n: 4 digits> into p\n  put << 1 as uint16, 2 as uint8 >> into b\n  let [^x, ...rest] be [1, 2]\nend go\n',
  );
});

test('keeps continuation line breaks and indents continuations', () => {
  expect(
    formatSource(
      'constant x = [ 1,\n2,\n3 ]\non go\nput 1 +\n2 into y\nend go\n',
    ).source,
  ).toBe(
    'constant x = [1,\n  2,\n  3]\non go\n  put 1 +\n    2 into y\nend go\n',
  );
});

test('keeps nested Text Pattern openers separate from Binary Patterns', () => {
  const source = 'constant p = < <4 digits>, "x">\n';
  expect(formatSource(source).source).toBe(source);
});

test('formats block waits containing only a timeout branch', () => {
  expect(
    formatSource('on go\nwait for\nafter 1 s then\nsay 1\nend wait\nend go\n')
      .source,
  ).toBe(
    'on go\n  wait for\n    after 1 s then\n      say 1\n  end wait\nend go\n',
  );
});

test("indents a tell block's lines and comments, and keeps its ending", () => {
  expect(
    formatSource(
      'on draw\ntell canvas\n      fill "red"   -- c\n\n  -- next\n        rectangle 1, 2\n    load x and wait\n      end tell\ntell log to write "x"\nend draw\n',
    ).source,
  ).toBe(
    'on draw\n  tell canvas\n    fill "red" -- c\n\n    -- next\n    rectangle 1, 2\n    load x and wait\n  end tell\n  tell log to write "x"\nend draw\n',
  );
});

test('treats punctuation inside text as text', () => {
  for (const punctuation of [
    '[',
    '(',
    '{',
    '..',
    '...',
    ',',
    ':',
    "'s",
    '^',
    '-',
    '<',
    '>',
  ]) {
    expect(
      formatSource(`on go\nput "${punctuation}" into x\nend go\n`).source,
    ).toBe(`on go\n  put "${punctuation}" into x\nend go\n`);
  }
});

test('formats offers and guarded recovery, with bare zero-argument choices', () => {
  const source =
    'on demo\ntry\nput 1 into x\noffer skip\noffer useValue value,extra\nput value+extra into x\ncatch e before unwind where true\nchoose offer skip() -- zero\nchoose offer useValue( 1,2 )\nfinally\nsay x\nend try\nend demo';
  const expected =
    'on demo\n  try\n    put 1 into x\n  offer skip\n  offer useValue value, extra\n    put value + extra into x\n  catch e before unwind where true\n    choose offer skip -- zero\n    choose offer useValue(1, 2)\n  finally\n    say x\n  end try\nend demo';
  const result = formatSource(source);
  expect(result.error).toBeNull();
  expect(result.source).toBe(expected);
  expect(formatSource(result.source).source).toBe(expected);
});

test('keeps comments from empty offer argument lists when printing the bare form', () => {
  const source =
    'on demo\ntry\ncatch e before unwind\nchoose offer skip( -- keep\n)\nend try\nend demo';
  const result = formatSource(source);
  expect(result.error).toBeNull();
  expect(result.source).toContain('choose offer skip -- keep');
  expect(result.source).not.toContain('skip(');
  expect(formatSource(result.source)).toEqual(result);
});
