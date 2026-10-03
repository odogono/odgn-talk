import { describe, expect, test } from 'bun:test';
import { newGroup, num, restore } from '../src/index';

const watcher =
  'on watch\n  wait for\n    when ping n where n > 0 then\n      return n\n  end wait\nend watch\non ping n\nend ping';

describe('wait-for event-test Fuel', () => {
  test('a failed test contributes its 7 Fuel to the receiving Pump', () => {
    const group = newGroup({ name: 'g' });
    const script = group.load({ name: 's', source: watcher });
    script.deliver({ name: 'watch' });
    group.pump(0n);
    const before = script.counters().fuelTotal;

    script.deliver({ name: 'ping', args: [num(-1)] });
    const result = group.pump(0n);
    const handlerFuel = result.reports.find(r => r.kind === 'run end')!.fuel;

    expect(script.counters().fuelTotal - before).toBe(handlerFuel + 7);
    expect(result.fuelUsed).toBe(handlerFuel + 7);
  });

  test('a waiting Run spends its receiving Script slice and carries observation debt', () => {
    const group = newGroup({ name: 'g' });
    const script = group.load({ name: 's', source: watcher });
    const other = group.load({
      name: 'other',
      source: 'on go\n  return 1\nend go',
    });
    script.deliver({ name: 'watch' });
    group.pump(0n);
    const before = script.counters().fuelTotal;

    script.deliver({ name: 'ping', args: [num(-1)] });
    other.deliver({ name: 'go' });
    const observed = group.pump(0n, { fuelSlice: 4 });
    expect(script.counters().fuelTotal - before).toBe(7);
    expect(other.counters().fuelTotal).toBeGreaterThan(0);
    expect(observed.fuelUsed).toBe(7 + other.counters().fuelTotal);
    expect(observed.state).toBe('sliced');

    // Observation overran this Script's slice by 3. Each following Pump pays
    // its debt before permitting either dispatch or another Run to proceed.
    group.pump(0n, { fuelSlice: 1 });
    expect(script.counters().fuelTotal - before).toBe(7);
    expect(group.pump(0n, { fuelSlice: 2 })).toMatchObject({
      state: 'sliced',
      fuelUsed: 2, // the other Script finishes; this Script still pays debt
    });
    expect(group.pump(0n)).toMatchObject({ state: 'idle', fuelUsed: 7 });
    expect(script.counters().fuelTotal - before).toBe(14);
  });

  test('observation spends the Group cap before dispatch or another Script turn', () => {
    const trace: string[] = [];
    const group = newGroup({ name: 'g', trace: line => trace.push(line) });
    const script = group.load({ name: 's', source: watcher });
    const other = group.load({
      name: 'other',
      source: 'on go\n  return 1\nend go',
    });
    script.deliver({ name: 'watch' });
    group.pump(0n);
    trace.length = 0;

    script.deliver({ name: 'ping', args: [num(-1)] });
    other.deliver({ name: 'go' });
    expect(group.pump(0n, { fuelCap: 1 })).toMatchObject({
      state: 'sliced',
      fuelUsed: 7,
      reports: [],
    });
    expect(trace).toContain(
      'preempt s/r2 start delivery=d2 handler=ping clause=1 by=cap fuel=0 alloc=0',
    );
    expect(other.counters()).toMatchObject({
      fuelTotal: 0,
      runs: 0,
      mailboxLen: 1,
    });
    expect(group.pump(0n)).toMatchObject({ state: 'idle', fuelUsed: 14 });
  });

  test('all waiters observe atomically before a spent cap stops dispatch', () => {
    const group = newGroup({ name: 'g' });
    const script = group.load({
      name: 's',
      source:
        'on watch id\n  wait for\n    when ping n where n > 0 then\n      return id\n  end wait\nend watch\non ping n\n  return "handler"\nend ping',
    });
    script.deliver({ name: 'watch', args: [num(1)] });
    script.deliver({ name: 'watch', args: [num(2)] });
    group.pump(0n);
    const before = script.counters().fuelTotal;

    script.deliver({ name: 'ping', args: [num(1)] });
    expect(group.pump(0n, { fuelCap: 1 })).toMatchObject({
      state: 'sliced',
      fuelUsed: 24,
      reports: [],
    });
    expect(script.counters().fuelTotal - before).toBe(24);
    expect(group.inspect().scripts[0]!.runs).toEqual([
      { id: 's/r1', status: 'ready', handler: 'watch' },
      { id: 's/r2', status: 'ready', handler: 'watch' },
      { id: 's/r3', status: 'preempted', handler: 'ping' },
    ]);
    const completed = group.pump(0n).reports.filter(r => r.kind === 'run end');
    expect(completed.map(r => r.run)).toEqual(['s/r3', 's/r1', 's/r2']);
    expect(completed.map(r => r.result?.toString())).toEqual([
      '"handler"',
      '1',
      '2',
    ]);
  });

  test('failed branches are charged before the first matching branch', () => {
    const group = newGroup({ name: 'g' });
    const script = group.load({
      name: 's',
      source:
        'on watch\n  wait for\n    when ping n where n < 0 then\n      return "negative"\n    when ping n where n > 0 then\n      return "positive"\n    when ping n where n > 0 then\n      return "later"\n  end wait\nend watch\non ping n\nend ping',
    });
    script.deliver({ name: 'watch' });
    group.pump(0n);

    script.deliver({ name: 'ping', args: [num(1)] });
    expect(group.pump(0n, { fuelCap: 1 }).fuelUsed).toBe(7 + 12);
    const finished = group
      .pump(0n)
      .reports.find(r => r.kind === 'run end' && r.run === 's/r1');
    expect(finished).toMatchObject({ kind: 'run end', outcome: 'completed' });
    expect(finished?.kind === 'run end' && finished.result?.toString()).toBe(
      '"positive"',
    );
  });

  test.each([
    { filter: 'name', from: '', name: 'other', args: [num(1)], fuel: 0 },
    { filter: 'arity', from: '', name: 'ping', args: [], fuel: 0 },
    {
      filter: 'sender',
      from: ' from sender',
      name: 'ping',
      args: [num(1)],
      fuel: 7,
    },
  ])(
    '$filter filtering skips the event-test body without Fuel',
    ({ from, name, args, fuel }) => {
      const group = newGroup({ name: 'g' });
      group.load({ name: 'sender', source: 'on go\nend go' });
      const script = group.load({
        name: 's',
        source: `on watch\n  wait for\n    when ping n${from} where n > 0 then\n      return n\n  end wait\nend watch\non ping n\nend ping`,
      });
      script.deliver({ name: 'watch' });
      group.pump(0n);
      const before = script.counters().fuelTotal;

      script.deliver({ name, args: [...args] });
      expect(group.pump(0n).fuelUsed).toBe(fuel);
      expect(script.counters().fuelTotal - before).toBe(fuel);
      expect(group.inspect().scripts[1]!.runs).toEqual([
        {
          id: 's/r1',
          status: 'suspended',
          handler: 'watch',
          wait: 'wait-for-any',
        },
      ]);
    },
  );

  test('an ordinary message with no Handler ends unhandled after observation spends the cap', () => {
    const group = newGroup({ name: 'g' });
    const script = group.load({
      name: 's',
      source: watcher.replace('\non ping n\nend ping', ''),
    });
    script.deliver({ name: 'watch' });
    group.pump(0n);

    const delivery = script.deliver({ name: 'ping', args: [num(1)] });
    const result = group.pump(0n, { fuelCap: 1 });
    expect(result).toMatchObject({ state: 'sliced', fuelUsed: 12 });
    expect(result.reports).toContainEqual(
      expect.objectContaining({
        kind: 'run end',
        run: 's/r2',
        outcome: 'unhandled',
        fuel: 0,
      }),
    );
    expect(result.reports).toContainEqual(
      expect.objectContaining({ kind: 'unhandled', delivery }),
    );
    expect(group.inspect().scripts[0]!.runs).toEqual([
      { id: 's/r1', status: 'ready', handler: 'watch' },
    ]);
    expect(group.pump(0n).reports).toContainEqual(
      expect.objectContaining({
        kind: 'run end',
        run: 's/r1',
        outcome: 'completed',
      }),
    );
  });

  test('an internal error message charges observation without an incoming Run or report', () => {
    const group = newGroup({ name: 'g' });
    const script = group.load({
      name: 's',
      source:
        'on watch\n  wait for\n    when error e where true then\n      return e\n  end wait\nend watch\non fail\n  throw "broken"\nend fail',
    });
    script.deliver({ name: 'watch' });
    group.pump(0n);
    script.deliver({ name: 'fail' });
    group.pump(0n, { fuelCap: 5 });
    expect(group.pump(0n, { fuelCap: 1 }).reports).toContainEqual(
      expect.objectContaining({
        kind: 'run end',
        run: 's/r2',
        outcome: 'errored',
      }),
    );
    const before = script.counters();
    expect(
      group.inspect().scripts[0]!.mailbox.map(d => d.message.name),
    ).toEqual(['error']);

    const result = group.pump(0n, { fuelCap: 1 });
    expect(result).toMatchObject({
      state: 'sliced',
      fuelUsed: 9,
      reports: [],
    });
    expect(script.counters()).toMatchObject({
      runs: before.runs,
      fuelTotal: before.fuelTotal + 9,
      mailboxLen: 0,
    });
    expect(group.inspect().scripts[0]!.runs).toEqual([
      { id: 's/r1', status: 'ready', handler: 'watch' },
    ]);
  });

  test('uncapped event tests fault an over-limit waiting Run only after it resumes', () => {
    const trace: string[] = [];
    const group = newGroup({ name: 'g', trace: line => trace.push(line) });
    const script = group.load({ name: 's', source: watcher });
    script.deliver({ name: 'watch', limits: { fuelPerRun: 14 } });
    group.pump(0n);

    script.deliver({ name: 'ping', args: [num(-1)] });
    expect(group.pump(0n, { fuelCap: 1 }).fuelUsed).toBe(7);
    expect(script.counters().faults).toBe(0);
    group.pump(0n);
    expect(script.counters().faults).toBe(0);

    script.deliver({ name: 'ping', args: [num(1)] });
    expect(group.pump(0n, { fuelCap: 1 }).fuelUsed).toBe(12);
    expect(script.counters().faults).toBe(0);
    const resumed = group.pump(0n);
    expect(resumed.reports).toContainEqual(
      expect.objectContaining({
        kind: 'run end',
        run: 's/r1',
        outcome: 'limit fault',
        limit: 'fuel',
        fuel: 14 + 7 + 12,
      }),
    );
    expect(trace.find(line => line.startsWith('fault s/r1 '))).toContain(
      'pos=2:3',
    );
    expect(resumed.fuelUsed).toBe(7);
  });

  test('full restore preserves observation debt, awakened waiters and replay order', () => {
    const originalTrace: string[] = [];
    const group = newGroup({
      name: 'g',
      trace: line => originalTrace.push(line),
    });
    const script = group.load({ name: 's', source: watcher });
    script.deliver({ name: 'watch' });
    group.pump(0n);
    script.deliver({ name: 'ping', args: [num(1)] });
    expect(group.pump(0n, { fuelSlice: 4 }).fuelUsed).toBe(12);
    const restoredTrace: string[] = [];
    const { group: copy } = restore(group.save(), {
      name: 'copy',
      trace: line => restoredTrace.push(line),
      libraries: [],
      grants: () => undefined,
      resolve: () => undefined,
      onMismatch: 'reject',
    });

    originalTrace.length = 0;
    restoredTrace.length = 0;
    for (let i = 0; i < 2; i++) {
      const result = group.pump(0n, { fuelSlice: 4 });
      expect(result).toMatchObject({ state: 'sliced', fuelUsed: 0 });
      expect(copy.pump(0n, { fuelSlice: 4 })).toEqual(result);
    }
    expect(copy.pump(0n)).toEqual(group.pump(0n));
    expect(restoredTrace).toEqual(originalTrace);
    expect(copy.script('s')!.counters()).toEqual(script.counters());
  });
});
