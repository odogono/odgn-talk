import { expect, test } from 'bun:test';
import { scriptMessages } from '../src/script-messages';

test('lists each named Handler Clause head without Guards, suffixes or the Fallback', () => {
  expect(
    scriptMessages(
      [
        'shape Line is {sku: text}',
        'on move item is a Line to place is a number where place > 0',
        '  return place',
        'end move',
        'on click, queued',
        'end click',
        'on any message m',
        'end any message',
      ].join('\n'),
    ),
  ).toEqual(['on move item is a Line to place is a number', 'on click']);
  expect(scriptMessages(undefined)).toEqual([]);
});
