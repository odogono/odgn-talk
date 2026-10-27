// `bun run bench:profile <filter>`: CPU-profiles the TS runner on the selected
// Benchmarks and prints the hottest Core functions by self time. The full
// Markdown profile, with call trees, stays in .cache/profiles. See
// bench/README.md#profiling.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { positionals, values: flags } = parseArgs({
  allowPositionals: true,
  options: { top: { default: '25', type: 'string' } },
});
const filter = positionals[0] ?? '';
const root = resolve(import.meta.dirname, '../../..');
const dir = join(root, '.cache', 'profiles', String(Date.now()));
mkdirSync(dir, { recursive: true });

const result = spawnSync(
  'bun',
  [
    '--cpu-prof-md',
    `--cpu-prof-dir=${dir}`,
    '--cpu-prof-interval=200',
    join(import.meta.dirname, 'measure-ts.ts'),
    filter,
  ],
  { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 },
);
if (result.status !== 0) {
  console.error(result.stderr);
  process.exit(1);
}
const file = join(
  dir,
  readdirSync(dir).find(name => name.endsWith('.md'))!,
);
const text = readFileSync(file, 'utf8');
const table = text
  .slice(text.indexOf('## Hot Functions'), text.indexOf('## Call Tree'))
  .split('\n')
  .filter(line => line.startsWith('| '));
// The harness (mitata) and native frames hide the Core's own hot spots.
const rows = table
  .slice(1)
  .filter(line => line.includes(root) && !line.includes('node_modules'))
  .slice(0, Number(flags.top))
  .map(line => line.replaceAll(`${root}/`, ''));
console.log(table[0]);
console.log('|---:|---:|---:|---:|---|---|');
console.log(rows.join('\n'));
console.log(`\nFull profile: ${relative(root, file)}`);
