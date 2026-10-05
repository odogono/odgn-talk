// `bun run bench`: runs the Benchmark Suite on each Core, checks Fuel parity,
// and writes one merged report. See bench/README.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { coreVersions } from '@odgn/northtalk';
import {
  fuelParity,
  markdown,
  type Measurement,
  outliers,
  parseGoBench,
  type Results,
} from './report';
import { manifest, scriptsDir, selected, skipped } from './suite';

const { values: flags } = parseArgs({
  options: {
    count: { default: '10', type: 'string' },
    filter: { type: 'string' },
    'no-save': { default: false, type: 'boolean' },
    only: { type: 'string' },
    'outlier-factor': { default: '3', type: 'string' },
    smoke: { default: false, type: 'boolean' },
  },
});
const runners = flags.only ? [flags.only] : ['go', 'ts'];
for (const runner of runners) {
  if (runner !== 'go' && runner !== 'ts') {
    throw new Error(`--only takes go or ts, not ${runner}`);
  }
}
const benchDir = join(scriptsDir, '..');
const filter = flags.filter ?? '';

const run = (cmd: string[], cwd: string, env: Record<string, string> = {}) => {
  const result = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stdout = result.stdout.toString();
  if (result.exitCode !== 0) {
    console.error(
      `${cmd.join(' ')} failed:\n${stdout}${result.stderr.toString()}`,
    );
    process.exit(1);
  }
  return stdout.trim();
};

const measurements: Measurement[] = [];
if (runners.includes('ts')) {
  console.error('Measuring the TS Core…');
  measurements.push(
    ...(JSON.parse(
      run(
        [
          'bun',
          join(import.meta.dir, 'measure-ts.ts'),
          filter,
          flags.smoke ? 'smoke' : '',
        ],
        benchDir,
      ),
    ) as Measurement[]),
  );
}
if (runners.includes('go')) {
  console.error('Measuring the Go Core…');
  const goArgs = flags.smoke
    ? ['-count', '1', '-benchtime', '1x']
    : ['-count', flags.count];
  measurements.push(
    ...parseGoBench(
      run(
        ['go', 'test', '-run', '^$', '-bench', '.', '-benchmem', ...goArgs],
        join(benchDir, 'go'),
        {
          NORTHTALK_BENCH_FILTER: filter,
          ...(flags.smoke ? { NORTHTALK_BENCH_SMOKE: '1' } : {}),
        },
      ),
    ),
  );
}

const outlierFactor = Number(flags['outlier-factor']);
const versions = coreVersions;
const date = new Date().toISOString().slice(0, 10);
const cpu = cpus()[0]?.model ?? 'unknown CPU';
const results: Results = {
  commit: run(['git', 'describe', '--always', '--dirty'], benchDir),
  date,
  machine: {
    arch: arch(),
    cores: cpus().length,
    cpu,
    memory: `${Math.round(totalmem() / 2 ** 30)} GiB`,
    os: platform(),
  },
  measurements,
  outlierFactor,
  outliers: outliers(measurements, outlierFactor),
  parity: fuelParity(measurements),
  settings: {
    count: flags.smoke ? 1 : Number(flags.count),
    filter,
    runners: runners.join(','),
    smoke: flags.smoke,
  },
  skipped: manifest()
    .filter(b => selected(b, filter || undefined))
    .flatMap(b => skipped(b, runners)),
  versions: {
    bun: Bun.version,
    'cost model': versions.costModel,
    go: runners.includes('go') ? run(['go', 'env', 'GOVERSION'], benchDir) : '',
    language: versions.language,
  },
};

const report = markdown(results);
console.log(report);
if (!flags.smoke && !flags['no-save']) {
  const slug = `${platform()}-${arch()}-${cpu}`
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, '-')
    .replaceAll(/^-|-$/g, '');
  const dir = join(benchDir, 'results');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${date}-${slug}`);
  writeFileSync(`${base}.json`, JSON.stringify(results, null, 2) + '\n');
  writeFileSync(`${base}.md`, report);
  console.error(`Wrote ${base}.json and .md`);
}
if (results.parity.length) {
  console.error('Fuel differs between the Cores.');
  process.exit(1);
}
