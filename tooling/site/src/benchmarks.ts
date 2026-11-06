// Picks the benchmark run northtalk.org/benchmarks/ shows (ADR 0173): the
// latest complete run from CI. Local runs come from machines that can't be
// compared, and a filtered run would look like the whole suite.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Results } from '../../../bench/ts/src/report.ts';
import { repoRoot } from './sources.ts';

/**
 * A run from CI, of every Benchmark on every runner. bench/results/ also holds
 * other reports, such as Load timings, which have no machine or settings.
 */
export const isPublishable = (r: Partial<Results>): r is Results =>
  Boolean(r.machine?.ci) &&
  Array.isArray(r.measurements) &&
  r.settings !== undefined &&
  !r.settings.smoke &&
  (r.settings.filter ?? '') === '' &&
  (r.settings.only ?? '') === '';

/** The publishable run with the latest date, or undefined if there is none. */
export const latestRun = (
  runs: readonly Partial<Results>[],
): Results | undefined =>
  runs
    .filter(isPublishable)
    .reduce<Results | undefined>(
      (latest, r) => (latest && latest.date >= r.date ? latest : r),
      undefined,
    );

/** Every run saved in bench/results/. */
export const savedRuns = (): Partial<Results>[] => {
  const dir = join(repoRoot, 'bench/results');
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(
      name =>
        JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<Results>,
    );
};
