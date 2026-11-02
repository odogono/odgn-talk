// Perform's layout settings (#1999): the divider and code zoom are kept in
// range and remembered for each Project.
import { expect, test } from 'bun:test';
import {
  clockText,
  DEFAULT_PERFORM,
  loadPerform,
  normalPerform,
  recentTabs,
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

const tab = (id: number) => ({
  label: `Script ${id}`,
  source: { kind: 'script' as const, id },
});

test('the code pane keeps recent Scripts as tabs, in place, up to the limit', () => {
  let state = recentTabs([], tab(1));
  state = recentTabs(state.tabs, tab(2));
  expect(state.current).toBe(1);
  state = recentTabs(state.tabs, { ...tab(1), label: 'renamed' });
  expect(state).toEqual({
    current: 0,
    tabs: [{ ...tab(1), label: 'renamed' }, tab(2)],
  });
  state = recentTabs(state.tabs, tab(3), 2);
  expect(state.tabs.map(t => t.source.id)).toEqual([2, 3]);
  expect(state.current).toBe(1);
});

test('the toolbar counts the bar on from the worker’s anchor by the tempo', () => {
  expect(clockText(undefined, 0)).toBe('');
  expect(clockText({ at: 0, beatsPerBar: 4, tempo: 120 }, 5000)).toBe(
    '120 BPM',
  );
  const anchor = { at: 1000, beatsPerBar: 4, count: 5.5, tempo: 120 };
  expect(clockText(anchor, 1000)).toBe('120 BPM · bar 2.2');
  // Two beats a second at 120 BPM.
  expect(clockText(anchor, 2000)).toBe('120 BPM · bar 2.4');
  expect(clockText(anchor, 2500)).toBe('120 BPM · bar 3.1');
});
