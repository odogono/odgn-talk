import { expect, test } from 'bun:test';
import { DeferredCaseError, replay } from '../tools/core/trace-case';
import {
  clockCapability,
  timerCapability,
  compileLibrary,
  newGroup,
  restore,
  HostError,
  LoadError,
  ScriptError,
  instant,
  parseInstant,
  num,
  type Costs,
  type TimerImpl,
  type Call,
  type Value,
} from '../src/index';

const now = parseInstant('2026-10-02T10:00:00.123456789Z');
const timerCosts = { schedule: { fuel: 10, alloc: 3 }, cancel: { fuel: 2 } };
const noTimers: TimerImpl = { schedule: () => {}, cancel: () => {} };
const codes = (work: () => unknown) => {
  try {
    work();
    return [];
  } catch (error) {
    if (!(error instanceof LoadError)) {
      throw error;
    }
    return error.diagnostics.map(d => d.code);
  }
};
const hostCode = (work: () => unknown) => {
  try {
    work();
    return null;
  } catch (error) {
    if (!(error instanceof HostError)) {
      throw error;
    }
    return error.code;
  }
};

test('clock.now returns each Pump Clock through an ordinary Grant and costs its declaration', () => {
  const lines: string[] = [];
  const g = newGroup({ name: 'g', trace: line => lines.push(line) });
  const s = g.load({
    name: 's',
    source: 'on go\n  ask stamp to now\n  return it\nend go',
    grants: {
      stamp: clockCapability({ now: { fuel: 7, alloc: 2 } }).grant(
        'all',
        undefined,
      ),
    },
  });
  s.deliver({ name: 'go' });
  const first = g.pump(now).reports.find(r => r.kind === 'run end')!;
  expect(first.result?.asInstant()).toBe(now);
  s.deliver({ name: 'go' });
  const later = g.pump(now + 1n).reports.find(r => r.kind === 'run end')!;
  expect(later.result?.asInstant()).toBe(now + 1n);
  const cheap = newGroup({ name: 'cheap' });
  cheap
    .load({
      name: 's',
      source: 'on go\n  ask stamp to now\n  return it\nend go',
      grants: {
        stamp: clockCapability({ now: { fuel: 0 } }).grant('all', undefined),
      },
    })
    .deliver({ name: 'go' });
  const base = cheap.pump(now).reports.find(r => r.kind === 'run end')!;
  expect(first.fuel - base.fuel).toBe(7);
  expect(first.alloc - base.alloc).toBe(2);
  expect(lines.filter(line => line.startsWith('call '))).toEqual([
    'call s/r1.c1 op=stamp.now args=[] result=2026-10-02T10:00:00.123456789Z',
    'call s/r2.c1 op=stamp.now args=[] result=2026-10-02T10:00:00.12345679Z',
  ]);
});

test('clock and timer have fixed modes, arities and literal Shapes at load', () => {
  const g = newGroup({ name: 'g' });
  const grants = {
    clock: clockCapability({ now: { fuel: 0 } }).grant('all', undefined),
    timer: timerCapability(noTimers, timerCosts).grant('all', undefined),
  };
  expect(
    codes(() =>
      g.load({ name: 'missing', source: 'on go\n  ask clock to now\nend go' }),
    ),
  ).toEqual(['unknown operation']);
  expect(
    codes(() =>
      g.load({
        name: 'mode',
        source: 'on go\n  tell clock to now\nend go',
        grants,
      }),
    ),
  ).toEqual(['wrong mode']);
  expect(
    codes(() =>
      g.load({
        name: 'count',
        source: 'on go\n  ask clock to now 1\nend go',
        grants,
      }),
    ),
  ).toEqual(['wrong argument count']);
  expect(
    codes(() =>
      g.load({
        name: 'timer-mode',
        source: 'on go\n  ask timer to cancel "later"\nend go',
        grants,
      }),
    ),
  ).toEqual(['wrong mode']);
  expect(
    codes(() =>
      g.load({
        name: 'timer-shape',
        source: 'on go\n  tell timer to cancel 1\nend go',
        grants,
      }),
    ),
  ).toEqual(['wrong argument']);
  expect(
    codes(() =>
      g.load({
        name: 'timer-count',
        source: 'on go\n  tell timer to schedule "later", "tick", []\nend go',
        grants,
      }),
    ),
  ).toEqual(['wrong argument count']);
  expect([...grants.timer.capability.operations.keys()]).toEqual([
    'cancel',
    'schedule',
  ]);
  expect(
    grants.timer.capability.operations.get('schedule')!.args,
  ).toMatchObject([
    { k: 'kind', kind: 'text' },
    { k: 'kind', kind: 'instant' },
    { k: 'kind', kind: 'text' },
    { k: 'list', of: { k: 'any' } },
  ]);
});

