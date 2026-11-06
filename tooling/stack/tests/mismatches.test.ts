import { expect, test } from 'bun:test';
import { describeMismatches, mismatchesOf } from '../src/mismatches';

test('reads a run record’s mismatches and says why each clause passed', () => {
  const line =
    'run s/r1 outcome=unhandled handler=put mismatches=[{clause: 1, reason: "shape", argument: 2, mismatches: [{code: "wrong kind", expected: "text", got: "number", value: 1, path: ["lines", 3, "sku"]}]}, {clause: 2, reason: "pattern"}, {clause: 3, reason: "guard"}, {clause: 4, reason: "arity"}] fuel=9 alloc=0';
  expect(describeMismatches(mismatchesOf(line)!)).toEqual([
    'clause 1: argument 2 at lines → item 3 → sku is number, not text',
    "clause 2: a parameter pattern didn't match",
    "clause 3: its Guard wasn't true",
    'clause 4: takes a different number of arguments',
  ]);
});

test('brackets inside quoted values do not end the field', () => {
  const line =
    'run s/r1 outcome=unhandled mismatches=[{clause: 1, reason: "shape", argument: 1, mismatches: [{code: "wrong kind", expected: "number", got: "text", value: "a]}"}]}] fuel=1 alloc=0';
  expect(describeMismatches(mismatchesOf(line)!)).toEqual([
    'clause 1: argument 1 is text, not number',
  ]);
});

test('a line without mismatches has none', () => {
  expect(mismatchesOf('run s/r1 outcome=unhandled fuel=1 alloc=0')).toBeNull();
  expect(mismatchesOf('seg s/r1 start mismatches=[]')).toBeNull();
});
