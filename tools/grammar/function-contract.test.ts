import { expect, test } from 'bun:test';
import { functionContract } from './function-contract';

test('catalogue contracts distinguish constants, fixed arity and trailing defaults', () => {
  expect(functionContract('U+0022')).toBeUndefined();
  expect(functionContract('empty()')).toEqual({
    required: 0,
    total: 0,
    variadic: false,
  });
  expect(functionContract('codePoint(c)')).toEqual({
    required: 1,
    total: 1,
    variadic: false,
  });
  expect(functionContract('min(x, …)')).toEqual({
    required: 1,
    total: 1,
    variadic: true,
  });
  expect(functionContract('round(x, places = 0, mode = "half up")')).toEqual({
    required: 1,
    total: 3,
    variadic: false,
  });
});

test('catalogue contracts parse defaults containing text commas and nested expressions', () => {
  expect(
    functionContract('f(x, pair = [1, 2], text = "a,b", last = min([3, 4]))'),
  ).toEqual({ required: 1, total: 4, variadic: false });
  expect(() => functionContract('f(x, y = )')).toThrow(
    'Invalid function catalogue signature',
  );
});
