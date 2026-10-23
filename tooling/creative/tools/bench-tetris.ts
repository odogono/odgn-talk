#!/usr/bin/env bun
// Headless Tetris benchmark (#1542): plays the same seeded, scripted game on
// Element Tetris and Canvas Tetris through the Play worker's PlayHost, as
// the page drives it, and reports Fuel, worker time and view size per frame.
// See bench-tetris.md. `--frames 3600 --runs 5` are the defaults.
import { parseArgs } from 'node:util';
import { createCanvasTetrisProject } from '../src/examples/tetris-canvas';
import { createTetrisProject } from '../src/examples/tetris';
import { type ExampleContent } from '../src/examples';
import { textOf } from '../src/model';
import { PlayHost } from '../src/play-host';
import { PlayMirror } from '../src/play-mirror';
import { type PlayRequest, type PlayResponse } from '../src/play-protocol';
import { type PerformanceSnapshot } from '../src/performance';
import { FRAME_MS, KEY_EVERY, SEED, tetrisKeys } from './bench-tetris-moves';

const { values } = parseArgs({
  options: {
    frames: { type: 'string', default: '3600' },
    runs: { type: 'string', default: '5' },
  },
});
const FRAMES = Number(values.frames);
const RUNS = Number(values.runs);

// The host schedules its Pumps with timers. Running them here, in order and
// at once, makes each frame finish before the next and keeps the clock ours.
const timers = new Map<number, () => void>();
let nextTimer = 1;
globalThis.setTimeout = ((fn: () => void) => {
  const id = nextTimer++;
  timers.set(id, fn);
  return id;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((id: number) =>
  timers.delete(id)) as unknown as typeof clearTimeout;
// The Performance window's 250 ms refresh; Stop sends the final snapshot.
globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
globalThis.clearInterval = (() => {}) as unknown as typeof clearInterval;
const drain = async () => {
  for (let i = 0; i < 100_000; i++) {
    // Pumps settle Promises between slices, as the tests' `settle` does.
    await Promise.resolve();
    const [id, fn] = timers.entries().next().value ?? [];
    if (id === undefined) {
      return;
    }
    timers.delete(id);
    fn!();
  }
  throw new Error('The host never became idle');
};

type Result = {
  commands: number;
  elements: number;
  frameFuel: number;
  frames: number;
  fuel: number;
  games: number;
  keyFuel: number;
  lines: string;
  score: string;
  torn: number;
  viewBytes: number;
  views: number;
  workerMs: number;
};

const play = async (create: () => Promise<ExampleContent>): Promise<Result> => {
  const { project } = await create();
  let ms = 0;
  const views: Extract<PlayResponse, { kind: 'view' }>[] = [];
  // The request each view answered, by its place in `views`.
  const viewRequests: number[] = [];
  let snapshot: PerformanceSnapshot | undefined;
  const mirror = new PlayMirror(() => {});
  const host = new PlayHost(
    ({ response }) => {
      if (response.kind === 'view') {
        views.push(response);
        viewRequests.push(id);
        mirror.apply(response);
      } else if (response.kind === 'performance') {
        snapshot = response.snapshot;
      }
    },
    () => BigInt(Math.round(ms * 1000)),
    () => ms,
  );
  let id = 1;
  let workerMs = 0;
  const request = async (request: PlayRequest) => {
    const started = performance.now();
    host.receive({ id: id++, request });
    await drain();
    workerMs += performance.now() - started;
  };
  await request({
    kind: 'open',
    session: 1,
    project,
    pageIndex: 0,
    seed: SEED,
    performanceEpoch: 1,
  });
  const keys = tetrisKeys();
  const element = (name: string) =>
    mirror.elementsOf().find(e => e.name === name);
  let games = 1;
  for (let frame = 1; frame <= FRAMES; frame++) {
    ms += FRAME_MS;
    await request({ kind: 'frame', session: 1 });
    if (frame % KEY_EVERY === 0) {
      const over = element('gameOverAlert');
      if (over && mirror.isVisible(over)) {
        games++;
        await request({
          kind: 'send',
          session: 1,
          pageIndex: 0,
          target: 'restartButton',
          message: 'click',
        });
      } else {
        const key = keys[(frame / KEY_EVERY - 1) % keys.length]!;
        await request({
          kind: 'send',
          session: 1,
          pageIndex: 0,
          message: 'keyDown',
          args: [key],
        });
      }
    }
  }
  const text = (name: string) => {
    const shown = element(name);
    return shown?.kind === 'text' ? textOf(shown) : '?';
  };
  const score = text('scoreText');
  const lines = text('linesText');
  await request({ kind: 'stop', session: 1 });
  // A board reset whose cells arrive in a later view for the same request:
  // the page painted it partly drawn in between.
  let torn = 0;
  let open: number | undefined;
  for (const [i, view] of views.entries()) {
    const board = view.drawings.find(d => d.name === 'boardCanvas');
    if (board?.reset) {
      open = viewRequests[i];
    } else if (board && open === viewRequests[i]) {
      torn++;
      open = undefined;
    }
  }
  const origins = snapshot!.scripts.flatMap(script => script.origins);
  const fuelOf = (origin: string) =>
    origins
      .filter(row => row.origin === origin)
      .reduce((sum, row) => sum + row.fuel, 0);
  return {
    frames: snapshot!.scripts.reduce(
      (sum, script) => sum + (script.frames?.delivered ?? 0),
      0,
    ),
    fuel: snapshot!.fuel,
    frameFuel: fuelOf('frame'),
    keyFuel: fuelOf('keyDown'),
    workerMs,
    views: views.length,
    viewBytes: views.reduce(
      (sum, view) => sum + JSON.stringify(view).length,
      0,
    ),
    elements: views.reduce((sum, view) => sum + view.elements.length, 0),
    commands: views.reduce(
      (sum, view) =>
        sum +
        view.drawings.reduce(
          (count, drawing) => count + drawing.commands.length,
          0,
        ),
      0,
    ),
    games,
    torn,
    score,
    lines,
  };
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

const games = [
  ['Element Tetris', createTetrisProject],
  ['Canvas Tetris', createCanvasTetrisProject],
] as const;
// Alternate the games, so warmup and machine load fall on both.
const results = new Map<string, Result[]>(games.map(([name]) => [name, []]));
for (let run = 0; run < RUNS; run++) {
  for (const [name, create] of games) {
    results.get(name)!.push(await play(create));
  }
}

const outcomes = games.map(([name]) => {
  const [first] = results.get(name)!;
  return `${first!.score}, ${first!.lines}, ${first!.games} games`;
});
console.log(
  `${FRAMES} frames at 60 Hz, a key every ${KEY_EVERY} frames, seed ${SEED}, ${RUNS} runs; medians, spread is (max - min) / median.\n`,
);
for (const [i, [name]] of games.entries()) {
  console.log(`${name}: ${outcomes[i]}`);
}
if (new Set(outcomes).size !== 1) {
  throw new Error('The two games did not play the same game');
}
const rows: [string, (result: Result) => number, number][] = [
  ['Fuel per frame (all Runs)', r => r.fuel / r.frames, 0],
  ['Fuel per frame (frame Runs)', r => r.frameFuel / r.frames, 0],
  ['Fuel per key (keyDown Runs)', r => r.keyFuel / (r.frames / KEY_EVERY), 0],
  ['Worker ms per frame', r => r.workerMs / r.frames, 3],
  ['Views per frame', r => r.views / r.frames, 2],
  ['View bytes per frame', r => r.viewBytes / r.frames, 0],
  ['Element entries per frame', r => r.elements / r.frames, 2],
  ['Canvas commands per frame', r => r.commands / r.frames, 1],
  ['Board views painted partly drawn', r => r.torn, 0],
];
console.log('');
console.table(
  Object.fromEntries(
    rows.map(([label, value, digits]) => [
      label,
      Object.fromEntries(
        games.flatMap(([name]) => {
          const each = results.get(name)!.map(value);
          return [
            [name, median(each).toFixed(digits)],
            [`${name} spread`, `${spread(each).toFixed(1)}%`],
          ];
        }),
      ),
    ]),
  ),
);
