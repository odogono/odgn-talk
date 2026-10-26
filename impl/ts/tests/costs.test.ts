import { expect, test } from 'bun:test';
import { charge, partSize, rateOf, sizeOf, type Measured } from '../src/costs';
import { leafSize, makeCostRates } from '../src/generated/costs';
import {
  costModel,
  costMeasure as codes,
  costSubject,
} from '../src/generated/machine';
import { digitsOf, integerOf, isInteger } from '../src/decimal';
import { scalarCount } from '../src/unicode';
import { characters } from '../src/text';
import {
  bool,
  bytes,
  civilDate,
  dec,
  decimalParts,
  functionValue,
  instant,
  list,
  map,
  nothing,
  num,
  objectValue,
  patternValue,
  quantity,
  range,
  text,
  type Value,
} from '../src/values';

type Formula = readonly (readonly number[])[];
const encoder = new TextEncoder();
// The pre-specialization evaluator, independent of the generated expressions.
const evaluate = (formula: Formula, m: Measured, v?: Value): number => {
  let total = 0;
  for (const [code, subject, factor, divisor] of formula) {
    const name = Object.keys(codes)[code!]!;
    let n = 1;
    if (code !== codes.constant) {
      if (subject === costSubject.none) {
        n =
          name === 'scanned' ||
          name === 'steps' ||
          name === 'frames' ||
          name === 'count' ||
          name === 'declared'
            ? (m[name] ?? 0)
            : 0;
      } else if (
        code === codes.size &&
        subject === costSubject.result &&
        m.resultSize !== undefined
      ) {
        n = m.resultSize;
      } else if (
        code === codes.size &&
        subject === costSubject.input &&
        m.inputSize !== undefined
      ) {
        n = m.inputSize;
      } else {
        n = measure(
          code!,
          subject === costSubject.input
            ? m.input
            : subject === costSubject.result
              ? m.result
              : subject === costSubject.v
                ? v
                : m.x?.[subject! - costSubject.x1],
        );
      }
    }
    total += Math.ceil((factor! * n) / divisor!);
  }
  return total;
};
const logicalSize = (v: Value): number =>
  evaluate(costModel.sizes[v.kind], {}, v);
const measure = (code: number, v: Value | undefined): number => {
  if (!v) {
    return 0;
  }
  switch (code) {
    case codes.size:
      return logicalSize(v);
    case codes.contents: {
      switch (v.kind) {
        case 'list':
          return Array.from({ length: v.length }, (_, i) =>
            v.index(i + 1),
          ).reduce((sum, value) => sum + logicalSize(value), 0);
        case 'map':
          return v
            .entries()
            .reduce(
              (sum, [key, value]) =>
                sum + 16 + encoder.encode(key).length + logicalSize(value),
              0,
            );
        case 'range': {
          const r = v.asRange()!;
          return logicalSize(r.from) + logicalSize(r.to);
        }
        case 'function':
          return v
            .asFunction()!
            .captures.reduce((sum, [, value]) => sum + logicalSize(value), 0);
      }
      return 0;
    }
    case codes.characters:
      return v.kind === 'text' ? characters(v.asText()!).length : 0;
    case codes.scalars:
      return v.kind === 'text' ? scalarCount(v.asText()!) : 0;
    case codes.utf8:
      return v.kind === 'text' ? encoder.encode(v.asText()!).length : 0;
    case codes.bytes:
      return v.bytesView()?.length ?? 0;
    case codes.items: {
      if (v.kind === 'list') {
        return v.length;
      }
      if (v.kind !== 'range' || v.asRange()!.from.kind !== 'number') {
        return 0;
      }
      const { from, to } = v.asRange()!;
      const a = decimalParts(from.asDecimal()!);
      const b = decimalParts(to.asDecimal()!);
      if (!isInteger(a) || !isInteger(b)) {
        return 0;
      }
      return Math.max(0, Number(integerOf(b) - integerOf(a) + 1n));
    }
    case codes.entries:
      return v.kind === 'map' ? v.mapSize : 0;
    case codes.digits: {
      const n = v.asDecimal() ?? v.asQuantityRef()?.number;
      return n ? digitsOf(decimalParts(n)) : 0;
    }
    case codes.program:
      return v.kind === 'pattern' ? v.asPattern()!.program : 0;
  }
  throw new Error(`Unknown measure ${code}`);
};

