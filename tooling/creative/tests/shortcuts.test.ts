import { expect, test } from 'bun:test';
import { commandForKey } from '../src/shortcuts';

test('editing shortcuts support Command and Control, and never run while typing', () => {
  for (const modifier of ['metaKey', 'ctrlKey']) {
    for (const [key, shiftKey, command] of [
      ['z', false, 'undo'],
      ['Z', true, 'redo'],
      ['d', false, 'duplicate'],
    ] as const) {
      const event = {
        key,
        shiftKey,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        [modifier]: true,
      };
      expect(commandForKey(event, false)).toBe(command);
      expect(commandForKey(event, true)).toBeUndefined();
    }
  }
  for (const key of ['Delete', 'Backspace']) {
    const event = {
      key,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    };
    expect(commandForKey(event, false)).toBe('delete');
    expect(commandForKey(event, true)).toBeUndefined();
  }
  expect(
    commandForKey(
      {
        key: 'd',
        shiftKey: false,
        metaKey: true,
        ctrlKey: false,
        altKey: true,
      },
      false,
    ),
  ).toBeUndefined();
});
