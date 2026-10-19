import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compileSource } from '../src/lowering';
import { deliver, loadScript } from '../src/machine';
import { newGroup, restore } from '../src/index';
import { charge, rateOf, sizeOf } from '../src/costs';
import {
  appendTo,
  chunkDelete,
  chunkSet,
  deleteKey,
  setKey,
} from '../src/operations';
import {
  dec,
  listValues,
  map,
  nothing,
  num,
  range,
  text,
  type Value,
} from '../src/values';

const checkList = (value: Value, items: readonly Value[]) => {
  expect(value.length).toBe(items.length);
  for (let i = 0; i < items.length; i++) {
    expect(value.index(i + 1).equals(items[i]!)).toBe(true);
  }
  expect(value.index(items.length + 1)).toBe(nothing);
  expect(sizeOf(value)).toBe(sizeOf(listValues(items)));
};

test('List replacements preserve chunk boundaries and growth after endpoint deletion', () => {
  for (const length of [1, 31, 32, 33, 1024, 1100]) {
    const items = Array.from({ length }, (_, i) => num(i));
    const original = listValues(items);
    let value = original;
    // Empty endpoint chunks without renumbering the remaining keys.
    if (length > 64) {
      for (let i = 0; i < 32; i++) {
        value = chunkDelete('item', num(1), value, null);
        items.shift();
      }
      const tail = items.length % 32 || 32;
      for (let i = 0; i < tail; i++) {
        value = chunkDelete('item', num(-1), value, null);
        items.pop();
      }
    }
    const retained = value;
    const before = [...items];
    const part = listValues([text('replacement'), nothing]);
    for (const i of new Set([
      0,
      31,
      32,
      Math.floor(items.length / 2),
      items.length - 1,
    ])) {
      if (i < items.length) {
        value = chunkSet('item', num(i + 1), value, part, null);
        items[i] = part;
      }
    }
    checkList(value, items);
    checkList(retained, before);
    checkList(
      original,
      Array.from({ length }, (_, i) => num(i)),
    );
    checkList(appendTo(value, part, 'append'), [...items, part]);
    checkList(appendTo(value, part, 'prepend'), [part, ...items]);
  }
});

test('List point writes agree for positive, negative and general numeric indexes', () => {
  const items = [num(1), num(2), num(3)];
  const original = listValues(items);
  for (const index of [num(2), num(-2), dec('2.0'), dec('-2.0')]) {
    const part = listValues([text('nested'), nothing]);
    checkList(chunkSet('item', index, original, part, null), [
      items[0]!,
      part,
      items[2]!,
    ]);
    checkList(chunkSet('item', index, original, nothing, null), [
      items[0]!,
      nothing,
      items[2]!,
    ]);
    checkList(original, items);
  }
  checkList(chunkSet('item', num(5), original, num(9), null), [
    ...items,
    nothing,
    num(9),
  ]);
  checkList(
    chunkSet(
      'item',
      range(num(2), num(2)),
      original,
      listValues([nothing, nothing]),
      null,
    ),
    [items[0]!, nothing, nothing, items[2]!],
  );
  for (const index of [
    num(0),
    num(-4),
    num(-(10n ** 30n)),
    num(1.5),
    text('2'),
  ]) {
    expect(() => chunkSet('item', index, original, nothing, null)).toThrow();
    checkList(original, items);
  }
});

test('persistent List edits, deletion and branched growth match a flat sequence', () => {
  const nested = map([['é', listValues([text('nested'), nothing])]]);
  const items = Array.from({ length: 1100 }, (_, i) => num(i));
  let value = listValues(items);
  const retained: [Value, Value[]][] = [];
  for (let step = 0; step < 1200; step++) {
    if (step % 100 === 0) {
      retained.push([value, [...items]]);
    }
    const i = (step * 7919) % items.length;
    if (step % 5 === 0) {
      value = chunkDelete('item', num(i + 1), value, null);
      items.splice(i, 1);
    } else if (step % 5 === 1) {
      value = appendTo(value, nested, 'prepend');
      items.unshift(nested);
    } else if (step % 5 === 2) {
      value = appendTo(value, nested, 'append');
      items.push(nested);
    } else {
      value = chunkSet('item', num(i + 1), value, nested, null);
      items[i] = nested;
    }
  }
  checkList(value, items);
  for (const [old, expected] of retained) {
    checkList(old, expected);
    checkList(appendTo(old, nested, 'append'), [...expected, nested]);
    checkList(appendTo(old, nested, 'prepend'), [nested, ...expected]);
  }
  const padded = chunkSet('item', num(value.length + 3), value, nested, null);
  checkList(padded, [...items, nothing, nothing, nested]);
  let small = listValues([nothing]);
  small = chunkDelete('item', num(1), small, null);
  checkList(appendTo(small, nested, 'prepend'), [nested]);
});

