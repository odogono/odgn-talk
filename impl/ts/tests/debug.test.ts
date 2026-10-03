import { expect, test } from 'bun:test';
import { newGroup, num, restore } from '../src/index';
import { compileSource } from '../src/lowering';

const source =
  'script variable n = 0\non go\n  put 1 into n\n  put 2 into n\n  return n\nend';
const instruction = (line: number) => {
  const unit = compileSource(source, { name: 's' }).unit!;
  return { unit: 's', pc: unit.code.findIndex(i => i.line === line) };
};

test('a replacement paused before payment cancels its owner only after paying', () => {
  for (const cancelIncoming of [false, true]) {
    const source =
      'script variable n = 0\non go, replacing\n try\n  wait 1 s\n finally\n  add 1 to n\n end try\nend go';
    const unit = compileSource(source, { name: 's' }).unit!;
    const trace: string[] = [];
    const group = newGroup({ name: 'g', trace: line => trace.push(line) });
    const s = group.load({ name: 's', source });
    s.deliver({ name: 'go' });
    group.pump(0n);
    const debug = group.debug();
    debug.breakAt([{ unit: 's', pc: unit.code.findIndex(i => i.line === 4) }]);
    s.deliver({ name: 'go', limits: { fuelPerRun: 5 } });
    group.pump(0n);
    expect(debug.isPaused).toBe(true);
    expect(trace.some(line => line.startsWith('run s/r1 '))).toBe(false);
    if (cancelIncoming) {
      s.cancelRun('s/r2');
    }
    debug.clearBreaks();
    debug.resume();
    group.pump(1_000_000_000n);
    const owner = trace.filter(line => line.startsWith('run s/r1 '));
    expect(owner).toHaveLength(1);
    expect(owner[0]).toContain(
      `outcome=${cancelIncoming ? 'completed' : 'cancelled'}`,
    );
  }
});

test('a durable whole-Group pause resumes the same Pump and preserves Trace and slices', () => {
  const run = (debugging: boolean) => {
    const trace: string[] = [];
    const group = newGroup({ name: 'g', trace: l => trace.push(l) });
    const s = group.load({ name: 's', source });
    group
      .load({ name: 't', source: 'on go\n return 3\nend' })
      .deliver({ name: 'go' });
    const controller = group.debug();
    if (debugging) {
      controller.breakAt([instruction(4)]);
    }
    s.deliver({ name: 'go' });
    const results = [];
    for (let i = 0; i < 30; i++) {
      let result = group.pump(0n, { fuelSlice: 13 });
      while (controller.isPaused) {
        const snapshot = controller.snapshot();
        expect(snapshot.scripts[0]!.vars[0]![1].equals(num(1))).toBe(true);
        expect(snapshot.scripts[0]!.runs[0]!.segment).toBe(1);
        expect(snapshot.scripts[0]!.runs[0]!.fuel).toBeGreaterThan(0);
        expect(() => group.inspect()).toThrow();
        controller.clearBreaks();
        result = controller.resume()!;
      }
      results.push(result);
      if (result.state === 'idle') {
        break;
      }
    }
    return { trace, results };
  };
  expect(run(true)).toEqual(run(false));
});

test('fault breaks retain variables before Limit Fault rollback and caught errors unwind', () => {
  for (const fault of ['error', 'limitFault'] as const) {
    const trace: string[] = [];
    const group = newGroup({ name: 'g', trace: l => trace.push(l) });
    const s = group.load({
      name: 's',
      source:
        'script variable n = 0\non go\n put 9 into n\n try\n  throw "oops"\n catch e\n  put 10 into n\n end try\n return n\nend',
      ...(fault === 'limitFault' ? { limits: { fuelPerRun: 20 } } : {}),
    });
    const debug = group.debug();
    debug.pauseOn({ [fault]: true });
    s.deliver({ name: 'go' });
    group.pump(0n);
    expect(debug.isPaused).toBe(true);
    expect(debug.snapshot().scripts[0]!.vars[0]![1].equals(num(9))).toBe(true);
    expect(debug.current?.reason).toBe(fault);
    debug.resume();
    expect(debug.isPaused).toBe(false);
    expect(
      group
        .inspect()
        .scripts[0]!.vars[0]![1].equals(num(fault === 'error' ? 10 : 0)),
    ).toBe(true);
  }
});

