// `Run.fastSteps` must leave every Trace as the general step writes it: at
// every Fuel and allocation limit, and at every Fuel Slice (#1297).
import { afterEach, describe, expect, test } from 'bun:test';
import { newGroup, num } from '../src/index';
import { fastPath } from '../src/machine';

afterEach(() => {
  fastPath.enabled = true;
});

const scripts: Record<string, string> = {
  loop: `on run n
  put 0 into total
  put 0 into i
  repeat while i < n
    add 1 to i
    add i to total
  end repeat
  return total
end run`,
  // Comparisons and branches both ways, with subtract and multiply.
  branches: `on run n
  put 1 into product
  put n into i
  repeat until i <= 0
    if i = 3 or i is not 5 then
      put product * -1 into product
    end if
    if i >= 2 and not (i > 4) then
      put product * i into product
    end if
    subtract 1 from i
  end repeat
  return product
end run`,
  // Results past the safe integers, decimals and zero times a negative take
  // the Decimal path.
  numbers: `on run n
  put 9007199254740990 into big
  put 0 into i
  repeat while i < n
    add 1 to big
    add 0.5 to i
  end repeat
  put -3 * 0 into zero
  put big * big into square
  return [big, square, zero, i]
end run`,
  // A Guard and a Queueing Policy select the clause while instructions run;
  // `run` is delivered twice, so the second is dropped.
  policies: `on run n where n > 2, dropping
  put 0 into i
  repeat while i < n
    add 1 to i
  end repeat
  wait 1 s
  return i
end run`,
  // Values the fast path leaves to the general step: text comparison, a
  // non-Boolean branch and a raise inside try/finally.
  fallbacks: `on run n
  put 0 into i
  put "a" into word
  repeat while i < n
    if word < "b" then
      add 1 to i
    end if
  end repeat
  try
    put i into x
    if x < n + 1 then
      put x + "no" into y
    end if
  catch e
    put 0 - i into i
  finally
    add 10 to i
  end try
  return i
end run`,
};

type Limits = { allocPerRun?: number; fuelPerRun?: number };

// Deliver `run n` twice and pump to idle, past each deadline: the Trace and
// Pump results, and the Fuel and allocation every Run spent.
const pumped = (
  source: string,
  n: number,
  { fast = true, fuelSlice = 0, limits = {} as Limits } = {},
) => {
  fastPath.enabled = fast;
  const lines: string[] = [];
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  group.load({ limits, name: 's', source });
  group.script('s')!.deliver({ args: [num(n)], name: 'run' });
  group.script('s')!.deliver({ args: [num(n)], name: 'run' });
  let clock = 0n;
  let fuel = 0;
  let alloc = 0;
  for (let i = 0; i < 10_000; i++) {
    const result = group.pump(clock, fuelSlice ? { fuelSlice } : {});
    fuel += result.fuelUsed;
    for (const report of result.reports) {
      if (report.kind === 'run end') {
        alloc += report.alloc;
      }
    }
    lines.push(
      JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? `${v}n` : v)),
    );
    if (result.state === 'idle') {
      if (result.nextDeadline === undefined) {
        return { alloc, fuel, lines };
      }
      clock = result.nextDeadline;
    }
  }
  throw new Error('the Group did not become idle');
};

describe('fast steps', () => {
  for (const [name, source] of Object.entries(scripts)) {
    const n = 6;
    test(`${name}: identical Traces at every limit and Fuel Slice`, () => {
      const { alloc, fuel, lines } = pumped(source, n, { fast: false });
      expect(lines.join('\n')).toContain('outcome=completed');
      const same = (limits: Limits, fuelSlice?: number) =>
        expect(pumped(source, n, { fuelSlice, limits }).lines).toEqual(
          pumped(source, n, { fast: false, fuelSlice, limits }).lines,
        );
      for (let limit = 0; limit <= fuel; limit++) {
        same({ fuelPerRun: limit });
      }
      for (let limit = 0; limit <= alloc; limit++) {
        same({ allocPerRun: limit });
      }
      for (let slice = 0; slice <= fuel; slice++) {
        same({}, slice);
      }
    });
  }

  test('the loop pays the Fuel and allocation the general step does', () => {
    const loop = scripts.loop!;
    const general = pumped(loop, 2000, { fast: false });
    expect(general).toMatchObject({ alloc: 128_000, fuel: 96_032 });
    expect(pumped(loop, 2000)).toEqual(general);
  });
});