const values = [
  nothing,
  bool(true),
  num(0),
  dec('1234567890123456.7'),
  quantity(num(12), 'm'),
  text('aé👩‍👩‍👧‍👦'),
  text(''),
  bytes(new Uint8Array(17)),
  list(num(1), text('abc')),
  map([['é', list(num(2))]]),
  range(num(1), num(17)),
  range(num(2), num(1)),
  range(dec('0.1'), num(3)),
  range(num(0), num(10n ** 30n)),
  instant(0n),
  civilDate('2026-10-15'),
  patternValue({ data: undefined, program: 17, source: '' }),
  objectValue({ handle: {}, id: 'o', kind: 'test' }),
  functionValue({
    captures: [['x', list(num(1), num(2))]],
    code: undefined,
    home: 'test',
    identity: 'f',
    maySuspend: false,
    place: 'test',
  }),
];

for (const [i, rate] of costModel.rates.entries()) {
  test(`compiled charge matches the term evaluator: ${rate.key}`, () => {
    const cases: Measured[] = [
      {},
      { inputSize: 0, resultSize: 0 },
      {
        inputSize: 123,
        resultSize: 456,
        scanned: 17,
        steps: 9,
        frames: 3,
        count: 5,
        declared: 7,
      },
    ];
    for (const v of values) {
      for (const n of [0, 1, 7, 8, 9, 15, 16, 17, 31, 32, 33]) {
        cases.push({
          input: v,
          result: v,
          x: [v, v],
          scanned: n,
          steps: n,
          frames: n,
          count: n,
          declared: n,
        });
      }
      cases.push({ input: v, result: v, x: [v], inputSize: 0, resultSize: 0 });
    }
    const into = { alloc: -1, fuel: -1 };
    for (const m of cases) {
      const expected = {
        fuel: evaluate(rate.fuel, m),
        alloc: evaluate(rate.alloc, m),
      };
      expect(charge(i, m)).toEqual(expected);
      expect(charge(i, m, into)).toBe(into);
      expect(into).toEqual(expected);
    }
    expect(rateOf(rate.key)).toBe(i);
  });
}

test('leaf and composite logical sizes match the term evaluator, cold and cached', () => {
  for (const v of values) {
    expect(sizeOf(v)).toBe(logicalSize(v));
    expect(sizeOf(v)).toBe(logicalSize(v));
    const leaf = leafSize(v, measure);
    if (leaf !== undefined) {
      expect(leaf).toBe(logicalSize(v));
    }
  }
  expect(leafSize(list(num(1)), measure)).toBeUndefined();
});

test('shared cross-linked DAGs count each occurrence, including map keys and captures', () => {
  const leaf = list(text('é'), num(2));
  const middle = map([
    ['x', leaf],
    ['y', leaf],
  ]);
  const root = list(leaf, middle, list(middle, leaf));
  expect(sizeOf(root)).toBe(logicalSize(root));
  // Also visit in a different order with a previously uncached root.
  expect(sizeOf(list(middle, leaf))).toBe(logicalSize(list(middle, leaf)));
});

test('all generated terms preserve per-term ceilings and subject selection', () => {
  // Distinguish subjects and measures even where real workloads use the same Values.
  const subjects = [num(1), num(2), num(3), num(4)];
  for (const n of [0, 1, 7, 8, 9, 15, 16, 17, 31, 32, 33]) {
    const synthetic = (code: number, v: Value | undefined) =>
      n + code * (v ? subjects.indexOf(v) + 1 : 0);
    const compiled = makeCostRates(synthetic);
    const m = {
      input: subjects[0],
      result: subjects[1],
      x: subjects.slice(2),
      scanned: n,
      steps: n,
      frames: n,
      count: n,
      declared: n,
    };
    const reference = (formula: Formula) =>
      formula.reduce((sum, [code, subject, factor, divisor]) => {
        const target =
          subject === 1
            ? m.input
            : subject === 2
              ? m.result
              : subject === 3
                ? undefined
                : m.x[subject! - 4];
        const value =
          code === 0 ? 1 : subject === 0 ? n : synthetic(code!, target);
        return sum + Math.ceil((factor! * value) / divisor!);
      }, 0);
    for (const [i, rate] of costModel.rates.entries()) {
      expect(compiled[i]!(m)).toEqual({
        fuel: reference(rate.fuel),
        alloc: reference(rate.alloc),
      });
    }
  }
});

test('state part sizes and invalid rates retain their contract', () => {
  for (const [of, formula] of Object.entries(costModel.sizes)) {
    const expected = formula.reduce(
      (sum, [code, , factor, divisor]) =>
        sum +
        Math.ceil(
          (factor! *
            (code === 0
              ? 1
              : code === codes.items || code === codes.entries
                ? 17
                : 33)) /
            divisor!,
        ),
      0,
    );
    expect(partSize(of, 17, 33)).toBe(expected);
  }
  expect(rateOf('absent')).toBe(-1);
  expect(() => charge(-1)).toThrow('No Cost Model rate');
  expect(() => partSize('absent', 0, 0)).toThrow('No logical size');
});