test('statement stepping stops at statement starts and reports monotonic paused time', () => {
  const group = newGroup({ name: 'g' });
  const s = group.load({ name: 's', source });
  const debug = group.debug();
  debug.breakAt([instruction(3)]);
  s.deliver({ name: 'go' });
  group.pump(0n);
  expect(debug.current?.line).toBe(3);
  debug.step();
  expect(debug.current?.line).toBe(4);
  expect(debug.pausedTime()).toBeGreaterThanOrEqual(0);
  debug.step();
  expect(debug.current?.line).toBe(5);
  debug.clearBreaks();
  debug.resume();
  expect(debug.isPaused).toBe(false);
  expect(() => debug.snapshot()).toThrow();
});

test('step over a Function call and step out stop in the caller', () => {
  const source =
    'function double x\n return x * 2\nend double\non go\n put double(3) into x\n return x\nend';
  const unit = compileSource(source, { name: 's' }).unit!;
  for (const mode of ['over', 'out'] as const) {
    const group = newGroup({ name: 'g' });
    const s = group.load({ name: 's', source });
    const debug = group.debug();
    debug.breakAt([{ unit: 's', pc: unit.code.findIndex(i => i.line === 5) }]);
    s.deliver({ name: 'go' });
    group.pump(0n);
    debug.clearBreaks();
    if (mode === 'over') {
      debug.stepOver();
    } else {
      debug.step();
      expect(debug.current?.line).toBe(2);
      debug.stepOut();
    }
    expect(debug.current?.line).toBe(6);
    debug.resume();
  }
});

test('step over a suspension follows the same Run past its resumption', () => {
  const source = 'on go\n wait 1 s\n return 2\nend';
  const unit = compileSource(source, { name: 's' }).unit!;
  const group = newGroup({ name: 'g' });
  const s = group.load({ name: 's', source });
  const debug = group.debug();
  debug.breakAt([{ unit: 's', pc: unit.code.findIndex(i => i.line === 2) }]);
  s.deliver({ name: 'go' });
  group.pump(0n);
  debug.clearBreaks();
  expect(debug.stepOver()?.state).toBe('idle');
  group.pump(1_000_000_000n);
  expect(debug.current?.line).toBe(3);
  debug.resume();
});

test('replay early Stop and CancelRun land before the named instruction', () => {
  for (const stop of [true, false]) {
    const trace: string[] = [];
    const group = newGroup({ name: 'g', trace: line => trace.push(line) });
    const s = group.load({ name: 's', source });
    const debug = group.debug();
    s.deliver({ name: 'go' });
    debug.landAt(3, instruction(4));
    group.pump(0n);
    expect(debug.current?.reason).toBe('replay');
    expect(debug.snapshot().scripts[0]!.vars[0]![1].equals(num(1))).toBe(true);
    if (stop) {
      s.stop('early');
    } else {
      s.cancelRun('s/r1');
    }
    debug.resume();
    expect(trace).toContain(
      stop
        ? `> stop s reason="early" pc=${instruction(4).pc}`
        : `> cancel-run s/r1 pc=${instruction(4).pc}`,
    );
    expect(group.inspect().scripts[0]!.vars[0]![1].equals(num(0))).toBe(true);
  }
});

test('step into follows a send-and-wait receiver past unrelated runnable Scripts', () => {
  const source = 'on go\n send work to u and wait\n return it\nend';
  const group = newGroup({ name: 'g' });
  const s = group.load({ name: 's', source });
  group
    .load({ name: 't', source: 'on go\n put 3 into x\n return x\nend' })
    .deliver({ name: 'go' });
  group.load({ name: 'u', source: 'on work\n return 4\nend' });
  const unit = compileSource(source, { name: 's' }).unit!;
  const debug = group.debug();
  debug.breakAt([{ unit: 's', pc: unit.code.findIndex(i => i.line === 2) }]);
  s.deliver({ name: 'go' });
  group.pump(0n);
  debug.clearBreaks();
  debug.step();
  expect(debug.current?.script).toBe('u');
  debug.stepOut();
  expect(debug.current?.script).toBe('s');
  expect(debug.current?.line).toBe(3);
  debug.resume();
});

