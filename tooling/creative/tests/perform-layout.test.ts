// Perform's layout settings (#1999): the divider and code zoom are kept in
// range and remembered for each Project.
import { expect, test } from 'bun:test';
import {
  DEFAULT_PERFORM,
  loadPerform,
  normalPerform,
  savePerform,
  zoomed,
} from '../src/perform-layout';

const memoryStorage = (): Storage => {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: key => items.get(key) ?? null,
    key: index => [...items.keys()][index] ?? null,
    removeItem: key => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
};

test('settings are kept in range, and anything broken is the default', () => {
  expect(normalPerform(undefined)).toEqual(DEFAULT_PERFORM);
  expect(normalPerform({ split: 2, zoom: -1 })).toEqual({
    split: 0.8,
    zoom: 0.5,
  });
  expect(normalPerform({ split: 'wide', zoom: Number.NaN })).toEqual(
    DEFAULT_PERFORM,
  );
});

test('each Project remembers its own divider and zoom', () => {
  const storage = memoryStorage();
  savePerform('set one', { split: 0.5, zoom: 1.4 }, storage);
  savePerform('set two', { split: 0.7, zoom: 1 }, storage);
  expect(loadPerform('set one', storage)).toEqual({ split: 0.5, zoom: 1.4 });
  expect(loadPerform('set two', storage)).toEqual({ split: 0.7, zoom: 1 });
  expect(loadPerform('new set', storage)).toEqual(DEFAULT_PERFORM);
  storage.setItem('northtalk-creative-perform', '{not json');
  expect(loadPerform('set one', storage)).toEqual(DEFAULT_PERFORM);
});

test('⌘+ and ⌘− step the zoom within its range', () => {
  expect(zoomed(1, 1)).toBe(1.1);
  expect(zoomed(1, -1)).toBe(0.9);
  expect(zoomed(3, 1)).toBe(3);
  expect(zoomed(0.5, -1)).toBe(0.5);
});
