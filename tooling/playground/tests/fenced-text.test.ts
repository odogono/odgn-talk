import { expect, test } from 'bun:test';
import { StringStream } from '@codemirror/language';
import { northtalkParser } from '../src/language';

const state = () => northtalkParser.startState!(2);
const tokens = (line: string, current: ReturnType<typeof state>) => {
  const stream = new StringStream(line, 2, 2);
  const result: [string, string | null][] = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const style = northtalkParser.token(stream, current);
    expect(stream.pos).toBeGreaterThan(stream.start);
    result.push([stream.current(), style]);
  }
  return result;
};

test('highlighter resumes literal text after nested templates and maps', () => {
  const current = state();
  const result = tokens(
    '`outer ${`inner ${the x of {x: 3}}`} tail` + 4',
    current,
  );
  expect(result).toContainEqual(['outer ', 'string']);
  expect(result).toContainEqual(['inner ', 'string']);
  expect(result).toContainEqual(['3', 'number']);
  expect(result).toContainEqual([' tail', 'string']);
  expect(result).toContainEqual(['4', 'number']);
  expect(current.regions).toEqual([]);
});

test('highlighter carries raw fence width across lines and leaves placeholders literal', () => {
  const current = state();
  tokens('""""', current);
  expect(tokens('${name} """ remains raw', current)).toEqual([
    ['${name} """ remains raw', 'string'],
  ]);
  expect(tokens('"""" + 4', current)).toContainEqual(['4', 'number']);
  expect(current.regions).toEqual([]);
});

test('highlighter copies nested state independently across multiline holes', () => {
  const current = state();
  tokens('`before ${', current);
  const copied = northtalkParser.copyState!(current);
  tokens('{x: 3}', copied);
  tokens('} after`', copied);
  expect(copied.regions).toEqual([]);
  expect(tokens('1} original`', current)).toContainEqual([
    ' original',
    'string',
  ]);
  expect(current.regions).toEqual([]);
});

test('escaped interpolation remains string content', () => {
  const current = state();
  expect(tokens('`\\${name} \\` tail`', current)).toEqual([
    ['`', 'operator'],
    ['\\${name} \\` tail', 'string'],
    ['`', 'operator'],
  ]);
  expect(current.regions).toEqual([]);
});

test('a raw closer must match the maximal quote run exactly', () => {
  const current = state();
  tokens('"""', current);
  expect(tokens('""""', current)).toEqual([['""""', 'invalid']]);
  expect(current.regions).toEqual([{ kind: 'raw', width: 3 }]);
  expect(tokens('""" + 1', current)).toContainEqual(['1', 'number']);
});
