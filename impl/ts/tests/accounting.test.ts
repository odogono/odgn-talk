import { defineCapability, nothing } from '../src/index';
import accountingCases from '../../testdata/run-accounting.json';
import { compileLibrary } from '../src/library';
import { expect, test } from 'bun:test';
import { num } from '../src/values';
import { newGroup, restore } from '../src/group';

const options = {
  name: 'g',
  libraries: [],
  grants: () => undefined,
  resolve: () => undefined,
  onMismatch: 'reject' as const,
};

test('accounting records dispatch, exact terminal Fuel and an empty causal family', () => {
  const g = newGroup({ name: 'g' });
  const s = g.load({ name: 's', source: 'on go\n return 3\nend go' });
  s.deliver({ name: 'go' });
  const { reports } = g.pump(0n);
  expect(reports.map(r => r.kind)).toEqual([
    'run started',
    'run end',
    'run accounting',
    'causal work',
  ]);
  expect(reports[0]).toMatchObject({
    script: 's',
    run: 's/r1',
    rootDelivery: 'd1',
    selector: 'go',
    args: [],
  });
  expect(reports[2]).toMatchObject({
    script: 's',
    run: 's/r1',
    rootDelivery: 'd1',
    state: 'terminal',
    fuel: (reports[1] as { fuel: number }).fuel,
  });
  expect(reports[3]).toMatchObject({
    rootDelivery: 'd1',
    liveRuns: 0,
    queuedMessages: 0,
    discardedMessages: 0,
  });
  expect(g.pump(0n).reports).toEqual([]);
});

test('detached descendants retain ancestry through restore and lifecycle discard', () => {
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source: 'on go\n send child to s\nend go\non child\n wait 1 s\nend child',
  });
  s.deliver({ name: 'go' });
  const first = g.pump(0n).reports;
  expect(first.filter(r => r.kind === 'run started')[1]).toMatchObject({
    run: 's/r2',
    rootDelivery: 'd1',
    parentRun: 's/r1',
  });
  expect(first.at(-1)).toMatchObject({
    kind: 'causal work',
    liveRuns: 1,
    queuedMessages: 0,
  });
  const { group: restored, result } = restore(g.save(), options);
  expect(result.reports.map(r => r.kind)).toEqual([
    'run accounting',
    'causal work',
  ]);
  expect(result.reports[0]).toMatchObject({
    run: 's/r2',
    rootDelivery: 'd1',
    parentRun: 's/r1',
    state: 'live',
  });
  const reloaded = restored.reload('s', 'on go\nend go', 'carry variables');
  expect(reloaded.find(r => r.kind === 'run discarded')).toMatchObject({
    run: 's/r2',
    reason: 'reload',
  });
  expect(reloaded.find(r => r.kind === 'run accounting')).toMatchObject({
    run: 's/r2',
    state: 'discarded',
  });
  expect(reloaded.at(-1)).toMatchObject({
    kind: 'causal work',
    liveRuns: 0,
    queuedMessages: 0,
  });
});

test('observation Fuel belongs to the existing waiter rather than the incoming family', () => {
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source:
      'on watch\n wait for\n when ping n where n > 0 then\n return n\n end wait\nend watch\non ping n\nend ping',
  });
  s.deliver({ name: 'watch' });
  const before = g.pump(0n).reports.find(r => r.kind === 'run accounting')!;
  if (before.kind !== 'run accounting') {
    throw new Error('missing accounting');
  }
  s.deliver({ name: 'ping', args: [num(-1)] });
  const reports = g.pump(0n, { fuelCap: 1 }).reports;
  expect(reports.filter(r => r.kind === 'run accounting')).toMatchObject([
    { run: 's/r1', rootDelivery: 'd1', fuel: before.fuel + 7, state: 'live' },
    { run: 's/r2', rootDelivery: 'd2', fuel: 0, state: 'live' },
  ]);
});

test('queued descendants survive their parent ending and full restore', () => {
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source: 'on go\n send child to s\nend go\non child\n return 2\nend child',
  });
  s.deliver({ name: 'go' });
  let reports = g.pump(0n, { fuelCap: 1 }).reports;
  for (let i = 0; i < 50 && !reports.some(r => r.kind === 'run end'); i++) {
    reports = g.pump(0n, { fuelCap: 1 }).reports;
  }
  expect(reports.at(-1)).toMatchObject({
    kind: 'causal work',
    rootDelivery: 'd1',
    liveRuns: 0,
    queuedMessages: 1,
  });
  const saved = g.save();
  const restored = restore(saved, options);
  expect(restored.result.reports).toEqual([
    {
      kind: 'causal work',
      rootDelivery: 'd1',
      liveRuns: 0,
      queuedMessages: 1,
      discardedMessages: 0,
    },
  ]);
  expect(restored.group.pump(0n).reports[0]).toMatchObject({
    kind: 'run started',
    rootDelivery: 'd1',
    parentRun: 's/r1',
    run: 's/r2',
  });
  const discarded = g.reload('s', 'on go\nend go', 'carry variables');
  expect(discarded.at(-1)).toMatchObject({
    kind: 'causal work',
    rootDelivery: 'd1',
    liveRuns: 0,
    queuedMessages: 0,
    discardedMessages: 1,
  });
});

