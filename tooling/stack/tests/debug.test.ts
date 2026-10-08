import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileSource,
  defineCapability,
  newGroup,
  num,
} from '@odgn/northtalk';
import { replay } from '../../../impl/ts/tools/trace-case';
import { LiveDebugger, renderDebugView } from '../src/debug';
import { verifyRecoveryDebugFeatures } from './verify-recovery-debug';

test('Recovery Offers use active stepping depth and shared owner frame views', () => {
  expect(verifyRecoveryDebugFeatures()).toBe(12);
});

const source =
  'script variable n = 0\non go\n  put 1 into n\n  put 2 into n\n  return n\nend';
const setup = (code = source) => {
  const trace: string[] = [];
  const group = newGroup({ name: 'g', trace: line => trace.push(line) });
  const script = group.load({ name: 's', source: code });
  const debug = new LiveDebugger(group, { now: () => 0n });
  debug.registerSource(compileSource(code, { name: 's' }).unit!, 's');
  return { group, script, debug, trace };
};

test('source breakpoints pause the Group and inspection does not write Host Inputs', () => {
  const { script, debug, trace } = setup();
  expect(
    debug.setBreakpoints([{ unit: 's', script: 's', line: 4 }])[0],
  ).toMatchObject({ verified: true, line: 4, col: 7 });
  script.deliver({ name: 'go' });
  expect(debug.pump().state).toBe('paused');
  const before = [...trace];
  const snapshot = debug.snapshot();
  expect(snapshot.scripts[0]!.vars[0]![1].equals(num(1))).toBe(true);
  expect(renderDebugView(snapshot, 'vars')).toEqual(['[s] n = 1']);
  expect(renderDebugView(snapshot, 'runs')[0]).toMatch(
    /s\/r1 .* segment 1 fuel \d+/,
  );
  expect(trace).toEqual(before);
  expect(debug.resume().state).toBe('idle');
});

test('breakpoints resolve columns, reject missing positions and rebind after Reload', () => {
  const { debug, script } = setup();
  const positions = debug.setBreakpoints([
    { unit: 's', line: 3, col: 7 },
    { unit: 's', line: 2 },
    { unit: 'missing', line: 3 },
  ]);
  expect(positions[0]).toMatchObject({ verified: true, col: 7 });
  expect(positions.slice(1).every(p => !p.verified)).toBe(true);
  expect(() => debug.setBreakpoints([{ unit: 's', line: 0 }])).toThrow();
  const changed = 'on go\n put 8 into x\n return x\nend';
  script.reload(changed, 'reset variables');
  debug.registerSource(compileSource(changed, { name: 's' }).unit!, 's');
  debug.setBreakpoints([{ unit: 's', script: 's', line: 3 }]);
  script.deliver({ name: 'go' });
  expect(debug.pump().state).toBe('paused');
  expect(debug.current?.line).toBe(3);
  debug.resume();
});

test('statement steps enter Functions, step out and step over', () => {
  const code =
    'function twice x\n return x * 2\nend twice\non go\n put twice(3) into n\n return n\nend';
  const { debug, script } = setup(code);
  debug.setBreakpoints([{ unit: 's', line: 5 }]);
  script.deliver({ name: 'go' });
  debug.pump();
  debug.clearBreakpoints();
  expect(debug.step().state).toBe('paused');
  expect(debug.current?.line).toBe(2);
  debug.stepOut();
  expect(debug.current?.line).toBe(6);
  debug.resume();
});

test('step over a suspension lets other Runs execute and their breakpoints pause the Group', () => {
  const { group, script, debug } = setup('on go\n wait 1 s\n return 2\nend');
  const other = 'script variable n = 0\non go\n put 3 into n\n return n\nend';
  const t = group.load({ name: 't', source: other });
  debug.registerSource(compileSource(other, { name: 't' }).unit!, 't');
  debug.setBreakpoints([
    { unit: 's', line: 2 },
    { unit: 't', line: 4 },
  ]);
  script.deliver({ name: 'go' });
  debug.pump();
  t.deliver({ name: 'go' });
  expect(debug.stepOver().state).toBe('idle');
  expect(debug.pump(0n).state).toBe('paused');
  expect(debug.current?.script).toBe('t');
  debug.clearBreakpoints();
  debug.resume();
  debug.pump(1_000_000_000n);
  expect(group.inspect().scripts[1]!.vars[0]![1].equals(num(3))).toBe(true);
});

