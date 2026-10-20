import { expect, test } from 'bun:test';
import { type Report } from '@northtalk/ts';
import { PerformanceCapture } from '../src/performance';
import { PerformanceResults } from '../src/performance-results';
import { createProject } from '../src/model';
import { PlaySession, PUMP_FUEL } from '../src/play';

const start = (
  run: string,
  script = 'project',
  selector = 'click',
): Report => ({
  kind: 'run started',
  run,
  script,
  selector,
  args: [],
  rootDelivery: run,
});
const account = (
  run: string,
  fuel: number,
  state: 'live' | 'terminal' | 'discarded' = 'live',
): Report => ({
  kind: 'run accounting',
  run,
  script: 'project',
  fuel,
  state,
  rootDelivery: run,
});
const end = (
  run: string,
  outcome: 'completed' | 'errored' = 'completed',
): Report => ({
  kind: 'run end',
  run,
  script: 'project',
  fuel: 0,
  alloc: 0,
  outcome,
});
const fixture = () => {
  let now = 0;
  const capture = new PerformanceCapture(() => now);
  return {
    capture,
    time: (time: number) => {
      now = time;
    },
    snapshot: () => capture.snapshot(5000)!,
  };
};

test('opt-in accounting uses cumulative deltas and the final accounting tail', () => {
  const { capture, snapshot } = fixture();
  capture.reports([start('old'), account('old', 20)]);
  expect(capture.snapshot(5000)).toBeUndefined();
  capture.start(1);
  capture.reports([account('old', 23), start('new'), account('new', 10)], 13);
  capture.reports([account('new', 10)]);
  capture.reports(
    [
      end('old'),
      end('new', 'errored'),
      account('old', 25, 'terminal'),
      account('new', 15, 'terminal'),
    ],
    7,
  );
  const row = snapshot().scripts[0]!.origins[0]!;
  expect(row).toMatchObject({
    fuel: 20,
    started: 1,
    completed: 2,
    failed: 1,
    active: 0,
    samples: 1,
    last: 15,
    peak: 15,
    sampleFuel: 15,
  });
  expect(snapshot()).toMatchObject({ fuel: 20, pumpPeak: 13 });
});

test('Clear baselines in-flight work, including discarded Runs', () => {
  const { capture, snapshot } = fixture();
  capture.start(1);
  capture.reports([start('run'), account('run', 30)]);
  capture.start(2);
  expect(snapshot().scripts[0]!.active).toBe(1);
  capture.reports([account('run', 35, 'discarded')]);
  expect(snapshot().scripts[0]).toMatchObject({
    fuel: 5,
    active: 0,
    discarded: 1,
    samples: 0,
  });
  expect(snapshot().epoch).toBe(2);
});

test('frame rates and history use elapsed time and expire after 60 seconds', () => {
  const { capture, snapshot, time } = fixture();
  capture.frameScript('project');
  capture.start(1);
  capture.frame('project', false);
  capture.frame('project', true);
  capture.reports([start('r'), account('r', 42)], 42);
  time(500);
  expect(snapshot().scripts[0]!.frames).toEqual({
    delivered: 1,
    skipped: 1,
    rate: 2,
  });
  time(65_000);
  expect(snapshot().history).toHaveLength(60);
  expect(snapshot().history.every(bucket => bucket.fuel === 0)).toBe(true);
  expect(snapshot().scripts[0]!.rate).toBe(0);
  expect(snapshot().scripts[0]!.frames?.rate).toBe(0);
  expect(snapshot().fuel).toBe(42);
  capture.stop();
  time(80_000);
  expect(snapshot().elapsed).toBe(65);
  expect(snapshot().status).toBe('stopped');
});

test('repeated Script names merge while clones and Run origins stay distinct', () => {
  const { capture, snapshot } = fixture();
  capture.start(1);
  capture.reports([
    start('a', 'element:P/x'),
    account('a', 5, 'terminal'),
    start('b', 'element:P/x', 'frame'),
    account('b', 7, 'terminal'),
    start('c', 'element:P/x:dynamic:1'),
    account('c', 9, 'terminal'),
  ]);
  expect(snapshot().scripts).toHaveLength(2);
  expect(
    snapshot().scripts.find(s => s.script === 'element:P/x')?.origins,
  ).toHaveLength(2);
});

