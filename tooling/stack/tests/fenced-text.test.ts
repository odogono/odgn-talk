import { expect, test } from 'bun:test';
import { SessionHost } from '../../../impl/ts/src/session';
import { formatSource } from '../src/format';

const output = (source: string) => {
  const host = new SessionHost({ now: () => 0n });
  expect(host.input(source)).toEqual([]);
  return host.input('go').join('\n');
};

test.each([
  [
    'inline multiline',
    '` first  \n\n    second \n `',
    ' first  \n\n    second \n ',
  ],
  [
    'margin and trailing spaces',
    '`\n    first  \n\n      second\n    \n    `',
    'first  \n\n  second\n',
  ],
  [
    'raw exact tab margin',
    '"""\n\t first  \n\t\n\t second\n\t """',
    'first  \n\nsecond',
  ],
  ['nested interpolation', '`\n  > ${`inner ${1+2}`}\n  `', '> inner 3'],
  [
    'nested raw margin',
    '`outer ${"""\n  first\n  second\n  """}`',
    'outer first\nsecond',
  ],
  ['backslash continuation', '`\n  first\\\n  second\n  `', 'firstsecond'],
])(
  'formatting preserves %s values and is idempotent',
  (_name, expression, expected) => {
    const source = '  on go\n say  ' + expression + '\n end go';
    expect(output(source)).toBe(expected!);
    const formatted = formatSource(source);
    expect(formatted.error).toBeNull();
    expect(output(formatted.source)).toBe(expected!);
    expect(formatSource(formatted.source)).toEqual(formatted);
  },
);

test('formatting keeps a syntax error inside a hole untouched', () => {
  const source = ' on go\n say `${1 + return}\\xGG`\n end go';
  const result = formatSource(source);
  expect(result.source).toBe(source);
  expect(result.error?.code).toBe('unexpected token');
  expect(result.error?.tok).toMatchObject({ line: 2, col: 13 });
});

test('formatting coordinates closing margins with literal prefixes and formats hole code', () => {
  const source =
    ' on go\n say `\n\t first  \n\n\t value ${1+\n2}\n\t `\n end go';
  const formatted = formatSource(source);
  expect(formatted).toEqual({
    source: 'on go\n  say `\n  first  \n\n  value ${1 +\n    2}\n  `\nend go',
    error: null,
  });
  expect(output(formatted.source)).toBe('first  \n\nvalue 3');
  expect(formatSource(formatted.source)).toEqual(formatted);
});

test('formatting gives nested literals their own margins without changing inline content', () => {
  const source =
    'on go\nsay ` inline ${"""\n\t first  \n\t second\n\t """} tail\n  unchanged `\nend go';
  const formatted = formatSource(source);
  expect(formatted.source).toBe(
    'on go\n  say ` inline ${"""\n  first  \n  second\n  """} tail\n  unchanged `\nend go',
  );
  expect(output(formatted.source)).toBe(output(source));
  expect(formatSource(formatted.source)).toEqual(formatted);
});

test.each([
  ['hole at the start of a content line', '`\n    ${1+2}\n    `', '3'],
  ['multiple holes', '`\n    ${1} ${2}\n    `', '1 2'],
  [
    'block Lambda in a hole',
    '`${the length of [given\nreturn 1+2\nend given]}`',
    '1',
  ],
  [
    'short blank prefixes and significant trailing spaces',
    '"""\n\t x  \n\t\n\t   \n\t """',
    'x  \n\n  ',
  ],
  ['CRLF margins', '"""\r\n\t x  \r\n\r\n\t y\r\n\t """', 'x  \n\ny'],
  ['empty raw fence', '"""\n    """', ''],
  [
    'comments before a hole closes',
    '`value ${1+2 -- comment  \n} tail`',
    'value 3 tail',
  ],
])('formatting preserves %s', (_name, expression, expected) => {
  const formatted = formatSource('on go\nsay ' + expression + '\nend go');
  expect(formatted.error).toBeNull();
  expect(output(formatted.source)).toBe(expected!);
  expect(formatSource(formatted.source)).toEqual(formatted);
});