test('persistent Maps preserve key presence, order, aliases and logical sizes', () => {
  const nested = listValues([text('é'), map([['child', nothing]])]);
  let value = map([]);
  const expected = new Map<string, Value>();
  const retained: [Value, Map<string, Value>][] = [];
  for (let step = 0; step < 1600; step++) {
    if (step % 100 === 0) {
      retained.push([value, new Map(expected)]);
    }
    const key = `key-${(step * 73) % 211}`;
    if (step % 4 === 0) {
      value = deleteKey(value, key);
      expected.delete(key);
    } else {
      const part = step % 3 === 0 ? nothing : nested;
      value = setKey(value, key, part);
      expected.set(key, part);
    }
  }
  retained.push([value, expected]);
  for (const [actual, entries] of retained) {
    expect(actual.mapSize).toBe(entries.size);
    expect(actual.entries()).toEqual([...entries]);
    expect(sizeOf(actual)).toBe(sizeOf(map(entries)));
    expect(charge(rateOf('map'), { result: actual }).alloc).toBe(
      sizeOf(actual),
    );
    for (const [key, part] of entries) {
      expect(actual.hasKey(key)).toBe(true);
      expect(actual.get(key)).toBe(part);
    }
    const sibling = setKey(actual, 'new', nothing);
    expect(sibling.entries().at(-1)).toEqual(['new', nothing]);
    expect(actual.entries()).toEqual([...entries]);
  }
  const normalized = setKey(setKey(value, 'e\u0301', nothing), 'é', nested);
  expect(normalized.mapSize).toBe(value.mapSize + 1);
  expect(normalized.get('e\u0301')).toBe(nested);
  const reordered = setKey(deleteKey(normalized, 'key-73'), 'key-73', nothing);
  expect(reordered.entries().at(-1)).toEqual(['key-73', nothing]);
  const exported = reordered.entries();
  exported[0]![0] = 'mutated';
  expect(reordered.hasKey('mutated')).toBe(false);
});

const editSource = readFileSync(
  new URL('../../testdata/collection-edits.talk', import.meta.url),
  'utf8',
);

test('collection edits keep baseline Fuel, allocation and retained results across rollback', () => {
  const script = loadScript(compileSource(editSource, { name: 'test' }).unit!);
  const original = script.variables[0]!;
  const run = deliver(script, 'edit', []);
  const result = run.finish();
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') {
    throw new Error(result.kind);
  }
  // Same output, Fuel and logical allocation as e35980e9, before structural sharing.
  expect(run.fuel).toBe(4409);
  expect(run.alloc).toBe(18_059);
  const retained = result.result.toString();
  expect(result.result.index(1).equals(original)).toBe(true);
  expect(result.result.index(2).get('é')).toBe(nothing);
  expect(result.result.index(2).mapSize).toBe(82);
  expect(result.result.index(3).index(2).toString()).toBe('2');
  expect(result.result.index(4).index(2).toString()).toBe('80');
  expect(result.result.index(5).entries().at(-1)![0]).toBe('é');
  for (const limits of [{ fuelPerRun: 800 }, { allocPerRun: 1000 }]) {
    const fault = deliver(script, 'fault', [], limits);
    while (!fault.done) {
      fault.step();
    }
    expect(fault.ended?.kind).toBe('limit fault');
    expect(script.variables[0]!.equals(original)).toBe(true);
    expect(result.result.toString()).toBe(retained);
  }
});

test('Save/Restore reconstructs persistent collections and the rollback checkpoint', () => {
  const original: string[] = [];
  const group = newGroup({
    name: 'original',
    trace: line => original.push(line),
  });
  const script = group.load({
    name: 's',
    source: editSource,
    limits: { fuelPerRun: 800 },
  });
  const before = group.inspect().scripts[0]!.vars[0]![1].toString();
  script.deliver({ name: 'fault' });
  group.pump(1n, { fuelSlice: 100 });
  expect(group.inspect().scripts[0]!.vars[0]![1].toString()).not.toBe(before);
  const resumed: string[] = [];
  const { group: copy } = restore(group.save(), {
    name: 'resumed',
    trace: line => resumed.push(line),
    libraries: [],
    grants: () => undefined,
    resolve: () => undefined,
    onMismatch: 'reject',
  });
  original.length = 0;
  resumed.length = 0;
  group.pump(2n);
  copy.pump(2n);
  expect(resumed).toEqual(original);
  expect(copy.inspect().scripts[0]!.vars[0]![1].toString()).toBe(before);
});