test('page telemetry rejects old sessions, pre-Clear updates and interrupted-worker updates', () => {
  const { capture, snapshot } = fixture();
  const results = new PerformanceResults();
  results.reset(1);
  capture.start(results.epoch);
  const first = snapshot();
  expect(results.receive(1, first)).toBe(true);
  results.clear();
  expect(results.receive(1, first)).toBe(false);
  capture.start(results.epoch);
  expect(results.receive(1, snapshot())).toBe(true);
  results.interrupted();
  expect(results.snapshot?.status).toBe('incomplete');
  expect(results.receive(1, snapshot())).toBe(false);
  results.reset(2);
  expect(results.receive(1, first)).toBe(false);
});

test('real Core accounting attributes internal calls to their Run origin and captures frame skips', async () => {
  const project = createProject('Performance');
  project.script =
    'on frame elapsed\n work\n wait 100 ms\nend frame\non work\n return 1 + 2\nend work';
  const play = new PlaySession(project, 0, { events: false });
  expect(play.problems).toEqual([]);
  play.performance.start(1);
  play.frame(0n);
  const first = play.pump(0n);
  play.frame(1000n);
  const snapshot = play.performance.snapshot(PUMP_FUEL)!;
  const row = snapshot.scripts.find(s => s.script === 'script:project')!;
  expect(row.frames).toMatchObject({ delivered: 1, skipped: 1 });
  expect(row.origins.map(o => o.origin)).toEqual(['frame']);
  expect(row.fuel).toBe(first.fuelUsed);
  play.pump(200_000n);
  await Promise.resolve();
  play.frame(210_000n);
  play.pump(210_000n);
  play.stop(220_000n);
  expect(play.performance.snapshot(PUMP_FUEL)?.status).toBe('stopped');
});

test('independently spawned Runs have their own origins and summed Fuel equals Core accounting', () => {
  const project = createProject('Spawn');
  project.script =
    'on click\n send work to me\nend click\non work\n return 1 + 2\nend work';
  const play = new PlaySession(project, 0, { events: false });
  expect(play.problems).toEqual([]);
  play.performance.start(1);
  play.send(play.project, 'click');
  const result = play.pump(0n);
  const snapshot = play.performance.snapshot(PUMP_FUEL)!;
  expect(snapshot.scripts[0]!.origins.map(row => row.origin).sort()).toEqual([
    'click',
    'work',
  ]);
  expect(snapshot.fuel).toBe(result.fuelUsed);
  play.stop(0n);
});

test('reload accounting removes discarded live Runs and preserves interval totals', () => {
  const project = createProject('Reload');
  project.script = 'on click\n wait 1 s\nend click';
  const play = new PlaySession(project, 0, { events: false });
  play.performance.start(1);
  play.send(play.project, 'click');
  play.pump(0n);
  expect(play.performance.snapshot(PUMP_FUEL)!.scripts[0]!.active).toBe(1);
  const reports = play.group
    .script('script:project')!
    .reload(project.script, 'reset variables');
  play.performance.reports(reports);
  expect(play.performance.snapshot(PUMP_FUEL)!.scripts[0]).toMatchObject({
    active: 0,
    discarded: 1,
  });
  play.send(play.project, 'click');
  play.pump(0n);
  expect(play.performance.snapshot(PUMP_FUEL)!.scripts[0]!.started).toBe(2);
  play.stop(0n);
});

test('termination before the first snapshot still rejects the interrupted capture', () => {
  const results = new PerformanceResults();
  results.reset(1);
  results.interrupted();
  const capture = new PerformanceCapture();
  capture.start(results.epoch);
  expect(results.incomplete).toBe(true);
  expect(results.receive(1, capture.snapshot(PUMP_FUEL)!)).toBe(false);
});
