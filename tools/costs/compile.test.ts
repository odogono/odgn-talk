import { expect, test } from 'bun:test';
import costs from '../../spec/data/costs.toml';
import { compileCostModel, compileFormula } from './compile';

const measures = ['constant', 'size', 'digits', 'count'];

test('formulas compile to measure, subject, factor and divisor codes', () => {
  expect(compileFormula('3 + 2 * digits(x2) / 8 + count', measures)).toEqual([
    [0, 0, 3, 1],
    [2, 5, 2, 8],
    [3, 0, 1, 1],
  ]);
  expect(compileFormula('4 * 6 / 5', measures)).toEqual([[0, 0, 24, 5]]);
  expect(compileFormula('size(result)', measures)).toEqual([[1, 2, 1, 1]]);
});

test('zero terms compile to nothing', () => {
  expect(compileFormula('0', measures)).toEqual([]);
  expect(compileFormula('0 * size(v)', measures)).toEqual([]);
});

test('unknown measures, subjects and terms are refused', () => {
  expect(() => compileFormula('lines(result)', measures)).toThrow('measure');
  expect(() => compileFormula('size(output)', measures)).toThrow('subject');
  expect(() => compileFormula('size(x0)', measures)).toThrow('subject');
  expect(() => compileFormula('3 - count', measures)).toThrow('Unreadable');
});

test('the Cost Model compiles with every rate and size', () => {
  const model = compileCostModel(costs);
  expect(model.measures[0]).toBe('constant');
  expect(model.rates.length).toBe(costs.rate.length);
  expect(model.sizes.length).toBe(costs.size.length);
  expect(model.rates.find(r => r.key === 'arithmetic')).toEqual({
    key: 'arithmetic',
    fuel: [
      [0, 0, 3, 1],
      [model.measures.indexOf('digits'), 2, 1, 8],
    ],
    alloc: [[model.measures.indexOf('size'), 2, 1, 1]],
  });
});
