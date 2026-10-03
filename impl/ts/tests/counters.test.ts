import { describe, expect, test } from 'bun:test';
import {
  newGroup,
  restore,
  compileLibrary,
  defineCapability,
  nothing,
  shape,
  num,
  type Counters,
} from '../src/index';

const restoreOptions = {
  name: 'copy',
  libraries: [],
  grants: () => undefined,
  resolve: () => undefined,
  onMismatch: 'reject' as const,
};

const totals = (lines: string[]) => {
  let fuelTotal = 0;
  let allocTotal = 0;
  for (const line of lines.filter(line => line.startsWith('run '))) {
    fuelTotal += Number(/ fuel=(\d+)/.exec(line)![1]);
    allocTotal += Number(/ alloc=(\d+)/.exec(line)![1]);
  }
  return { fuelTotal, allocTotal };
};

describe('Script counters', () => {
  test('initializers are free and snapshots cannot change Core state', () => {
    const g = newGroup({ name: 'g' });
    const s = g.load({ name: 's', source: 'script variable xs = [1, 2, 3]' });
    const before: Counters = s.counters();
    expect(before).toEqual({
      fuelTotal: 0,
      allocTotal: 0,
      runs: 0,
      faults: 0,
      persistentState: 88,
      mailboxLen: 0,
    });
    before.fuelTotal = 999;
    expect(s.counters().fuelTotal).toBe(0);
  });

  test('reads do not drain inputs and mailboxes exclude preempted Runs', () => {
    const g = newGroup({ name: 'g' });
    const s = g.load({
      name: 's',
      source: 'on spin\n  repeat forever\n  end repeat\nend spin',
    });
    const before = s.counters();
    s.deliver({ name: 'spin' });
    s.deliver({ name: 'spin' });
    expect(s.counters()).toEqual(before);
    g.pump(0n, { fuelCap: 1 });
    expect(s.counters()).toMatchObject({ runs: 1, mailboxLen: 1, faults: 0 });
    expect(s.counters().fuelTotal).toBeGreaterThan(0);
  });

  test('completed, errored and unhandled Runs retain charged Fuel and allocation', () => {
    const trace: string[] = [];
    const g = newGroup({ name: 'g', trace: line => trace.push(line) });
    const s = g.load({
      name: 's',
      source:
        'on good\n  return [1, 2]\nend good\non bad\n  throw "broken"\nend bad',
    });
    for (const name of ['good', 'bad', 'absent']) {
      s.deliver({ name });
    }
    g.pump(0n);
    expect(s.counters()).toMatchObject({
      ...totals(trace),
      runs: 3,
      faults: 0,
      mailboxLen: 0,
    });
    expect(s.counters().allocTotal).toBeGreaterThan(0);
  });

  test('Limit Fault rollback retains all spent work without charging refused work', () => {
    const trace: string[] = [];
    const g = newGroup({ name: 'g', trace: line => trace.push(line) });
    const s = g.load({
      name: 's',
      source:
        'script variable n = 0\non spin\n  put 1 into n\n  repeat forever\n  end repeat\nend spin',
      limits: { fuelPerRun: 30 },
    });
    s.deliver({ name: 'spin' });
    const pump = g.pump(0n);
    expect(s.counters()).toMatchObject({
      ...totals(trace),
      fuelTotal: pump.fuelUsed,
      runs: 1,
      faults: 1,
      persistentState: 16,
    });
    expect(g.inspect().scripts[0]!.vars[0]![1].toString()).toBe('0');
  });

  test('Stop retains live Run costs exactly once and clears live state', () => {
    const g = newGroup({ name: 'g' });
    const s = g.load({ name: 's', source: 'on go\n  wait 1 s\nend go' });
    s.deliver({ name: 'go' });
    g.pump(0n);
    const before = s.counters();
    expect(before).toMatchObject({ runs: 1, faults: 0, mailboxLen: 0 });
    expect(before.persistentState).toBeGreaterThan(0);
    s.stop('done');
    g.pump(0n);
    expect(s.counters()).toEqual({ ...before, persistentState: 0 });
    s.stop('again');
    g.pump(0n);
    expect(s.counters()).toEqual({ ...before, persistentState: 0 });
  });

  test('queued cancellation does not start a Run; cleanup failures count as cancellation', () => {
    const trace: string[] = [];
    const g = newGroup({ name: 'g', trace: line => trace.push(line) });
    const s = g.load({
      name: 's',
      source:
        'on go\n  try\n    wait 1 s\n  finally\n    repeat forever\n    end repeat\n  end try\nend go',
      limits: { cleanupBudget: 8 },
    });
    g.cancelDelivery(s.deliver({ name: 'go' }));
    g.pump(0n);
    expect(s.counters().runs).toBe(0);
    s.deliver({ name: 'go' });
    g.pump(0n);
    s.cancelRun('s/r1');
    expect(g.pump(0n).reports).toMatchObject([
      { outcome: 'cancelled', cleanupFailed: { limit: 'cleanup' } },
    ]);
    expect(s.counters()).toMatchObject({
      ...totals(trace),
      runs: 1,
      faults: 0,
    });
  });

  test('full restore keeps completed totals, faults and live costs without double counting', () => {
    const g = newGroup({ name: 'g' });
    const s = g.load({
      name: 's',
      source:
        'on go\n  wait 1 s\n  return [1, 2]\nend go\non spin\n  repeat forever\n  end repeat\nend spin',
      limits: { fuelPerRun: 40 },
    });
    s.deliver({ name: 'spin' });
    s.deliver({ name: 'go' });
    g.pump(0n);
    const { group: copy } = restore(g.save(), restoreOptions);
    expect(copy.script('s')!.counters()).toEqual(s.counters());
    g.pump(1_000_000_000n);
    copy.pump(1_000_000_000n);
    expect(copy.script('s')!.counters()).toEqual(s.counters());
    expect(s.counters()).toMatchObject({ runs: 2, faults: 1 });
  });

  test('variables-only restore keeps costs of the Runs it discards', () => {
    const g = newGroup({ name: 'g' });
    g.addLibrary(
      compileLibrary({
        name: 'unused',
        version: '1',
        source: 'function label\n  return 1\nend label',
      }),
    );
    const s = g.load({ name: 's', source: 'on go\n  wait 1 s\nend go' });
    s.deliver({ name: 'go' });
    g.pump(0n);
    const before = s.counters();
    const { group: copy, result } = restore(g.save(), {
      ...restoreOptions,
      onMismatch: 'variables only',
    });
    expect(result.variablesOnly).toBe(true);
    expect(copy.script('s')!.counters()).toEqual({
      ...before,
      persistentState: 0,
    });
    const { group: again } = restore(copy.save(), restoreOptions);
    expect(again.script('s')!.counters()).toEqual(copy.script('s')!.counters());
  });

  test('Reload and Extend preserve lifetime totals while excluding initializer costs', () => {
    const g = newGroup({ name: 'g' });
    const s = g.load({ name: 's', source: 'on go\n  wait 1 s\nend go' });
    s.deliver({ name: 'go' });
    g.pump(0n);
    const before = s.counters();
    s.reload(
      'script variable n = 1\non go\n  return n\nend go',
      'reset variables',
    );
    expect(s.counters()).toEqual({ ...before, persistentState: 16 });
    s.extend('script variable xs = [1, 2]');
    expect(s.counters()).toEqual({ ...before, persistentState: 80 });
    s.deliver({ name: 'go' });
    g.pump(0n);
    expect(s.counters().runs).toBe(2);
    expect(s.counters().fuelTotal).toBeGreaterThan(before.fuelTotal);
  });

  test('parked Runs have already started and retain their dispatch cost', () => {
    const trace: string[] = [];
    const g = newGroup({ name: 'g', trace: line => trace.push(line) });
    const s = g.load({
      name: 's',
      source: 'on go n, queued\n  wait 1 s\n  return n\nend go',
    });
    s.deliver({ name: 'go', args: [num(1)] });
    s.deliver({ name: 'go', args: [num(2)] });
    const first = g.pump(0n);
    expect(s.counters()).toMatchObject({
      fuelTotal: first.fuelUsed,
      runs: 2,
      mailboxLen: 0,
    });
    expect(g.inspect().scripts[0]!.runs.map(r => r.status)).toEqual([
      'suspended',
      'parked',
    ]);
    g.pump(1_000_000_000n);
    g.pump(2_000_000_000n);
    expect(s.counters()).toMatchObject({
      ...totals(trace),
      runs: 2,
      faults: 0,
    });
  });

  test('event tests charge the waiting Run before it resumes', () => {
    const trace: string[] = [];
    const g = newGroup({ name: 'g', trace: line => trace.push(line) });
    const s = g.load({
      name: 's',
      source:
        'on watch\n  wait for\n    when ping n where n > 0 then\n      return n\n  end wait\nend watch\non ping n\nend ping',
    });
    s.deliver({ name: 'watch' });
    g.pump(0n);
    const before = s.counters();
    s.deliver({ name: 'ping', args: [num(-1)] });
    g.pump(0n);
    const spent = totals(trace);
    // The failed event test's loads, Guard and clause-fail cost 7 Fuel.
    expect(s.counters().fuelTotal).toBe(before.fuelTotal + spent.fuelTotal + 7);
    expect(s.counters().fuelTotal).toBeGreaterThan(
      before.fuelTotal + spent.fuelTotal,
    );
    expect(s.counters().runs).toBe(2);
    s.deliver({ name: 'ping', args: [num(1)] });
    g.pump(0n, { fuelCap: 1 });
    expect(g.inspect().scripts[0]!.runs.some(r => r.status === 'ready')).toBe(
      true,
    );
    const ready = s.counters();
    const { group: copy } = restore(g.save(), restoreOptions);
    expect(copy.script('s')!.counters()).toEqual(ready);
    g.pump(0n);
    expect(s.counters()).toMatchObject({ ...totals(trace), runs: 3 });
  });

  test('Reissue costs are visible while the restored call remains suspended', () => {
    const grant = defineCapability('api', {
      hold: {
        mode: 'suspending',
        cost: { fuel: 1 },
        start: call => call.charge(7),
      },
    }).grant('all', undefined);
    const g = newGroup({ name: 'g' });
    const s = g.load({
      name: 's',
      source: 'on go\n  ask api to hold and wait\nend go',
      grants: { api: grant },
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    const before = s.counters();
    const { group: copy } = restore(g.save(), {
      ...restoreOptions,
      grants: () => grant,
    });
    copy.settle('s/r1.c1', { reissue: true });
    expect(copy.script('s')!.counters()).toEqual(before);
    expect(copy.pump(0n).fuelUsed).toBe(7);
    expect(copy.script('s')!.counters()).toEqual({
      ...before,
      fuelTotal: before.fuelTotal + 7,
    });
  });

  test('Stop queued inside an Operation retains the current crossing Charge', () => {
    const grant = defineCapability('api', {
      ping: {
        mode: 'immediate',
        cost: { fuel: 1 },
        do: call => {
          call.charge(7);
          s.stop('crossing');
          return nothing;
        },
      },
    }).grant('all', undefined);
    const g = newGroup({ name: 'g' });
    const s = g.load({
      name: 's',
      source: 'on go\n  ask api to ping\nend go',
      grants: { api: grant },
    });
    s.deliver({ name: 'go' });
    const pump = g.pump(0n);
    expect(s.counters()).toMatchObject({
      fuelTotal: pump.fuelUsed,
      runs: 1,
      faults: 0,
      persistentState: 0,
    });
    expect(s.counters().fuelTotal).toBeGreaterThan(7);
  });

  test('allocation Limit Faults count once and retain prior allocations', () => {
    const trace: string[] = [];
    const g = newGroup({ name: 'g', trace: line => trace.push(line) });
    const s = g.load({
      name: 's',
      source: 'on grow\n  put [1] into xs\n  put [1, 2, 3] into xs\nend grow',
      limits: { allocPerRun: 50 },
    });
    s.deliver({ name: 'grow' });
    expect(g.pump(0n).reports).toMatchObject([
      { outcome: 'limit fault', limit: 'alloc' },
    ]);
    expect(s.counters()).toMatchObject({
      ...totals(trace),
      runs: 1,
      faults: 1,
    });
    expect(s.counters().allocTotal).toBeGreaterThan(0);
  });

  test('Library replacement retires live costs and keeps lifetime totals', () => {
    const g = newGroup({ name: 'g' });
    g.addLibrary(
      compileLibrary({
        name: 'helper',
        version: '1',
        source: 'function label\n  return 1\nend label',
      }),
    );
    const s = g.load({
      name: 's',
      source:
        'use label from helper\non go\n  put label() into n\n  wait 1 s\nend go',
    });
    s.deliver({ name: 'go' });
    g.pump(0n);
    const before = s.counters();
    g.replaceLibrary(
      compileLibrary({
        name: 'helper',
        version: '2',
        source: 'function label\n  return 2\nend label',
      }),
      'reset variables',
    );
    expect(s.counters()).toEqual({ ...before, persistentState: 0 });
  });

  test('repeated reads leave save bytes, fingerprint and later scheduling unchanged', () => {
    const groups = [newGroup({ name: 'g' }), newGroup({ name: 'g' })];
    for (const g of groups) {
      g.load({ name: 's', source: 'on go\n  wait 1 s\nend go' }).deliver({
        name: 'go',
      });
      g.pump(0n);
    }
    groups[0]!.script('s')!.counters();
    groups[0]!.script('s')!.counters();
    expect(groups[0]!.fingerprint()).toEqual(groups[1]!.fingerprint());
    expect(groups[0]!.save()).toEqual(groups[1]!.save());
    expect(groups[0]!.pump(1_000_000_000n)).toEqual(
      groups[1]!.pump(1_000_000_000n),
    );
  });

  test('Counter reads are worker calls and reject reentry from an Operation', () => {
    const g = newGroup({ name: 'g' });
    const cap = defineCapability('api', {
      ping: {
        mode: 'immediate',
        cost: { fuel: 1 },
        result: shape.nothing,
        do: () => {
          expect(() => s.counters()).toThrow('reentrant call');
          return nothing;
        },
      },
    });
    const s = g.load({
      name: 's',
      source: 'on go\n  ask api to ping\nend go',
      grants: { api: cap.grant('all', undefined) },
    });
    s.deliver({ name: 'go' });
    expect(g.pump(0n).reports).toMatchObject([{ outcome: 'completed' }]);
    expect(s.counters().runs).toBe(1);
  });
});
