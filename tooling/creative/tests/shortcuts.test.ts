import { expect, test } from 'bun:test';
import { commandForKey, isPlayKey, menuButtonForKey } from '../src/shortcuts';

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

const key = (key: string, extra: Partial<KeyboardEvent> = {}) => ({
  key,
  shiftKey: false,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  ...extra,
});

test('File menu shortcuts name their buttons, and Command+Return plays', () => {
  expect(menuButtonForKey(key('s'))).toBe('save-file');
  expect(menuButtonForKey(key('S', { shiftKey: true }))).toBe('save-file-as');
  expect(menuButtonForKey(key('o', { metaKey: false, ctrlKey: true }))).toBe(
    'show-projects',
  );
  expect(menuButtonForKey(key('O', { shiftKey: true }))).toBe('import-project');
  expect(menuButtonForKey(key('s', { metaKey: false }))).toBeUndefined();
  expect(menuButtonForKey(key('s', { altKey: true }))).toBeUndefined();
  expect(menuButtonForKey(key('n'))).toBeUndefined();
  expect(isPlayKey(key('Enter'))).toBe(true);
  expect(isPlayKey(key('Enter', { metaKey: false, ctrlKey: true }))).toBe(true);
  expect(isPlayKey(key('Enter', { metaKey: false }))).toBe(false);
  expect(isPlayKey(key('Enter', { shiftKey: true }))).toBe(false);
  expect(isPlayKey(key('z'))).toBe(false);
});
