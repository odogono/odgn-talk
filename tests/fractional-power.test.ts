import { describe, expect, test } from 'bun:test';
import { compileSource } from '../src/lowering';
import { deliver, loadScript, type Limits, type Outcome } from '../src/machine';

const run = (source: string, limits: Partial<Limits> = {}) => {
  const compiled = compileSource(source, { name: 'powers' });
  if (!compiled.unit) {
    throw new Error(compiled.error?.code ?? 'source did not compile');
  }
  const script = loadScript(compiled.unit, {});
  const execution = deliver(script, 'go', [], limits);
  return { execution, outcome: execution.finish(), script };
};
const expression = (expr: string, limits: Partial<Limits> = {}) =>
  run(`on go\n  return ${expr}\nend go`, limits);
const value = (outcome: Outcome) => {
  if (outcome.kind === 'completed') {
    return outcome.result.toString();
  }
  if (outcome.kind === 'errored') {
    return Object.fromEntries(
      outcome.error
        .entries()
        .filter(([key]) => key !== 'message' && key !== 'at'),
    );
  }
  return outcome.kind;
};

describe('fractional-exponent ^', () => {
  test.each([
    ['2 ^ 0.5', '1.414213562373095048801688724209698'],
    ['10 ^ 33.99', '9772372209558106826970760069615612'],
    ['1.0000000000000002 ^ 0.5', '1.000000000000000099999999999999995'],
    [
      '1.00000000000000020000000000000001 ^ 50000000000000000.5',
      '22026.46579480670770637158272260002',
    ],
    ['8 ^ 0.3333333333', '1.999999999861370563892815468255625'],
    ['4.00 ^ 0.5', '2'],
    ['0.25 ^ 1.5', '0.125'],
    ['0.25 ^ -1.5', '8'],
    ['1.44 ^ 1.5', '1.728'],
    ['16 ^ 0.75', '8'],
    ['0 ^ 0.5', '0'],
    ['1.00 ^ -0.5', '1'],
    ['10 ^ -6176.5', '0'],
    ['10 ^ -6175.5', `0.${'0'.repeat(6175)}3`],
  ])('%s is correctly rounded', (expr, expected) => {
    expect(value(expression(expr).outcome)).toBe(expected);
  });

  test('shadowing power does not change the operator', () => {
    const result = run(
      'on go\n  return 4 ^ 0.5\nend go\nfunction power x, y\n  return 99\nend power',
    );
    expect(value(result.outcome)).toBe('2');
  });

  test('integer exponents still preserve ideal exponents and negative bases', () => {
    expect(
      value(expression('[2.50 ^ 2.0, 0.30 ^ 6, (-2) ^ 3, 0 ^ 0]').outcome),
    ).toBe('[6.2500, 0.000729000000, -8, 1]');
  });

  test.each([
    ['(-8) ^ 0.5', 'out of domain', 'function', '"power"'],
    ['0 ^ -0.5', 'division by zero', undefined, undefined],
    ['10 ^ 34.001', 'overflow', 'operator', '"^"'],
    ['"4" ^ 0.5', 'wrong kind', 'expected', '"number"'],
    ['4 ^ "0.5"', 'wrong kind', 'expected', '"number"'],
    ['(4 m) ^ 0.5', 'wrong kind', 'expected', '"integer"'],
    ['4 ^ (0.5 m)', 'wrong kind', 'expected', '"number"'],
  ])('%s raises %s', (expr, code, field, expected) => {
    const outcome = expression(expr).outcome;
    expect(outcome.kind).toBe('errored');
    if (outcome.kind !== 'errored') {
      throw new Error('expected a Script error');
    }
    expect(outcome.error.get('code').toString()).toBe(`"${code}"`);
    if (field) {
      expect(outcome.error.get(field).toString()).toBe(expected!);
    }
    if (code === 'out of domain') {
      expect(outcome.error.get('value').toString()).toBe('-8');
    }
    expect(outcome.error.get('at').get('line').toString()).toBe('2');
  });

  test('the operator pays its power rate using result digits, not builtin.power', () => {
    const root = expression('2 ^ 0.5');
    expect(value(root.outcome)).toBe('1.414213562373095048801688724209698');
    // clause 4 + two constants 2 + power (8 + 2 * 34) + return 2.
    expect(root.execution.fuel).toBe(84);
    expect(root.execution.alloc).toBe(16);
    const exact = expression('4 ^ 0.5');
    expect(exact.execution.fuel).toBe(18);
    expect(exact.execution.alloc).toBe(16);
  });

  test('a raising power pays its base rate and no result allocation', () => {
    const raised = expression('10 ^ 34.001');
    expect(raised.outcome.kind).toBe('errored');
    // clause 4 + constants 2 + power base 8 + one popped frame 4.
    expect(raised.execution.fuel).toBe(18);
    expect(raised.execution.alloc).toBe(0);
  });

  test.each([
    ['fuelPerRun', { fuelPerRun: 84 }, 9, 0],
    ['allocPerRun', { allocPerRun: 15 }, 9, 0],
  ])(
    'a %s breach at power rolls back earlier writes',
    (limit, limits, fuel, alloc) => {
      const result = run(
        'script variable mark = 0\non go\n  put 1 into mark\n  put 2 ^ 0.5 into mark\nend go',
        limits,
      );
      expect(result.outcome).toMatchObject({
        kind: 'limit fault',
        limit,
        line: 4,
        col: 9,
        rollback: ['mark'],
      });
      expect(result.execution.fuel).toBe(fuel);
      expect(result.execution.alloc).toBe(alloc);
      expect(result.script.variables[0]!.toString()).toBe('0');
    },
  );
});
