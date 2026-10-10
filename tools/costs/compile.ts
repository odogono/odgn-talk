// Compiles the Cost Model's formula text into the terms both Cores evaluate,
// so neither Core parses a formula or looks a measure up by name.

/**
 * One term, `factor * measure(subject) / divisor`, rounded up on its own. A
 * whole number is the constant measure, worth 1, times that number.
 */
export type CostTerm = readonly [
  measure: number,
  subject: number,
  factor: number,
  divisor: number,
];

export type CompiledCostModel = {
  /** Measure codes: `constant` is 0, then the `[measure]` table in order. */
  measures: readonly string[];
  rates: readonly {
    alloc: readonly CostTerm[];
    fuel: readonly CostTerm[];
    key: string;
  }[];
  sizes: readonly { of: string; terms: readonly CostTerm[] }[];
  /** Subject codes: `none` is 0, then `input`, `result`, `v`, `x1`, `x2`, … */
  subjects: readonly string[];
};

/** Subject codes beyond `x1` continue it: `x2` is `x1`'s code plus 1. */
export const subjectNames = ['none', 'input', 'result', 'v', 'x1'] as const;

type Costs = {
  measure: Record<string, string>;
  rate: { alloc?: string; fuel: string; key: string }[];
  size: { of: string; size: string }[];
  subject: Record<string, string>;
};

const termPattern =
  /^(?:(\d+) \* )?(?:(\d+)|([a-z][\da-z]*)(?:\(([\da-z]+)\))?)(?: \/ (\d+))?$/;

export const compileFormula = (
  formula: string,
  measures: readonly string[],
): CostTerm[] =>
  formula
    .split(' + ')
    .map((text): CostTerm => {
      const m = termPattern.exec(text.trim());
      if (!m) {
        throw new Error(`Unreadable Cost Model term: ${text}`);
      }
      const [, times, constant, name, subject, divide] = m;
      const factor = Number(times ?? 1) * Number(constant ?? 1);
      const divisor = Number(divide ?? 1);
      if (constant !== undefined) {
        return [0, 0, factor, divisor];
      }
      const measure = measures.indexOf(name!);
      if (measure < 1) {
        throw new Error(`Unknown Cost Model measure: ${name}`);
      }
      return [measure, subject ? subjectCode(subject) : 0, factor, divisor];
    })
    // A zero term adds nothing, so `alloc = "0"` evaluates no terms at all.
    .filter(([, , factor]) => factor !== 0);

const subjectCode = (subject: string): number => {
  const x = /^x([1-9]\d*)$/.exec(subject);
  const code = x
    ? subjectNames.indexOf('x1') + Number(x[1]) - 1
    : subjectNames.indexOf(subject as (typeof subjectNames)[number]);
  if (code < 1) {
    throw new Error(`Unknown Cost Model subject: ${subject}`);
  }
  return code;
};

export const compileCostModel = (costs: Costs): CompiledCostModel => {
  const subjects = Object.keys(costs.subject);
  if (subjects.join() !== subjectNames.slice(1).join()) {
    throw new Error(`Cost Model subjects changed: ${subjects.join(', ')}`);
  }
  const measures = ['constant', ...Object.keys(costs.measure)];
  return {
    measures,
    subjects: subjectNames,
    sizes: costs.size.map(({ of, size }) => ({
      of,
      terms: compileFormula(size, measures),
    })),
    rates: costs.rate.map(({ key, fuel, alloc }) => ({
      key,
      fuel: compileFormula(fuel, measures),
      alloc: compileFormula(alloc ?? '0', measures),
    })),
  };
};
