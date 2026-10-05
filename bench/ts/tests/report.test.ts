import { expect, test } from 'bun:test';
import {
  fuelParity,
  type Measurement,
  median,
  outliers,
  parseGoBench,
} from '../src/report';

const stats = { medianNs: 1, minNs: 1, samples: 1 };
const measured = (
  benchmark: string,
  runner: string,
  fuel: number,
  runNs = 1000,
): Measurement => ({
  benchmark,
  fuel,
  load: stats,
  logicalAlloc: 0,
  run: { medianNs: runNs, minNs: runNs, samples: 1 },
  runner,
});

test('the median of an even count is the mean of the middle two', () => {
  expect(median([4, 1, 3])).toBe(3);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

test('Go benchmark output becomes one measurement per Benchmark', () => {
  const output = `goos: darwin
BenchmarkLoad/core/fib-10   14487   82835 ns/op   133146 B/op   803 allocs/op
BenchmarkLoad/core/fib-10   14000   80000 ns/op   133146 B/op   803 allocs/op
BenchmarkRun/core/fib-10   43   25000000 ns/op   46365 fuel/op   47328 logical-B/op   539.2 ns/fuel   40660441 B/op   516339 allocs/op
BenchmarkRun/core/fib-10   43   27000000 ns/op   46365 fuel/op   47328 logical-B/op   582.3 ns/fuel   40660441 B/op   516339 allocs/op
PASS`;
  expect(parseGoBench(output)).toEqual([
    {
      benchmark: 'core/fib',
      fuel: 46_365,
      hostAllocs: 516_339,
      hostBytes: 40_660_441,
      load: { medianNs: 81_417.5, minNs: 80_000, samples: 2 },
      logicalAlloc: 47_328,
      run: { medianNs: 26_000_000, minNs: 25_000_000, samples: 2 },
      runner: 'go',
    },
  ]);
});

test('Fuel that differs between the Cores is a parity failure', () => {
  expect(
    fuelParity([
      measured('core/a', 'go', 10),
      measured('core/a', 'ts', 10),
      measured('core/b', 'go', 10),
      measured('core/b', 'ts', 11),
      measured('core/b', 'lua', 99),
    ]),
  ).toEqual([{ benchmark: 'core/b', fuel: { go: 10, ts: 11 } }]);
});

test("an outlier's ns/Fuel is far above its own runner's median", () => {
  const found = outliers(
    [
      measured('core/a', 'go', 10, 1000),
      measured('core/b', 'go', 10, 1100),
      measured('core/c', 'go', 10, 5000),
      measured('core/a', 'ts', 10, 5000),
      measured('core/b', 'ts', 10, 5000),
    ],
    3,
  );
  expect(found.map(o => [o.benchmark, o.runner])).toEqual([['core/c', 'go']]);
  expect(found[0]?.factor).toBeCloseTo(5000 / 1100);
});