test('debug state is absent from saves and Fingerprints, including restored Groups', () => {
  const plain = newGroup({ name: 'g' });
  const debugged = newGroup({ name: 'g' });
  for (const group of [plain, debugged]) {
    group.load({ name: 's', source }).deliver({ name: 'go' });
    group.pump(0n, { fuelCap: 3 });
  }
  const debug = debugged.debug();
  debug.breakAt([instruction(4)]);
  debug.pauseOn({ error: true, limitFault: true });
  expect(debugged.fingerprint()).toEqual(plain.fingerprint());
  const saved = debugged.save();
  expect(saved).toEqual(plain.save());
  const restored = restore(saved, {
    name: 'g',
    libraries: [],
    grants: () => undefined,
    resolve: () => undefined,
    onMismatch: 'reject',
  }).group;
  expect(restored.debug().isPaused).toBe(false);
  expect(restored.pump(0n).state).toBe('idle');
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { replay } from '../tools/trace-case';

test('a recorded early landing Trace replays in both replay modes', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'northtalk-debug-'));
  try {
    writeFileSync(resolve(dir, 's.talk'), source);
    for (const stop of [true, false]) {
      const trace: string[] = [];
      const group = newGroup({ name: 'g', trace: line => trace.push(line) });
      const s = group.load({ name: 's', source });
      s.deliver({ name: 'go' });
      group.debug().landAt(3, instruction(4));
      group.pump(0n);
      if (stop) {
        s.stop('early');
      } else {
        s.cancelRun('s/r1');
      }
      group.debug().resume();
      const setup = { scripts: [{ name: 's', source: 's.talk' }] };
      for (const restoreBetweenPumps of [true, false]) {
        expect(
          replay(dir, setup as never, trace, { restoreBetweenPumps }),
        ).toEqual(trace);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const corpusRoot = resolve(import.meta.dir, '../../../corpus');
const corpusTraceCases = [
  ...new Bun.Glob('**/case.toml').scanSync({ cwd: corpusRoot }),
]
  .sort()
  .flatMap(path => {
    const setup = Bun.TOML.parse(
      readFileSync(resolve(corpusRoot, path), 'utf8'),
    ) as {
      kind: string;
    };
    return setup.kind === 'trace' ? [{ path, setup }] : [];
  });

test('debug pause comparisons discover the corpus Trace Cases', () => {
  expect(corpusTraceCases.length).toBeGreaterThan(100);
});

for (const { path, setup } of corpusTraceCases) {
  for (const restoreBetweenPumps of [false, true]) {
    const mode = restoreBetweenPumps ? 'save/restore' : 'ordinary';
    // The 64 MiB Persistent State case is expensive to restore. Give each
    // case/mode its own budget, rather than timing the entire corpus as one test.
    test(`debug pause preserves ${path} (${mode} replay)`, () => {
      const dir = resolve(corpusRoot, path, '..');
      const trace = readFileSync(resolve(dir, 'case.trace'), 'utf8').split(
        '\n',
      );
      let pauses = 0;
      const breaks = Array.from({ length: 4096 }, (_, pc) => ({ pc }));
      const expected = replay(dir, setup as never, trace);
      const actual = replay(dir, setup as never, trace, {
        restoreBetweenPumps,
        configureDebug(group) {
          const debug = group.debug();
          debug.breakAt(breaks);
          debug.pauseOn({ error: true, limitFault: true });
          debug.paused = pause => {
            if (pause.reason === 'error' || pause.reason === 'limitFault') {
              debug.snapshot();
            }
            pauses++;
          };
        },
      });
      expect(actual).toEqual(expected);
      if (
        expected.some(
          line => line.startsWith('seg ') && / fuel=[1-9]/.test(line),
        )
      ) {
        expect(pauses).toBeGreaterThan(0);
      }
    }, 60_000);
  }
}

test('pause callbacks cannot reenter the retained Pump and paused time excludes execution', async () => {
  const group = newGroup({ name: 'g' });
  const s = group.load({ name: 's', source });
  const debug = group.debug();
  debug.breakAt([instruction(4)]);
  debug.paused = () => {
    expect(() => debug.resume()).toThrow('reentrant');
  };
  s.deliver({ name: 'go' });
  group.pump(0n);
  const before = debug.pausedTime();
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(debug.pausedTime()).toBeGreaterThan(before);
  debug.resume();
  const after = debug.pausedTime();
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(debug.pausedTime()).toBe(after);
});

test('a throwing pause observer leaves a recoverable pause', () => {
  const group = newGroup({ name: 'g' });
  const s = group.load({ name: 's', source });
  const debug = group.debug();
  debug.breakAt([instruction(4)]);
  debug.paused = () => {
    throw new Error('observer');
  };
  s.deliver({ name: 'go' });
  expect(() => group.pump(0n)).toThrow('observer');
  expect(debug.snapshot().scripts[0]!.vars[0]![1].equals(num(1))).toBe(true);
  debug.paused = null;
  expect(debug.resume().state).toBe('idle');
});

test('replay lands in the executing Run when Scripts share a PC, including a Stop targeting another Script', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'northtalk-debug-runs-'));
  try {
    writeFileSync(resolve(dir, 's.talk'), source);
    for (const executing of ['s', 't']) {
      const trace: string[] = [];
      const group = newGroup({ name: 'g', trace: line => trace.push(line) });
      const t = group.load({ name: 't', source });
      const s = group.load({ name: 's', source });
      t.deliver({ name: 'go' });
      s.deliver({ name: 'go' });
      group.debug().landAt(5, { pc: instruction(4).pc, script: executing });
      group.pump(0n);
      s.stop('early');
      group.debug().resume();
      const setup = {
        scripts: [
          { name: 't', source: 's.talk' },
          { name: 's', source: 's.talk' },
        ],
      };
      expect(replay(dir, setup as never, trace)).toEqual(trace);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fault during Handler selection pauses before a Pump cap can preempt it', () => {
  const run = (debugging: boolean) => {
    const trace: string[] = [];
    const group = newGroup({ name: 'g', trace: line => trace.push(line) });
    const s = group.load({
      name: 's',
      source: 'on go x, queued\n wait 1 s\n return x\nend',
      limits: { persistentState: 251 },
    });
    s.deliver({ name: 'go', args: [num(1)] });
    s.deliver({ name: 'go', args: [num(2)] });
    const debug = group.debug();
    if (debugging) {
      debug.pauseOn({ limitFault: true });
    }
    let result = group.pump(0n, { fuelCap: 16 });
    if (debugging) {
      expect(debug.current?.reason).toBe('limitFault');
      expect(debug.current?.run).toBe('s/r2');
      expect(() => group.save()).toThrow();
      result = debug.resume();
    }
    expect(result.state).toBe('idle');
    return { result, trace };
  };
  expect(run(true)).toEqual(run(false));
});

test('step into and out follow a foreign Function Value into its Home Script', () => {
  const group = newGroup({ name: 'g' });
  const home = group.load({
    name: 'home',
    source: 'function f n\n return n * 2\nend f\non exported\n return f\nend',
  });
  home.deliver({ name: 'exported' });
  const report = group.pump(0n).reports.find(r => r.kind === 'run end');
  if (!report || report.kind !== 'run end' || !report.result) {
    throw new Error('No Function Value');
  }
  const source = 'on go f\n f(7) and wait\n return it\nend';
  const caller = group.load({ name: 'caller', source });
  const unit = compileSource(source, { name: 'caller' }).unit!;
  const debug = group.debug();
  debug.breakAt([
    { unit: 'caller', pc: unit.code.findIndex(i => i.line === 2) },
  ]);
  caller.deliver({ name: 'go', args: [report.result] });
  group.pump(0n);
  debug.clearBreaks();
  debug.step();
  expect(debug.current?.script).toBe('home');
  expect(debug.current?.handler).toBe('f');
  debug.stepOut();
  expect(debug.current?.script).toBe('caller');
  expect(debug.current?.line).toBe(3);
  debug.resume();
});

test('a Host Function call with wrong arity breaks before its entry Error', () => {
  const group = newGroup({ name: 'g' });
  const home = group.load({
    name: 'home',
    source: 'function f n\n return n\nend f\non exported\n return f\nend',
  });
  home.deliver({ name: 'exported' });
  const report = group.pump(0n).reports.find(r => r.kind === 'run end');
  if (!report || report.kind !== 'run end' || !report.result) {
    throw new Error('No Function Value');
  }
  const debug = group.debug();
  debug.pauseOn({ error: true });
  group.call(report.result, []);
  group.pump(0n);
  expect(debug.current?.error?.get('code').asText()).toBe('wrong arity');
  expect(debug.snapshot().scripts[0]!.runs[0]!.frames.length).toBe(1);
  expect(debug.resume().reports).toContainEqual(
    expect.objectContaining({ outcome: 'errored', fuel: 0 }),
  );
});