test('a step over remains armed through a deadline Pump', () => {
  const { script, debug } = setup('on go\n wait 1 s\n return 2\nend');
  debug.setBreakpoints([{ unit: 's', line: 2 }]);
  script.deliver({ name: 'go' });
  debug.pump();
  debug.clearBreakpoints();
  debug.stepOver();
  expect(debug.pump(1_000_000_000n).state).toBe('paused');
  expect(debug.current?.line).toBe(3);
  expect(debug.snapshot().scripts[0]!.runs[0]!.segment).toBe(2);
  debug.resume();
});

for (const caught of [true, false]) {
  test(`break on ${caught ? 'caught' : 'uncaught'} Error exposes state before unwinding`, () => {
    const { script, debug } = setup(
      `script variable n = 0\non go\n put 9 into n\n ${caught ? 'try\n' : ''} throw "oops"\n ${caught ? 'catch e\n put 10 into n\n end try\n' : ''}end`,
    );
    debug.pauseOn({ error: true });
    script.deliver({ name: 'go' });
    expect(debug.pump().state).toBe('paused');
    expect(debug.current?.reason).toBe('error');
    expect(debug.snapshot().scripts[0]!.vars[0]![1].equals(num(9))).toBe(true);
    debug.resume();
  });
}

test('live Clock subtracts time spent paused and freezes during a pause', async () => {
  const { group, script } = setup();
  const debug = new LiveDebugger(group, {
    now: () => BigInt(Math.floor(performance.now() * 1_000_000)),
  });
  debug.registerSource(compileSource(source, { name: 's' }).unit!, 's');
  debug.setBreakpoints([{ unit: 's', line: 3 }]);
  script.deliver({ name: 'go' });
  debug.pump();
  const before = debug.clock();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(Number(debug.clock() - before)).toBeLessThan(2_000_000);
  debug.resume();
  const resumed = debug.clock();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(Number(debug.clock() - resumed)).toBeGreaterThan(5_000_000);
});

for (const mode of ['send', 'function'] as const) {
  test(`step into and out follow a foreign ${mode} Run`, () => {
    const { group, debug } = setup();
    const homeSource =
      'function f n\n return n * 2\nend f\non exported\n return f\nend\non work\n return 4\nend';
    const home = group.load({ name: 'home', source: homeSource });
    debug.registerSource(
      compileSource(homeSource, { name: 'home' }).unit!,
      'home',
    );
    home.deliver({ name: 'exported' });
    const report = group.pump(0n).reports.find(r => r.kind === 'run end');
    if (!report || report.kind !== 'run end' || !report.result) {
      throw new Error('No Function Value');
    }
    const callerSource =
      mode === 'send'
        ? 'on go f\n send work to home and wait\n return it\nend'
        : 'on go f\n f(7) and wait\n return it\nend';
    const caller = group.load({ name: 'caller', source: callerSource });
    debug.registerSource(
      compileSource(callerSource, { name: 'caller' }).unit!,
      'caller',
    );
    debug.setBreakpoints([{ unit: 'caller', line: 2 }]);
    caller.deliver({ name: 'go', args: [report.result] });
    debug.pump(0n);
    debug.clearBreakpoints();
    expect(debug.step().state).toBe('paused');
    expect(debug.current?.script).toBe('home');
    expect(debug.stepOut().state).toBe('paused');
    expect(debug.current?.script).toBe('caller');
    expect(debug.current?.line).toBe(3);
    debug.resume();
  });
}

test('break on Limit Fault exposes values before rollback', () => {
  const source =
    'script variable n = 0\non go\n put 9 into n\n repeat forever\n put n + 1 into n\n end repeat\nend';
  const group = newGroup({ name: 'g' });
  const script = group.load({ name: 's', source, limits: { fuelPerRun: 20 } });
  const debug = new LiveDebugger(group, { now: () => 0n });
  debug.pauseOn({ limitFault: true });
  script.deliver({ name: 'go' });
  expect(debug.pump(0n).state).toBe('paused');
  expect(debug.current?.reason).toBe('limitFault');
  expect(debug.snapshot().scripts[0]!.vars[0]![1].equals(num(0))).toBe(false);
  debug.resume();
  expect(group.inspect().scripts[0]!.vars[0]![1].equals(num(0))).toBe(true);
});

