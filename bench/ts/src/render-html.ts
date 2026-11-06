// `bun run bench:html <results.json> [out.html]`: renders a saved run as the
// benchmark page, by default .cache/benchmarks.html. See bench/README.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { html } from './html';
import type { Results } from './report';

const [
  input,
  output = join(import.meta.dir, '../../../.cache/benchmarks.html'),
] = process.argv.slice(2);
if (!input) {
  console.error('Usage: bun run bench:html <results.json> [out.html]');
  process.exit(2);
}
const results = JSON.parse(readFileSync(input, 'utf8')) as Results;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, html(results));
console.error(`Wrote ${output}`);
