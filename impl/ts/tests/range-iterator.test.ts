import { expect, test } from 'bun:test';
import { dec, encodeValue, newGroup, restore, type Report } from '../src';
import { integerValue } from '../src/operations';
import { operationalResult } from './operational-reports';

const options = {
  name: 'ranges',
  libraries: [],
  grants: () => undefined,
  resolve: () => undefined,
  onMismatch: 'reject' as const,
};

const cases = [
  ['signed quantum', '-2.00..2.0', '[-2, -1, 0, 1, 2]', 121, 480],
  ['zero quantum', '-0.00..0.000', '[0]', 37, 80],
  ['reversed', '2..-2', '[]', 16, 40],
  [
    'large positive',
    '9999999999999999999999999999999997..9999999999999999999999999999999999',
    '[9999999999999999999999999999999997, 9999999999999999999999999999999998, 9999999999999999999999999999999999]',
    79,
    232,
  ],
  [
    'large negative',
    '-9999999999999999999999999999999999..-9999999999999999999999999999999997',
    '[-9999999999999999999999999999999999, -9999999999999999999999999999999998, -9999999999999999999999999999999997]',
    79,
    232,
  ],
  ['list fallback', '[2.00, -1.0]', '[2.00, -1.0]', 58, 144],
] as const;

// Accounting pinned against the pre-optimization f51ad856 baseline.
const restoredRun = (
  source: string,
  expected: string,
  fuel: number,
  alloc: number,
) => {
  const group = newGroup(options);
  group.load({ name: 's', source });
  // Reuse the same immutable Constant across Runs, including a zero start.
  for (let run = 0; run < 2; run++) {
    group.script('s')!.deliver({ name: 'go' });
    let copy = restore(group.save(), options).group;
    let ended: Extract<Report, { kind: 'run end' }> | undefined;
    for (let step = 0; step < 1000; step++) {
      const a = group.pump(BigInt(run * 1000 + step), { fuelSlice: 1 });
      const b = copy.pump(BigInt(run * 1000 + step), { fuelSlice: 1 });
      expect(operationalResult(b)).toEqual(operationalResult(a));
      expect(copy.inspect()).toEqual(group.inspect());
      const saved = group.save();
      // Includes source, position, frames, counters and pending cleanup;
      // derived numeric state must not enter the canonical save format.
      expect(copy.save()).toEqual(saved);
      copy = restore(saved, options).group;
      ended ??= a.reports.find(r => r.kind === 'run end');
      if (ended && a.state === 'idle') {
        break;
      }
    }
    expect(ended).toMatchObject({ outcome: 'completed', fuel, alloc });
    expect(ended?.result?.toString()).toBe(expected);
  }
};

for (const [name, input, expected, fuel, alloc] of cases) {
  test(`range iteration preserves ${name} across every preemption and restore`, () => {
    restoredRun(
      `constant input = ${input}
on go
 repeat for each x in input collecting x into xs
  wait 0 ms
 end repeat
 return xs
end go`,
      expected,
      fuel,
      alloc,
    );
  });
}

test('range iterator survives retained frames and preempted pending cleanup', () => {
  restoredRun(
    `on go
 repeat for each x in -2.00..2.0
  try
   return x
  finally
   put x + 1 into cleaned
  end try
 end repeat
end go`,
    '-2',
    27,
    104,
  );
});

test('noninteger range bounds still raise wrong kind before iteration', () => {
  for (const input of ['1.25..2', '1..2.25']) {
    const group = newGroup(options);
    const script = group.load({
      name: 's',
      source: `on go
 repeat for each x in ${input}
 end repeat
end go`,
    });
    script.deliver({ name: 'go' });
    const ended = group.pump(0n).reports.find(r => r.kind === 'run end');
    expect(ended?.outcome).toBe('errored');
    expect(ended?.error?.code).toBe('wrong kind');
  }
});

test('internal integer results retain exact encoding and immutable wrappers', () => {
  for (const n of [
    0n,
    -1n,
    1n,
    9_007_199_254_740_993n,
    -(10n ** 34n - 1n),
    10n ** 34n - 1n,
  ]) {
    const value = integerValue(n);
    expect(encodeValue(value)).toBe(encodeValue(dec(String(n))));
    expect(value.toString()).toBe(String(n));
    expect(Reflect.set(value, 'kind', 'text')).toBe(false);
    expect(Reflect.set(value.asDecimal()!, 'toString', () => '0')).toBe(false);
    expect(value.toString()).toBe(String(n));
  }
  // The checked internal constructor keeps its general validation fallback.
  expect(() => integerValue(10n ** 34n)).toThrow();
  expect(() => dec('not a number')).toThrow();
});
