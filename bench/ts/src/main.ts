// `bun run bench`: runs the Benchmark Suite on each Core and its ports in each
// Peer Language, checks Fuel parity, and writes one merged report. See
// bench/README.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { coreVersions } from '@northtalk/ts';
import {
  fuelParity,
  markdown,
  type Measurement,
  outliers,
  parseGoBench,
  type Results,
} from './report';
import { peersDir } from './peers';
import { bunPeers, goPeers, selectRunners } from './runners';
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
const runners = selectRunners(flags.only);
const selectedBunPeers = bunPeers.filter(peer => runners.includes(peer));
const selectedGoPeers = goPeers.filter(peer => runners.includes(peer));
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
if (runners.includes('zig')) {
  console.error('Measuring the Zig Core…');
  measurements.push(
    ...(JSON.parse(
      run(
        [
          'bun',
          join(import.meta.dir, 'measure-zig.ts'),
          filter,
          flags.smoke ? 'smoke' : '',
          flags.count,
        ],
        benchDir,
      ),
    ) as Measurement[]),
  );
}
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
if (selectedBunPeers.length) {
  console.error('Measuring the Peer Languages on Bun…');
  measurements.push(
    ...(JSON.parse(
      run(
        [
          'bun',
          join(import.meta.dir, 'measure-peers.ts'),
          filter,
          flags.smoke ? 'smoke' : '',
          selectedBunPeers.join(','),
        ],
        benchDir,
      ),
    ) as Measurement[]),
  );
}
if (runners.includes('cpython')) {
  console.error('Measuring CPython…');
  measurements.push(
    ...(JSON.parse(
      run(
        [
          'uv',
          'run',
          '--no-project',
          '--managed-python',
          'python',
          'measure.py',
          '--filter',
          filter,
          '--count',
          flags.count,
          ...(flags.smoke ? ['--smoke'] : []),
        ],
        join(peersDir, 'python'),
      ),
    ) as Measurement[]),
  );
}
if (runners.includes('applescript')) {
  // AppleScript runs only on macOS; elsewhere its runner is left out.
  if (platform() === 'darwin') {
    console.error('Measuring AppleScript…');
    measurements.push(
      ...(JSON.parse(
        run(
          [
            'osascript',
            'measure.applescript',
            filter,
            flags.smoke ? 'smoke' : '',
            flags.count,
          ],
          join(peersDir, 'applescript'),
        ),
      ) as Measurement[]),
    );
  } else {
    console.error('Skipping AppleScript, which runs only on macOS.');
  }
}
const goRuns = [
  ...(runners.includes('go')
    ? [{ label: 'the Go embedding', pattern: '^Benchmark(Load|Run)$' }]
    : []),
  ...(selectedGoPeers.length
    ? [
        {
          label: `the Peer Languages on Go (${selectedGoPeers.join(', ')})`,
          pattern: `^BenchmarkPeer$/^(${selectedGoPeers.join('|')})$`,
        },
      ]
    : []),
];
for (const { label, pattern } of goRuns) {
  console.error(`Measuring ${label}…`);
  const goArgs = flags.smoke
    ? ['-count', '1', '-benchtime', '1x']
    : ['-count', flags.count];
  measurements.push(
    ...parseGoBench(
      run(
        ['go', 'test', '-run', '^$', '-bench', pattern, '-benchmem', ...goArgs],
        join(benchDir, 'go'),
        {
          NORTHTALK_BENCH_FILTER: filter,
          ...(flags.smoke ? { NORTHTALK_BENCH_SMOKE: '1' } : {}),
        },
      ),
    ),
  );
}

// The Peer Language versions: the Go module versions, the exact npm versions
// bench/ts pins, the CPython .python-version pins, and on macOS the system's
// AppleScript.
const peerVersions = (): Record<string, string> => {
  const npm = (
    JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> }
  ).dependencies;
  const modules = [
    ...(runners.includes('gopher-lua') ? ['github.com/yuin/gopher-lua'] : []),
    ...(runners.includes('starlark-go') ? ['go.starlark.net'] : []),
  ];
  const goModules = Object.fromEntries(
    modules.length
      ? run(
          ['go', 'list', '-m', '-f', '{{.Path}} {{.Version}}', ...modules],
          join(benchDir, 'go'),
        )
          .split('\n')
          .map(line => line.split(' '))
      : [],
  ) as Record<string, string>;
  return {
    ...(runners.includes('applescript') && platform() === 'darwin'
      ? {
          applescript: [
            run(['osascript', '-e', "AppleScript's version"], benchDir),
            `(macOS ${run(['sw_vers', '-productVersion'], benchDir)})`,
          ].join(' '),
        }
      : {}),
    ...(runners.includes('cpython')
      ? {
          cpython: readFileSync(
            join(peersDir, 'python', '.python-version'),
            'utf8',
          ).trim(),
        }
      : {}),
    ...(runners.includes('gopher-lua')
      ? { 'gopher-lua': goModules['github.com/yuin/gopher-lua'] ?? '' }
      : {}),
    ...(runners.includes('quickjs')
      ? { 'quickjs-emscripten': npm['quickjs-emscripten'] ?? '' }
      : {}),
    ...(runners.includes('starlark-go')
      ? { 'starlark-go': goModules['go.starlark.net'] ?? '' }
      : {}),
    ...(runners.includes('wasmoon') ? { wasmoon: npm.wasmoon ?? '' } : {}),
  };
};

const outlierFactor = Number(flags['outlier-factor']);
// Benchmarks whose time is mostly outside Fuel-charged work, such as Save.
const excluded = new Set(
  manifest()
    .filter(b => b.outlier === false)
    .map(b => b.name),
);
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
  outliers: outliers(
    measurements.filter(m => !excluded.has(m.benchmark)),
    outlierFactor,
  ),
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
    ...(runners.includes('zig')
      ? {
          zig: run(['zig', 'version'], benchDir),
          'zig build': 'native safe; C Host zig cc -O2',
        }
      : {}),
    'cost model': versions.costModel,
    go: goRuns.length ? run(['go', 'env', 'GOVERSION'], benchDir) : '',
    language: versions.language,
    ...peerVersions(),
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
  // A selected run must not overwrite the full comparison from the same day.
  const selection = flags.only === undefined ? '' : `-${runners.join('-')}`;
  const base = join(dir, `${date}-${slug}${selection}`);
  writeFileSync(`${base}.json`, JSON.stringify(results, null, 2) + '\n');
  writeFileSync(`${base}.md`, report);
  console.error(`Wrote ${base}.json and .md`);
}
if (results.parity.length) {
  console.error('Fuel differs between the Cores.');
  process.exit(1);
}
