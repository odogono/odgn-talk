import { expect, test } from 'bun:test';
import { category, html } from '../src/html';
import { markdown, type Payload, type Results } from '../src/report';

const sizes = (raw: number) => ({ brotli: raw / 4, gzip: raw / 3, raw });
const payload: Payload = {
  talkWasm: sizes(3_000_000),
  tsHost: sizes(600_000),
  tsPackage: sizes(598_000),
  wasmHost: sizes(180_000),
  wasmPackage: sizes(178_000),
};
const run = (medianNs: number) => ({
  maxNs: medianNs * 1.2,
  medianNs,
  minNs: medianNs * 0.9,
  samples: 10,
});
const results = (extra: Partial<Results> = {}): Results => ({
  commit: 'abc1234',
  date: '2026-10-22',
  machine: {
    arch: 'x64',
    cores: 4,
    cpu: 'AMD EPYC',
    memory: '16 GiB',
    os: 'linux',
  },
  measurements: [
    {
      benchmark: 'core/fib',
      fuel: 100,
      load: run(5000),
      run: run(2e6),
      runner: 'zig',
    },
    {
      benchmark: 'core/fib',
      fuel: 100,
      load: run(9000),
      run: run(4e6),
      runner: 'ts',
    },
    { benchmark: 'core/fib', run: run(1e5), runner: 'gopher-lua' },
    { benchmark: 'text/<split>', fuel: 50, run: run(3e5), runner: 'ts' },
  ],
  outlierFactor: 3,
  outliers: [
    { benchmark: 'text/<split>', factor: 4.5, nsPerFuel: 6000, runner: 'ts' },
  ],
  parity: [{ benchmark: 'core/fib', fuel: { ts: 100, zig: 101 } }],
  settings: { count: 10, filter: '', runners: 'ts,zig,peers', smoke: false },
  skipped: [
    { benchmark: 'core/fib', reason: 'no port yet', runner: 'applescript' },
  ],
  versions: { bun: '1.4.2', language: '0.1' },
  ...extra,
});

test("a Benchmark's category is its script directory", () => {
  expect(category('core/fib')).toBe('core');
  expect(category('loose')).toBe('');
});

test('the page shows every Benchmark and runner, with one chart per Benchmark', () => {
  const page = html(results());
  for (const name of [
    'core/fib',
    'zig',
    'ts',
    'gopher-lua',
    'abc1234',
    'AMD EPYC',
  ]) {
    expect(page).toContain(name);
  }
  expect(page.match(/<figure class="chart" data-category/g)).toHaveLength(2);
  expect(page).toContain('ADR 0054');
});

test('the page escapes what it interpolates', () => {
  const page = html(results());
  expect(page).toContain('text/&lt;split&gt;');
  expect(page).not.toContain('text/<split>');
});

test('the page lists Fuel parity failures, outliers and skipped Benchmarks', () => {
  const page = html(results());
  expect(page).toContain('ts 100, zig 101');
  expect(page).toContain('4.5× the median');
  expect(page).toContain('no port yet');
  const clean = html(results({ outliers: [], parity: [], skipped: [] }));
  expect(clean).toContain('Every Benchmark used the same Fuel on each Core.');
  expect(clean).not.toContain('id="skipped"');
});

test('the page loads nothing from elsewhere', () => {
  const page = html(results({ payload }));
  expect(page).not.toMatch(/\bsrc=/);
  expect(page).not.toMatch(/href="https?:/);
});

test("the page and the Markdown show each Core's Payload only when it was measured", () => {
  const page = html(results({ payload }));
  expect(page).toContain('id="payload"');
  expect(page).toContain('Zig Core: Example Host + talk.wasm');
  // (180,000 + 3,000,000) / 600,000
  expect(page).toContain('5.3×');
  expect(page).toContain('title="150000 B"');
  expect(markdown(results({ payload }))).toContain(
    '| Zig ÷ TS Example Host | 5.3× | 5.3× | 5.3× |',
  );
  expect(html(results())).not.toContain('id="payload"');
  expect(markdown(results())).not.toContain('## Payload');
});

test('without a reactor the Payload shows the TS Core alone', () => {
  const tsOnly = { tsHost: payload.tsHost, tsPackage: payload.tsPackage };
  const page = html(results({ payload: tsOnly }));
  expect(page).toContain('TS Core: Example Host');
  expect(page).not.toContain('Zig Core');
  expect(markdown(results({ payload: tsOnly }))).not.toContain('Zig');
});