test('paused-time subtraction cannot make a coarse Host Clock go backwards', () => {
  const { group, script } = setup();
  const debug = new LiveDebugger(group, { now: () => 1_000_000_000n });
  debug.registerSource(compileSource(source, { name: 's' }).unit!, 's');
  debug.setBreakpoints([{ unit: 's', line: 3 }]);
  const before = debug.clock();
  script.deliver({ name: 'go' });
  debug.pump();
  expect(debug.clock()).toBeGreaterThanOrEqual(before);
  debug.clearBreakpoints();
  debug.resume();
  expect(() => debug.pump()).not.toThrow();
});

// Fix and Continue (ADR 0068): `go` makes a fire-and-forget call, then pauses
// at line 4, still in its first Segment.
const logged =
  'script variable n = 0\non go\n  tell log to write\n  put 1 into n\n  return n\nend';
const fixedLog = logged.replace('put 1', 'put 2');
const loggingSetup = () => {
  const trace: string[] = [];
  const log = defineCapability('log', {
    write: { mode: 'fire-and-forget', cost: { fuel: 1 }, fire: () => {} },
  });
  const group = newGroup({ name: 'g', trace: line => trace.push(line) });
  const script = group.load({
    name: 's',
    source: logged,
    grants: { log: log.grant('all', undefined) },
  });
  const debug = new LiveDebugger(group, { now: () => 0n });
  debug.registerSource(compileSource(logged, { name: 's' }).unit!, 's');
  debug.setBreakpoints([{ unit: 's', script: 's', line: 4 }]);
  return { script, debug, trace };
};

test('Fix and Continue reruns the paused message on the edited code', () => {
  const { script, debug } = loggingSetup();
  script.deliver({ name: 'go' });
  expect(debug.pump()).toMatchObject({ state: 'paused' });
  expect(debug.repeatedEffects()).toEqual([
    { kind: 'call', id: 's/r1.c1', op: 'log.write' },
  ]);
  const restarted = debug.fixAndContinue(
    fixedLog,
    'carry variables',
    compileSource(fixedLog, { name: 's' }).unit!,
  );
  // Paused at the first instruction of the Run that runs d1 again.
  expect(restarted).toMatchObject({
    state: 'paused',
    pause: { run: 's/r2', reason: 'step' },
  });
  expect(renderDebugView(debug.snapshot(), 'vars')).toEqual(['[s] n = 0']);
  debug.clearBreakpoints();
  const done = debug.resume();
  expect(done.state).toBe('idle');
  const ended =
    done.state !== 'paused' && done.reports.find(r => r.kind === 'run end');
  expect(
    ended && ended.kind === 'run end' && ended.result?.equals(num(2)),
  ).toBe(true);
});

test('Fix and Continue refuses a Run past its first Segment', () => {
  const { debug, script } = setup(
    'on go\n  wait 1 ms\n  put 1 into n\n  return n\nend',
  );
  debug.setBreakpoints([{ unit: 's', script: 's', line: 3 }]);
  script.deliver({ name: 'go' });
  debug.pump();
  expect(debug.pump(2_000_000n).state).toBe('paused');
  expect(() =>
    debug.fixAndContinue(
      'on go\nend',
      'reset variables',
      compileSource('on go\nend', { name: 's' }).unit!,
    ),
  ).toThrow('passed a Suspension Point');
  expect(debug.isPaused).toBe(true);
});

test('a Rewind landed at a live breakpoint replays at the same instruction', () => {
  const { script, debug, trace } = loggingSetup();
  script.deliver({ name: 'go' });
  debug.pump();
  debug.fixAndContinue(
    fixedLog,
    'carry variables',
    compileSource(fixedLog, { name: 's' }).unit!,
  );
  debug.clearBreakpoints();
  debug.resume();
  expect(trace.find(l => l.startsWith('> rewind-run'))).toMatch(/ pc=\d+$/);
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-fix-'));
  try {
    writeFileSync(join(dir, 's.talk'), logged);
    const setup = {
      kind: 'trace',
      versions: { language: '1.0-rc.2', costModel: '0' },
      operations: [
        {
          capability: 'log',
          name: 'write',
          mode: 'fire-and-forget',
          cost: { fuel: 1 },
        },
      ],
      scripts: [
        { name: 's', source: 's.talk', grants: { log: { ops: 'all' } } },
      ],
    };
    expect(replay(dir, setup as never, trace)).toEqual(trace);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