test('Standard factories reject missing or invalid costs and snapshot valid costs', () => {
  expect(() => clockCapability({})).toThrow(HostError);
  expect(
    hostCode(() => timerCapability(noTimers, { schedule: { fuel: 1 } })),
  ).toBe('invalid value');
  for (const cost of [
    { fuel: -1 },
    { fuel: 0.5 },
    { fuel: Number.NaN },
    { fuel: Infinity },
    { fuel: Number.MAX_SAFE_INTEGER + 1 },
    { fuel: 0, alloc: -1 },
    { fuel: 0, alloc: 0.5 },
  ]) {
    expect(hostCode(() => clockCapability({ now: cost }))).toBe(
      'invalid value',
    );
  }
  expect(
    hostCode(() =>
      clockCapability(Object.create({ now: { fuel: 0 } }) as Costs),
    ),
  ).toBe('invalid value');
  const costs = { now: { fuel: 4 }, extra: { fuel: -1 } };
  const clock = clockCapability(costs);
  costs.now.fuel = 99;
  expect(clock.operations.get('now')!.cost).toEqual({ fuel: 4 });
  expect(hostCode(() => timerCapability({} as TimerImpl, timerCosts))).toBe(
    'invalid value',
  );
});

test('timer forwards Script-scoped names, binding, Clock and unchanged Values to its Host', () => {
  const seen: {
    args: Value;
    at: Value;
    call: Call<unknown>;
    message: string;
    name: string;
  }[] = [];
  const cancelled: { call: Call<unknown>; name: string }[] = [];
  const timers = timerCapability(
    {
      schedule(call, name, at, message, args) {
        seen.push({ call, name, at, message, args });
        call.charge(5);
      },
      cancel(call, name) {
        cancelled.push({ call, name });
      },
    },
    timerCosts,
  );
  const binding = { tenant: 'north' };
  const g = newGroup({ name: 'g' });
  const script =
    'on go at\n  tell timers to schedule "wake", at, "tick", [1, "hello"]\n  tell timers to cancel "unknown"\nend go';
  for (const name of ['a', 'b']) {
    g.load({
      name,
      source: script,
      grants: { timers: timers.grant('all', binding) },
    }).deliver({ name: 'go', args: [instant(now)] });
  }
  const reports = g.pump(now).reports.filter(r => r.kind === 'run end');
  expect(reports.map(r => r.outcome)).toEqual(['completed', 'completed']);
  expect(
    seen.map(s => [
      s.name,
      s.message,
      s.at.asInstant(),
      s.args.toString(),
      s.call.scriptName,
      s.call.id,
      s.call.now,
    ]),
  ).toEqual([
    ['wake', 'tick', now, '[1, "hello"]', 'a', 'a/r1.c1', now],
    ['wake', 'tick', now, '[1, "hello"]', 'b', 'b/r1.c1', now],
  ]);
  expect(seen.every(s => s.call.binding === binding)).toBe(true);
  expect(cancelled.map(s => [s.name, s.call.id])).toEqual([
    ['unknown', 'a/r1.c2'],
    ['unknown', 'b/r1.c2'],
  ]);
  expect(() => seen[0]!.call.charge(1)).toThrow(HostError);
});

