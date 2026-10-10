import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compileSource } from '../src/lowering';
import { deliver, loadScript } from '../src/machine';
import { appendTo } from '../src/operations';
import { charge, rateOf, sizeOf } from '../src/costs';
import { list, nothing, num, text } from '../src/values';
import { newGroup, restore } from '../src/index';

const source = readFileSync(
  new URL('../../testdata/list-growth.talk', import.meta.url),
  'utf8',
);
const expected =
  '[[[1, 2], [0, 9, 2, 3, 4, 0, 1, 2, 3, 4], [-1, 1, 2, 3, 5, -1, 1, 2, 3, 5]], 128, 1, 64, [1, 2, 3], [1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3]]';

test('List growth preserves aliases, collecting snapshots and rollback across Runs', () => {
  const unit = compileSource(source, { name: 'test' }).unit!;
  const script = loadScript(unit);
  const first = deliver(script, 'grow', []);
  const outcome = first.finish();
  expect(outcome.kind).toBe('completed');
  if (outcome.kind !== 'completed') {
    throw new Error(outcome.kind);
  }
  expect(outcome.result.toString()).toBe(expected);
  // Verified against the slice-copying Core at 2372361.
  expect(first.fuel).toBe(1979);
  expect(first.alloc).toBe(6664);
  for (const limits of [{ fuelPerRun: 200 }, { allocPerRun: 200 }]) {
    const fault = deliver(script, 'fault', [], limits);
    while (!fault.done) {
      fault.step();
    }
    expect(fault.ended?.kind).toBe('limit fault');
    expect(script.variables[0]!.toString()).toBe('[1, 2]');
    expect(outcome.result.toString()).toBe(expected);
    const again = deliver(script, 'grow', []);
    const repeated = again.finish();
    expect(repeated.kind).toBe('completed');
    if (repeated.kind === 'completed') {
      expect(repeated.result.toString()).toBe(expected);
    }
    expect(again.fuel).toBe(first.fuel);
    expect(again.alloc).toBe(first.alloc);
  }
});

test('Save/Restore keeps List windows and a preempted rollback checkpoint', () => {
  const original: string[] = [];
  const group = newGroup({
    name: 'original',
    trace: line => original.push(line),
  });
  const script = group.load({
    name: 's',
    source,
    limits: { fuelPerRun: 2500 },
  });
  script.deliver({ name: 'grow' });
  group.pump(0n);
  script.deliver({ name: 'fault' });
  group.pump(1n, { fuelSlice: 100 });
  expect(group.inspect().scripts[0]!.vars[0]![1].length).toBeGreaterThan(2);
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
  expect(copy.inspect().scripts[0]!.vars[0]![1].toString()).toBe('[1, 2]');
  copy.script('s')!.deliver({ name: 'grow' });
  copy.pump(3n);
  expect(copy.inspect().scripts[0]!.vars[0]![1].toString()).toBe('[1, 2]');
});

test('List growth accounts for nested contents without changing retained values', () => {
  const nested = list(text('é'), list(num(7)));
  let current = list(nested);
  const retained = current;
  for (let i = 0; i < 2000; i++) {
    current = appendTo(current, nested, i % 2 ? 'prepend' : 'append');
  }
  expect(current.length).toBe(2001);
  expect(sizeOf(current)).toBe(
    sizeOf(list(nested)) + 2000 * (8 + sizeOf(nested)),
  );
  expect(sizeOf(retained)).toBe(sizeOf(list(nested)));
  expect(retained.toString()).toBe('[["é", [7]]]');
  const sibling = appendTo(retained, num(9), 'append');
  expect(sibling.toString()).toBe('[["é", [7]], 9]');
  expect(current.index(1).equals(nested)).toBe(true);
  expect(current.index(2001).equals(nested)).toBe(true);
  expect(current.index(2002)).toBe(nothing);
  expect(charge(rateOf('list'), { result: current }).alloc).toBe(
    sizeOf(current),
  );
});
