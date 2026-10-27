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
import { estimateFuel, fuelText } from '../src/fuel';

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