test('queued cancellation closes a root without inventing a Run or discard', () => {
  const g = newGroup({ name: 'g' });
  const s = g.load({ name: 's', source: 'on go\nend go' });
  const id = s.deliver({ name: 'go' });
  g.cancelDelivery(id);
  const reports = g.pump(0n).reports;
  expect(
    reports.filter(
      r => r.kind === 'run started' || r.kind === 'run accounting',
    ),
  ).toEqual([]);
  expect(reports.filter(r => r.kind === 'causal work')).toEqual(
    ['d1'].map(rootDelivery => ({
      kind: 'causal work',
      rootDelivery,
      liveRuns: 0,
      queuedMessages: 0,
      discardedMessages: 0,
    })),
  );
});

test('variables-only restore reports saved totals and dropped input roots', () => {
  const g = newGroup({ name: 'g' });
  g.addLibrary(
    compileLibrary({ name: 'extra', version: '1', source: 'constant x=1' }),
  );
  const s = g.load({ name: 's', source: 'on go\n wait 1 s\nend go' });
  s.deliver({ name: 'go' });
  const first = g.pump(0n).reports.find(r => r.kind === 'run accounting')!;
  if (first.kind !== 'run accounting') {
    throw new Error('missing total');
  }
  s.deliver({ name: 'go' });
  const saved = g.save();
  expect(() => restore(saved, options)).toThrow('save mismatch');
  const { group: copy, result } = restore(saved, {
    ...options,
    onMismatch: 'variables only',
  });
  expect(result.reports).toEqual([
    {
      kind: 'run discarded',
      script: 's',
      run: 's/r1',
      rootDelivery: 'd1',
      reason: 'variables-only restore',
    },
    {
      kind: 'run accounting',
      script: 's',
      run: 's/r1',
      rootDelivery: 'd1',
      fuel: first.fuel,
      state: 'discarded',
    },
    {
      kind: 'causal work',
      rootDelivery: 'd1',
      liveRuns: 0,
      queuedMessages: 0,
      discardedMessages: 0,
    },
    {
      kind: 'causal work',
      rootDelivery: 'd2',
      liveRuns: 0,
      queuedMessages: 0,
      discardedMessages: 1,
    },
  ]);
  expect(copy.pump(0n).reports).toEqual([]);
});

for (const c of accountingCases) {
  test(`shared public accounting: ${c.name}`, () => {
    const g = newGroup({ name: 'g' });
    g.load({ name: 's', source: c.source }).deliver({ name: 'go' });
    for (const [i, clock] of c.pumps.entries()) {
      const reports = g.pump(BigInt(clock)).reports.map(r => {
        if (r.kind === 'run end') {
          return { kind: r.kind, run: r.run };
        }
        if (r.kind === 'run started') {
          return { ...r, args: r.args.map(v => v.toString()) };
        }
        return r;
      });
      expect<unknown>(reports).toEqual(c.expected[i]);
    }
  });
}

test('same-Pump stop retains dispatch, discard and exact final Fuel', () => {
  const g = newGroup({ name: 'g' });
  const api = defineCapability('api', {
    halt: {
      mode: 'immediate',
      cost: { fuel: 7 },
      do: call => {
        call.group.script('s')!.stop('halt');
        return nothing;
      },
    },
  });
  const s = g.load({
    name: 's',
    grants: { api: api.grant('all', undefined) },
    source: 'on go\n ask api to halt\nend go',
  });
  s.deliver({ name: 'go' });
  const { reports } = g.pump(0n);
  expect(reports.map(r => r.kind)).toEqual([
    'run started',
    'run discarded',
    'stop',
    'run accounting',
    'causal work',
  ]);
  expect(reports[1]).toMatchObject({ run: 's/r1', reason: 'stop' });
  expect(reports[3]).toMatchObject({
    state: 'discarded',
    fuel: s.counters().fuelTotal,
  });
});
