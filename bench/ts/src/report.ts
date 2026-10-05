// Merging each runner's measurements into one report: Fuel parity between
// the Cores, advisory Cost Model outliers, and the Markdown table.

/** Timings of one phase over its samples, in nanoseconds. */
export type Stats = { medianNs: number; minNs: number; samples: number };

/** One Benchmark measured by one runner. Host figures are per Run. */
export type Measurement = {
  benchmark: string;
  fuel: number;
  hostAllocs?: number;
  hostBytes?: number;
  load: Stats;
  logicalAlloc: number;
  run: Stats;
  runner: string;
};

/** A Benchmark whose Fuel differs between the Cores. */
export type ParityFailure = {
  benchmark: string;
  fuel: Record<string, number>;
};

/** A Benchmark whose ns/Fuel on one runner is far above that runner's median. */
export type Outlier = {
  benchmark: string;
  factor: number;
  nsPerFuel: number;
  runner: string;
};

/** A Benchmark a runner can't run yet. */
export type Skipped = { benchmark: string; reason: string; runner: string };

export type Results = {
  commit: string;
  date: string;
  machine: Record<string, string | number>;
  measurements: Measurement[];
  outlierFactor: number;
  outliers: Outlier[];
  parity: ParityFailure[];
  settings: Record<string, string | number | boolean>;
  skipped: Skipped[];
  versions: Record<string, string>;
};

/** The runners that are Cores, whose Fuel must agree. */
export const cores = ['go', 'ts'];

export const median = (xs: readonly number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (i: number) => sorted[i] ?? Number.NaN;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? at(middle) : (at(middle - 1) + at(middle)) / 2;
};

export const statsOf = (samples: readonly number[]): Stats => ({
  medianNs: median(samples),
  minNs: Math.min(...samples),
  samples: samples.length,
});

export const nsPerFuel = (m: Measurement) => m.run.medianNs / m.fuel;

// One `go test -bench` result line: name, iterations, then value-unit pairs.
const goLine = /^Benchmark(Load|Run)\/(\S+?)(?:-\d+)?\s+\d+\s+(.*)$/;

/** Read `go test -bench -benchmem` output, over any `-count`, into measurements. */
export const parseGoBench = (output: string): Measurement[] => {
  const phases = new Map<string, Record<string, Record<string, number[]>>>();
  for (const line of output.split('\n')) {
    const match = goLine.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, phase = '', benchmark = '', rest = ''] = match;
    const fields = rest.trim().split(/\s+/);
    const byPhase = phases.get(benchmark) ?? {};
    phases.set(benchmark, byPhase);
    const metrics = (byPhase[phase] ??= {});
    for (let i = 0; i + 1 < fields.length; i += 2) {
      (metrics[fields[i + 1] ?? ''] ??= []).push(Number(fields[i]));
    }
  }
  const measurements: Measurement[] = [];
  for (const [benchmark, { Load, Run }] of phases) {
    if (!Load || !Run) {
      continue;
    }
    const run = (unit: string) => Run[unit] ?? [];
    measurements.push({
      benchmark,
      fuel: median(run('fuel/op')),
      hostAllocs: median(run('allocs/op')),
      hostBytes: median(run('B/op')),
      load: statsOf(Load['ns/op'] ?? []),
      logicalAlloc: median(run('logical-B/op')),
      run: statsOf(run('ns/op')),
      runner: 'go',
    });
  }
  return measurements;
};

/** Benchmarks measured on more than one Core whose Fuel differs. */
export const fuelParity = (
  measurements: readonly Measurement[],
): ParityFailure[] => {
  const byBenchmark = new Map<string, Record<string, number>>();
  for (const m of measurements) {
    if (cores.includes(m.runner)) {
      byBenchmark.set(m.benchmark, {
        ...byBenchmark.get(m.benchmark),
        [m.runner]: m.fuel,
      });
    }
  }
  return [...byBenchmark]
    .filter(([, fuel]) => new Set(Object.values(fuel)).size > 1)
    .map(([benchmark, fuel]) => ({ benchmark, fuel }));
};

/**
 * Benchmarks whose ns/Fuel is more than `factor` times the median of their
 * runner's. They are candidates for a Cost Model review, never a change.
 */
export const outliers = (
  measurements: readonly Measurement[],
  factor: number,
): Outlier[] => {
  const result: Outlier[] = [];
  for (const runner of new Set(measurements.map(m => m.runner))) {
    const mine = measurements.filter(m => m.runner === runner && m.fuel > 0);
    const typical = median(mine.map(nsPerFuel));
    for (const m of mine) {
      if (nsPerFuel(m) > factor * typical) {
        result.push({
          benchmark: m.benchmark,
          factor: nsPerFuel(m) / typical,
          nsPerFuel: nsPerFuel(m),
          runner,
        });
      }
    }
  }
  return result;
};

const ms = (ns: number) => (ns / 1e6).toFixed(3);
const us = (ns: number) => (ns / 1e3).toFixed(1);
const bytes = (n: number | undefined) =>
  n === undefined
    ? ''
    : n >= 1 << 20
      ? `${(n / (1 << 20)).toFixed(1)} MiB`
      : n >= 1 << 10
        ? `${(n / (1 << 10)).toFixed(1)} KiB`
        : `${Math.round(n)} B`;
const count = (n: number | undefined) =>
  n === undefined ? '' : String(Math.round(n));

export const markdown = (r: Results): string => {
  const lines = [
    `# Benchmark results, ${r.date}`,
    '',
    `Commit \`${r.commit}\` on ${r.machine.cpu} (${r.machine.cores} cores, ${r.machine.memory}), ${r.machine.os} ${r.machine.arch}.`,
    `Versions: ${Object.entries(r.versions)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}.`,
    `Settings: ${Object.entries(r.settings)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}.`,
    '',
    '| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |',
    '| - | - | -: | -: | -: | -: | -: | -: | -: | -: |',
  ];
  const sorted = [...r.measurements].sort(
    (a, b) =>
      a.benchmark.localeCompare(b.benchmark) ||
      a.runner.localeCompare(b.runner),
  );
  for (const m of sorted) {
    lines.push(
      `| ${m.benchmark} | ${m.runner} | ${us(m.load.medianNs)} | ${ms(m.run.medianNs)} | ${ms(m.run.minNs)} | ${m.fuel} | ${nsPerFuel(m).toFixed(1)} | ${bytes(m.logicalAlloc)} | ${bytes(m.hostBytes)} | ${count(m.hostAllocs)} |`,
    );
  }
  const parity = r.parity.map(
    p =>
      `- ${p.benchmark}: ${Object.entries(p.fuel)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
  );
  const found = r.outliers.map(
    o =>
      `- ${o.benchmark} on ${o.runner}: ${o.nsPerFuel.toFixed(1)} ns/Fuel, ${o.factor.toFixed(1)}× the median`,
  );
  const skipped = r.skipped.map(
    s => `- ${s.benchmark} on ${s.runner}: ${s.reason}`,
  );
  lines.push(
    '',
    '## Fuel parity',
    '',
    ...(parity.length
      ? parity
      : ['Every Benchmark used the same Fuel on each Core.']),
    '',
    '## Cost Model outliers',
    '',
    `Benchmarks whose ns/Fuel is more than ${r.outlierFactor}× their runner's median. These are advisory: any reweighting goes through the Spec.`,
    '',
    ...(found.length ? found : ['None.']),
    ...(skipped.length ? ['', '## Skipped', '', ...skipped] : []),
  );
  return lines.join('\n') + '\n';
};