test('a dynamic timer Shape mismatch never reaches the Host or charges its cost', () => {
  let calls = 0;
  const timers = timerCapability(
    {
      ...noTimers,
      cancel: () => {
        calls++;
      },
    },
    {
      schedule: timerCosts.schedule,
      cancel: { fuel: Number.MAX_SAFE_INTEGER },
    },
  );
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source: 'on go name\n  tell timer to cancel name\nend go',
    grants: { timer: timers.grant('all', undefined) },
  });
  s.deliver({ name: 'go', args: [num(1)] });
  const report = g.pump(now).reports.find(r => r.kind === 'run end')!;
  expect(calls).toBe(0);
  expect(report.error?.code).toBe('wrong kind');
  expect(report.error?.data.get('operation').toString()).toBe('"cancel"');
  expect(report.error?.data.get('argument').toString()).toBe('1');
});

test('standard Trace setup refuses duplicate declarations and Clock Stubs', () => {
  const clock = { capability: 'clock', costs: { now: { fuel: 0 } } };
  expect(hostCode(() => replay('.', { standard: [clock, clock] }, []))).toBe(
    'invalid value',
  );
  expect(() =>
    replay('.', { standard: [clock] }, [
      '> stub clock.now value=2026-10-02T10:00:00Z',
    ]),
  ).toThrow('clock.now uses the Pump Clock, not a Stub');
  expect(() =>
    replay('.', { standard: [{ capability: 'locale', costs: {} }] }, []),
  ).toThrow('Invalid or missing cost for compare');
  expect(() =>
    replay('.', { standard: [{ capability: 'unknown', costs: {} }] }, []),
  ).toThrow(DeferredCaseError);
});

test('timer Host failures remain host error and no custom Script codes are declared', () => {
  const timers = timerCapability(
    {
      ...noTimers,
      cancel: () => {
        throw new ScriptError('refused', 'no');
      },
    },
    timerCosts,
  );
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source: 'on go\n  tell timer to cancel "wake"\nend go',
    grants: { timer: timers.grant('all', undefined) },
  }).deliver({ name: 'go' });
  const report = g.pump(now).reports.find(r => r.kind === 'run end')!;
  expect(report.error?.code).toBe('host error');
  expect(timers.operations.get('cancel')!.errors).toEqual([]);
});

test('Clock Library needs and trimmed Grants survive Restore with new timer Host implementations', () => {
  const clock = clockCapability({ now: { fuel: 1 } });
  const helper = compileLibrary(
    {
      name: 'helper',
      version: '1',
      source: 'function stamp\n  ask time to now\n  return it\nend stamp',
    },
    [],
    { time: { now: { mode: 'immediate', args: [] } } },
  );
  const original = newGroup({ name: 'g' });
  original.addLibrary(helper);
  original.load({
    name: 's',
    source:
      'use stamp from helper\non go\n  tell timer to cancel "wake"\n  return stamp()\nend go',
    grantsAsUsed: true,
    grants: {
      time: clock.grant('all', undefined),
      timer: timerCapability(noTimers, timerCosts).grant('all', undefined),
    },
  });
  const cancelled: string[] = [];
  const rebound = timerCapability(
    {
      ...noTimers,
      cancel: (call, name) => cancelled.push(`${call.scriptName}:${name}`),
    },
    timerCosts,
  );
  const { group: copy } = restore(original.save(), {
    name: 'copy',
    libraries: [helper],
    grants: (_script, name) =>
      name === 'time'
        ? clock.grant('all', undefined)
        : rebound.grant('all', undefined),
    resolve: () => undefined,
    onMismatch: 'reject',
  });
  expect(copy.fingerprint()).toEqual(original.fingerprint());
  expect(copy.script('s')!.grants()).toEqual({
    time: ['now'],
    timer: ['cancel'],
  });
  copy.script('s')!.deliver({ name: 'go' });
  const report = copy.pump(now).reports.find(r => r.kind === 'run end')!;
  expect(report.result?.asInstant()).toBe(now);
  expect(cancelled).toEqual(['s:wake']);
});

test('timer Host implementations retain their method receiver', () => {
  const impl = {
    names: [] as string[],
    schedule: noTimers.schedule,
    cancel(_call: Call<unknown>, name: string) {
      this.names.push(name);
    },
  };
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source: 'on go\n  tell timer to cancel "wake"\nend go',
    grants: {
      timer: timerCapability(impl, timerCosts).grant('all', undefined),
    },
  }).deliver({ name: 'go' });
  g.pump(now);
  expect(impl.names).toEqual(['wake']);
});
