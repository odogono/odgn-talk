import { expect, test } from 'bun:test';
import { lint } from '../src/lint';

test('lints inspect hole code while raw and escaped placeholder content stays literal', () => {
  const source =
    'on go\nsay `value ${the "title" of {} is empty}`\nsay """${the "title" of {} is empty}"""\nsay `\\${the "title" of {} is empty}`\nend go';
  const result = lint(source);
  expect(result.diagnostics).toEqual([]);
  expect(result.lints.map(item => [item.id, item.span.line])).toEqual([
    ['is-empty-on-missing-key', 2],
  ]);
});

test('raw and hole-free backtick values participate in literal conversion advice', () => {
  const source =
    'on go\nput """bad""" as instant into a\nput `bad` as instant into b\nput `bad ${1}` as instant into c\nend go';
  expect(lint(source).lints.map(item => [item.id, item.span.line])).toEqual([
    ['unconvertible-literal', 2],
    ['unconvertible-literal', 3],
  ]);
});
