import { describe, expect, test } from 'bun:test';
import type { Results } from '../../../bench/ts/src/report.ts';
import { latestRun } from '../src/benchmarks.ts';

const run = (
  date: string,
  machine: Results['machine'],
  settings: Partial<Results['settings']> = {},
): Results => ({
  commit: date,
  date,
  machine,
  measurements: [],
  outlierFactor: 3,
  outliers: [],
  parity: [],
  settings: { count: 10, filter: '', only: '', smoke: false, ...settings },
  skipped: [],
  versions: {},
});

const ci = { ci: 'github-actions', cpu: 'EPYC' };
const local = { cpu: 'Apple M5' };

describe('latestRun', () => {
  test('is the latest CI run', () => {
    const runs = [
      run('2026-11-01', ci),
      run('2026-11-03', ci),
      run('2026-11-02', ci),
    ];
    expect(latestRun(runs)?.date).toBe('2026-11-03');
  });

  test('leaves out local runs, even later ones', () => {
    expect(
      latestRun([run('2026-11-01', ci), run('2026-11-05', local)])?.date,
    ).toBe('2026-11-01');
  });

  test('leaves out filtered, partial and smoke runs', () => {
    const runs = [
      run('2026-11-02', ci, { filter: 'loop' }),
      run('2026-11-03', ci, { only: 'zig' }),
      run('2026-11-04', ci, { smoke: true }),
    ];
    expect(latestRun(runs)).toBeUndefined();
  });

  test('skips reports that are not runs', () => {
    expect(
      latestRun([{ date: '2026-11-09' }, run('2026-11-01', ci)])?.date,
    ).toBe('2026-11-01');
  });

  test('is undefined with no CI run', () => {
    expect(latestRun([run('2026-11-01', local)])).toBeUndefined();
  });
});
