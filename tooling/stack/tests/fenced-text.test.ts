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
