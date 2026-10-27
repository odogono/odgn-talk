import { expect, test } from 'bun:test';
import {
  compileSource,
  list,
  loadScript,
  newGroup,
  num,
  parseInstant,
  type Value,
} from '@northtalk/ts';
import {
  boundFuel,
  defaultFuelCaps,
  estimateFuel,
  fuelBoundText,
  fuelText,
} from '../src/fuel';

const total = `on total xs
  put 0 into sum
  repeat for each x in xs
    if x > 10 then
      add x to sum
    end if
  end repeat
  return sum & "!"
end total`;

const estimates = (source: string) =>
  estimateFuel(
    loadScript(compileSource(source, { name: 's' }).unit!, {}, new Map()),
  );
const fuelOf = (source: string, name: string, args: Value[] = []) => {
  const g = newGroup({ name: 't' });
  g.load({ name: 's', source }).request({ name, args });
  return g.pump(parseInstant('2026-09-30T09:00:00Z')).fuelUsed;
};

test('fixed Fuel and loop passes bound what a Run is charged', () => {
  const [estimate] = estimates(total);
  expect(estimate).toMatchObject({ clause: 4, max: 15, min: 15 });
  expect(estimate!.loops).toMatchObject([{ at: { line: 3 }, max: 17, min: 9 }]);
  expect(estimate!.terms.map(t => [t.key, t.at.line])).toEqual([
    ['compare', 4],
    ['arithmetic', 5],
    ['concat', 8],
  ]);
  // Here each open term rounds up to 1, except a Number comparison's, which
  // scans nothing: a pass costs 9 untaken, or 17 + 1 taken.
  const once = 15 + 4 + 1;
  const run = (...xs: number[]) =>
    fuelOf(total, 'total', [list(...xs.map(num))]);
  expect(run()).toBe(once);
  expect(run(5)).toBe(once + 9);
  expect(run(20)).toBe(once + 18);
  expect(run(20, 30, 5)).toBe(once + 2 * 18 + 9);
});

test("a call adds its callee's bounds, its dispatch and its count", () => {
  const source = `${total}\non go\n  return total([1, 2])\nend go`;
  const go = estimates(source).find(e => e.name === 'go')!;
  expect(go).toMatchObject({ max: 35, min: 35 });
  expect(go.loops).toMatchObject([{ min: 9 }]);
  // Two untaken passes; the list's items, and the concat, round up to 1.
  expect(fuelOf(source, 'go')).toBe(35 + 4 + 2 * 9 + 1 + 1);
});

test('a recursive call stays open and the hover text says so', () => {
  const [f] = estimates(
    'function f n\n  if n < 1 then return 0\n  return f(n - 1)\nend f',
  );
  expect(fuelText(f!)).toBe(
    'Fuel estimate: 8..20\n' +
      '+ more with larger values: compare (line 2), arithmetic (line 3)\n' +
      '+ calls not counted: f (line 3)',
  );
});

const code = (source: string) =>
  loadScript(compileSource(source, { name: 's' }).unit!, {}, new Map());

test('a Fuel Bound multiplies nested loops and covers Runs within the caps', () => {
  const spin =
    'on spin n\n  repeat 3 times\n    repeat 4 times\n      add 1 to n\n    end repeat\n  end repeat\n  return n\nend spin';
  const [bound] = boundFuel(code(spin));
  expect(bound).toEqual({ fuel: 223, kind: 'bounded' });
  expect(fuelOf(spin, 'spin', [num(0)])).toBe(199);
  // 100 items of two digits, inside every default cap.
  const [all] = boundFuel(code(total));
  const items = list(...Array.from({ length: 100 }, () => num(11)));
  expect(all!.kind).toBe('bounded');
  expect(fuelOf(total, 'total', [items])).toBeLessThanOrEqual(
    (all as { fuel: number }).fuel,
  );
  // Smaller caps give a smaller bound.
  const [small] = boundFuel(code(total), {
    ...defaultFuelCaps,
    collection: 10,
  });
  expect((small as { fuel: number }).fuel).toBeLessThan(
    (all as { fuel: number }).fuel,
  );
});

test('a Fuel Bound is unbounded, with every reason, when anything is', () => {
  const [w, f] = boundFuel(
    code(
      'on w n\n  repeat while n > 0\n    subtract 1 from n\n  end repeat\n  return n matches <digit>\nend w\nfunction f n\n  return f(n)\nend f',
    ),
  );
  expect(fuelBoundText(w!, 's')).toBe(
    'Fuel Bound: unbounded (Text Pattern matching at line 5; a loop with no bound at line 2)',
  );
  expect(fuelBoundText(f!, 's')).toBe(
    'Fuel Bound: unbounded (the call to f at line 8)',
  );
});

test("a bound over a frame's Fuel says how many frames it may take", () => {
  expect(
    fuelBoundText({ fuel: 12_000, kind: 'bounded' }, 's', undefined, 5000),
  ).toBe(
    "Fuel Bound: 12,000, more than one frame's 5,000 (it may spread over 3 frames)\n" +
      'with text ≤ 256 Characters, numbers ≤ 20 digits, collections ≤ 100 items, Bytes ≤ 1,024, repeat n times ≤ 100',
  );
});

test('the hover counts a recurring term; full lists each one', () => {
  const [sum] = estimateFuel(
    code(
      'function sum a, b\n  put a + b into a\n  put a + b into a\n  put a + b into a\n  return a + b\nend sum',
    ),
  );
  expect(fuelText(sum!)).toContain('more with larger values: arithmetic ×4');
  expect(fuelText(sum!, { full: true })).toContain(
    'arithmetic (line 2), arithmetic (line 3), arithmetic (line 4), arithmetic (line 5)',
  );
});
