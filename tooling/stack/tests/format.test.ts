import { expect, test } from 'bun:test';
import { checkSource, compileSource, disassemble } from '@odgn/northtalk';
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

test("indents a Timeout Block's body and keeps its ending", () => {
  expect(
    formatSource(
      'on t\nwith   timeout of 5 s\n      wait 1 s\nwith timeout of 1 s\nwait for done\n   end\n      end timeout\nend t\n',
    ).source,
  ).toBe(
    'on t\n  with timeout of 5 s\n    wait 1 s\n    with timeout of 1 s\n      wait for done\n    end\n  end timeout\nend t\n',
  );
});

test('spaces a Whose Clause like any other expression', () => {
  expect(
    formatSource(
      'on t xs\nput   every  item of xs   whose   amount>1 into ys\n  return the  first item of xs delimited by ";"  whose (every item of it whose it>1) is not empty\nend t\n',
    ).source,
  ).toBe(
    'on t xs\n  put every item of xs whose amount > 1 into ys\n  return the first item of xs delimited by ";" whose (every item of it whose it > 1) is not empty\nend t\n',
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

const docs = (text: string) => checkSource(text).tree!.docs;
const canonical = (text: string) =>
  text.replaceAll(/^( {2}\d{4,} )\d+:\d+ /gm, '$1');

test('keeps Declaration Documentation attached, unmoved and separated', () => {
  const source =
    '  --| Adds one.\n\t--|   indented\nfunction inc n\nreturn n + 1\nend inc\n--| detached\n\n\n\nconstant k = 1\n-- plain\n--| after plain\non go\n--| inside a body\nsay inc(k)\nend go\n';
  const formatted = formatSource(source).source;
  expect(formatted).toBe(
    '--| Adds one.\n--|   indented\nfunction inc n\n  return n + 1\nend inc\n--| detached\n\nconstant k = 1\n-- plain\n--| after plain\non go\n  --| inside a body\n  say inc(k)\nend go\n',
  );
  expect(formatSource(formatted).source).toBe(formatted);
  expect(docs(formatted)).toEqual(docs(source));
  expect(docs(formatted)).toEqual(['Adds one.\n  indented', '', 'after plain']);
});

test('marked comments preserve documentation and executable disassembly across formatting', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const source = [
      '  --| Function.',
      '--|',
      '--|  spaces  ',
      'function inc n',
      'return n+1',
      'end inc --| trailing',
      '--| detached',
      '',
      'constant k=2',
      '--| interrupted',
      '-- ordinary',
      'script variable v=3',
      '--| Handler.',
      'on go',
      'say inc(k)',
      'end go',
      '',
    ].join(newline);
    const formatted = formatSource(source);
    expect(formatted.error).toBeNull();
    expect(formatSource(formatted.source)).toEqual(formatted);
    expect(docs(formatted.source)).toEqual(docs(source));
    expect(docs(formatted.source)).toEqual([
      'Function.\n\n spaces  ',
      '',
      '',
      'Handler.',
    ]);
    const before = compileSource(source, { name: 'docs' }).unit!;
    const after = compileSource(formatted.source, { name: 'docs' }).unit!;
    // Formatting changes source positions, not executable disassembly.
    expect(canonical(disassemble(after))).toBe(canonical(disassemble(before)));
  }
});
