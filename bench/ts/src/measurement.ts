import { measure as mitataMeasure } from 'mitata';

// mitata adds defaults and rescales min_cpu_time in place. Sharing that object
// across workloads compounds the heap multiplier on every measurement.
export const measure = (
  fn: () => unknown,
  options: Omit<Parameters<typeof mitataMeasure>[1], 'args'>,
) => mitataMeasure(fn, { ...options });
