#!/usr/bin/env bun
// Browser Tetris benchmark (#1542): builds Folio minified, as `start` does,
// then plays the scripted game on Element and Canvas Tetris in Chromium,
// each run in a fresh context, alternating the two. Reports the page's frame
// rate, the Performance window's Fuel, and Chromium's own main-thread time
// split into script, style, layout and the rest. See bench-tetris.md.
// `--seconds 30 --runs 5` are the defaults; `--headed` shows the browser.
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser } from 'playwright';
import { build, dist } from './build';
import { type runTetrisBench } from './bench-tetris.page';

const { values } = parseArgs({
  options: {
    channel: { type: 'string' },
    headed: { type: 'boolean', default: false },
    runs: { type: 'string', default: '5' },
    seconds: { type: 'string', default: '30' },
  },
});
const RUNS = Number(values.runs);
const MS = Number(values.seconds) * 1000;

await build({ minify: true });
const bundled = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'bench-tetris.page.ts')],
  outdir: dist,
  target: 'browser',
  format: 'esm',
  minify: true,
  naming: 'bench-tetris.js',
});
if (!bundled.success) {
  throw new AggregateError(bundled.logs, 'Benchmark build failed');
}
writeFileSync(
  resolve(dist, 'bench-tetris.html'),
  readFileSync(resolve(dist, 'index.html'), 'utf8')
    .split('\n')
    .filter(line => !line.includes('src="./main.js"'))
    .join('\n'),
);

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = resolve(dist, `.${path}`);
    if (!file.startsWith(dist) || !(await Bun.file(file).exists())) {
      return new Response('Not found', { status: 404 });
    }
    return new Response(Bun.file(file), {
      headers: {
        'content-type': types[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      },
    });
  },
});

type Page = Awaited<ReturnType<typeof runTetrisBench>>;
type Row = Page & Record<string, number | string | boolean | undefined>;
// Chromium's cumulative main-thread durations, in seconds.
const METRICS = [
  'TaskDuration',
  'ScriptDuration',
  'RecalcStyleDuration',
  'LayoutDuration',
] as const;

const runOne = async (
  browser: Browser,
  game: 'element' | 'canvas',
): Promise<Row> => {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1200 },
    serviceWorkers: 'block',
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(MS + 60_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(new URL('/bench-tetris.html', server.url).href);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const sample = async () =>
      Object.fromEntries(
        (await cdp.send('Performance.getMetrics')).metrics.map(m => [
          m.name,
          m.value,
        ]),
      );
    const before = await sample();
    const result = await page.evaluate(
      async ({ game, ms, module }) => {
        const loaded = (await import(module)) as {
          runTetrisBench: typeof runTetrisBench;
        };
        return loaded.runTetrisBench(game, ms);
      },
      { game, ms: MS, module: '/bench-tetris.js' },
    );
    const after = await sample();
    if (errors.length) {
      throw new Error(errors.join('\n'));
    }
    const row: Row = { ...result };
    // Per page frame, in ms; Task covers the others plus paint and the rest.
    const frames = result.pageFps * result.seconds;
    for (const name of METRICS) {
      row[name] = ((after[name]! - before[name]!) * 1000) / frames;
    }
    return row;
  } finally {
    await context.close();
  }
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const spread = (values: number[]) =>
  median(values) === 0
    ? 0
    : ((Math.max(...values) - Math.min(...values)) / median(values)) * 100;

const browser = await chromium.launch({
  headless: !values.headed,
  ...(values.channel ? { channel: values.channel } : {}),
});
const results = { element: [] as Row[], canvas: [] as Row[] };
try {
  for (let run = 0; run < RUNS; run++) {
    for (const game of ['element', 'canvas'] as const) {
      const row = await runOne(browser, game);
      console.log(
        `run ${run + 1} ${game}: ${row.pageFps.toFixed(1)} fps, ${row.score}`,
      );
      results[game].push(row);
    }
  }
} finally {
  await browser.close();
  await server.stop(true);
}

const rows: [string, keyof Row, number][] = [
  ['Page frames per second', 'pageFps', 1],
  ['Frames over 25 ms', 'longFrames', 0],
  ['Frames delivered per second', 'deliveredFps', 1],
  ['Frames skipped (busy)', 'skipped', 0],
  ['Fuel per frame (all Runs)', 'fuelPerFrame', 0],
  ['Fuel per frame (frame Runs)', 'frameFuelPerFrame', 0],
  ['Views per frame', 'viewsPerFrame', 2],
  ['View handling ms per frame', 'viewMsPerFrame', 3],
  ['Main thread: task ms per frame', 'TaskDuration', 3],
  ['Main thread: script ms per frame', 'ScriptDuration', 3],
  ['Main thread: style ms per frame', 'RecalcStyleDuration', 3],
  ['Main thread: layout ms per frame', 'LayoutDuration', 3],
];
console.log(
  `\n${values.seconds} s per run, ${RUNS} runs each; medians, spread is (max - min) / median.\n`,
);
console.table(
  Object.fromEntries(
    rows.map(([label, key, digits]) => [
      label,
      Object.fromEntries(
        (['element', 'canvas'] as const).flatMap(game => {
          const each = results[game].map(row => Number(row[key]));
          return [
            [game, median(each).toFixed(digits)],
            [`${game} spread`, `${spread(each).toFixed(1)}%`],
          ];
        }),
      ),
    ]),
  ),
);
