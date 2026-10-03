import { expect, test } from 'bun:test';
import {
  defineCapability,
  newGroup,
  nothing,
  shape,
  parseInstant,
  type SegmentContext,
  type EffectResult,
  type Call,
  type Group,
  type Limits,
  type Value,
  ScriptError,
  text,
  compileLibrary,
  restore,
  exportManifest,
} from '../src/index';

const now = parseInstant('2026-09-30T09:00:00Z');
const transactionalHost = (
  commit: EffectResult = { status: 'ok' },
  options: {
    begin?: (context: SegmentContext<void>) => EffectResult;
    change?: (call: Call<void>) => Value;
    close?: (call: Call<void>) => Value;
    commit?: (context: SegmentContext<void>) => EffectResult;
    rollback?: (context: SegmentContext<void>) => EffectResult;
  } = {},
) => {
  const events: string[] = [];
  let provisional = 0;
  let committed = 0;
  const cap = defineCapability(
    'store',
    {
      later: {
        mode: 'suspending',
        args: [],
        cost: { fuel: 0 },
        start: () => {},
      },
      change: {
        mode: 'immediate',
        args: [],
        result: shape.nothing,
        cost: { fuel: 1 },
        segmentBound: true,
        do: call => {
          events.push(`change:${call.segmentId}`);
          provisional++;
          return options.change?.(call) ?? nothing;
        },
      },
      open: {
        mode: 'immediate',
        args: [],
        result: shape.nothing,
        cost: { fuel: 1 },
        segmentBound: true,
        scope: { opens: 'transaction', abandon: 'close' },
        do: call => {
          events.push(`open:${call.segmentId}`);
          return nothing;
        },
      },
      close: {
        mode: 'immediate',
        args: [],
        result: shape.nothing,
        cost: { fuel: 1 },
        segmentBound: true,
        scope: { closes: 'transaction' },
        do: call => {
          events.push(
            `${call.automatic ? 'abandon' : 'close'}:${call.segmentId}`,
          );
          return options.close?.(call) ?? nothing;
        },
      },
    },
    {
      begin: (context: SegmentContext<void>) => {
        events.push(`begin:${context.segmentId}`);
        provisional = committed;
        return options.begin?.(context) ?? { status: 'ok' };
      },
      commit: context => {
        events.push(`commit:${context.segmentId}`);
        const result = options.commit?.(context) ?? commit;
        if (result.status === 'ok') {
          committed = provisional;
        }
        return result;
      },
      rollback: context => {
        events.push(`rollback:${context.segmentId}`);
        provisional = committed;
        return options.rollback?.(context) ?? { status: 'ok' };
      },
    },
  );
  return { cap, events, state: () => ({ provisional, committed }) };
};
const start = (
  body: string,
  host = transactionalHost(),
  limits: Partial<Limits> = {},
) => {
  const lines: string[] = [];
  const group = newGroup({ name: 'g', trace: line => lines.push(line) });
  const grant = host.cap.grant('all', undefined);
  const script = group.load({
    name: 's',
    source: `script variable count = 0\non go\n${body}\nend go`,
    grants: { db: grant, alias: grant },
    limits,
  });
  script.deliver({ name: 'go' });
  return { group, script, host, lines, grant };
};

test('one participant shares Operations and commits with Script Variables', () => {
  const { group, host } = start(
    'put 2 into count\nask db to change\nask db to change',
  );
  expect(group.pump(now).reports).toContainEqual(
    expect.objectContaining({ outcome: 'completed' }),
  );
  expect(host.events).toEqual([
    'begin:s/r1.s1',
    'change:s/r1.s1',
    'change:s/r1.s1',
    'commit:s/r1.s1',
  ]);
  expect(host.state()).toEqual({ provisional: 2, committed: 2 });
});
test('aliases conflict before their Host effects; ordinary errors commit', () => {
  const { group, host } = start('ask db to change\nask alias to change');
  expect(group.pump(now).reports).toContainEqual(
    expect.objectContaining({
      outcome: 'errored',
      error: expect.objectContaining({ code: 'segment participant conflict' }),
    }),
  );
  expect(host.state().committed).toBe(1);
  expect(host.events).toHaveLength(3);
});
test('preemption preserves participant identity and refuses Save', () => {
  const { group, host } = start(
    'ask db to change\nrepeat 20 times\nput count + 1 into count\nend repeat',
  );
  group.pump(now, { fuelSlice: 20, fuelCap: 20 });
  expect(host.events).toEqual(['begin:s/r1.s1', 'change:s/r1.s1']);
  expect(() => group.save()).toThrow('effects pending');
  group.pump(now);
  expect(host.events.at(-1)).toBe('commit:s/r1.s1');
});
test('definite non-commit rolls back and ends with uncatchable effect failed', () => {
  const { group, host } = start(
    'put 1 into count\nask db to change',
    transactionalHost({ status: 'failed' }),
  );
  expect(group.pump(now).reports).toContainEqual(
    expect.objectContaining({
      outcome: 'effect failed',
      effect: expect.objectContaining({ phase: 'commit', grant: 'db' }),
    }),
  );
  expect(host.events.at(-1)).toBe('rollback:s/r1.s1');
  expect(host.state().committed).toBe(0);
});
test('actual suspension commits and resumes in a new Segment', () => {
  const { group, host } = start(
    'ask db to change\nwait 1 ms\nask db to change',
  );
  group.pump(now);
  expect(host.events.at(-1)).toBe('commit:s/r1.s1');
  group.pump(now + 1_000_000n);
  expect(host.events.slice(-3)).toEqual([
    'begin:s/r1.s2',
    'change:s/r1.s2',
    'commit:s/r1.s2',
  ]);
});

const count = (group: Group) =>
  group.inspect().scripts[0]!.vars[0]![1].toString();
const runEnd = (group: Group) =>
  group.pump(now).reports.find(r => r.kind === 'run end');

test.each([
  ['return 3', 'completed'],
  ['pass go', 'completed'],
  ['throw {code: "ordinary"}', 'errored'],
  [
    'try\nthrow {code: "ordinary"}\ncatch e\nput 2 into count\nend try',
    'completed',
  ],
])('ordinary boundary %s commits after unwind', (boundary, outcome) => {
  const { group, host } = start(
    `ask db to change\nput 1 into count\n${boundary}`,
  );
  expect(runEnd(group)).toMatchObject({ outcome });
  expect(host.events.at(-1)).toBe('commit:s/r1.s1');
  expect(host.state().committed).toBe(1);
});
test('Limit Fault after explicit close rolls back its provisional effects and variables', () => {
  const { group, host } = start(
    'ask db to open\nask db to change\nask db to close\nput 1 into count\nrepeat forever\nend repeat',
    transactionalHost(),
    { fuelPerRun: 100 },
  );
  expect(runEnd(group)).toMatchObject({ outcome: 'limit fault' });
  expect(host.events.slice(-2)).toEqual(['close:s/r1.s1', 'rollback:s/r1.s1']);
  expect(host.state()).toEqual({ provisional: 0, committed: 0 });
  expect(count(group)).toBe('0');
});
test('Save after explicit close still refuses until the participant ends', () => {
  const { group, host } = start(
    'ask db to open\nask db to close\nrepeat forever\nend repeat',
  );
  group.pump(now, { fuelSlice: 40 });
  expect(host.events.at(-1)).toBe('close:s/r1.s1');
  expect(() => group.save()).toThrow('effects pending');
});
test('cancellation abandons participant scope then rolls back before fresh finally Segment', () => {
  const { group, script, host } = start(
    'try\nask db to open\nask db to change\nput 1 into count\nrepeat forever\nend repeat\nfinally\nask db to change\nput 2 into count\nend try',
  );
  group.pump(now, { fuelSlice: 50 });
  script.cancelRun('s/r1');
  expect(runEnd(group)).toMatchObject({ outcome: 'cancelled' });
  expect(host.events).toEqual([
    'begin:s/r1.s1',
    'open:s/r1.s1',
    'change:s/r1.s1',
    'abandon:s/r1.s1',
    'rollback:s/r1.s1',
    'begin:s/r1.s2',
    'change:s/r1.s2',
    'commit:s/r1.s2',
  ]);
  expect(count(group)).toBe('2');
  expect(host.state().committed).toBe(1);
});
test.each([
  ['throw {code: "cleanup"}', {}, 'cancelled', 'commit:s/r1.s2', '2'],
  [
    'repeat forever\nend repeat',
    { cleanupBudget: 40 },
    'cancelled',
    'rollback:s/r1.s2',
    '0',
  ],
])(
  'cleanup %s follows its own Segment outcome',
  (ending, limits, outcome, last, variable) => {
    const { group, script, host } = start(
      `try\nask db to change\nrepeat forever\nend repeat\nfinally\nask db to change\nput 2 into count\n${ending}\nend try`,
      transactionalHost(),
      limits,
    );
    group.pump(now, { fuelSlice: 40 });
    script.cancelRun('s/r1');
    expect(runEnd(group)).toMatchObject({ outcome });
    expect(host.events.at(-1)).toBe(last);
    expect(count(group)).toBe(variable);
  },
);
test('cleanup commit failure ends effect failed and restores cleanup variables', () => {
  const { group, script, host } = start(
    'try\nask db to change\nrepeat forever\nend repeat\nfinally\nask db to change\nput 2 into count\nend try',
    transactionalHost({ status: 'failed' }),
  );
  group.pump(now, { fuelSlice: 40 });
  script.cancelRun('s/r1');
  expect(runEnd(group)).toMatchObject({ outcome: 'effect failed' });
  expect(host.events.at(-1)).toBe('rollback:s/r1.s2');
  expect(count(group)).toBe('0');
});
test('definite begin failure is catchable and never calls the Operation or rollback', () => {
  const host = transactionalHost(
    { status: 'ok' },
    { begin: () => ({ status: 'failed', detail: 'unavailable' }) },
  );
  const { group } = start(
    'try\nask db to change\ncatch e\nput 2 into count\nend try',
    host,
  );
  expect(runEnd(group)).toMatchObject({ outcome: 'completed' });
  expect(host.events).toEqual(['begin:s/r1.s1']);
  expect(count(group)).toBe('2');
});
test.each(['begin', 'commit', 'rollback'] as const)(
  'unknown %s stops all Scripts and refuses mutations and Save',
  phase => {
    const host = transactionalHost(
      { status: 'ok' },
      { [phase]: () => ({ status: 'unknown' }) },
    );
    const { group, script, lines } = start(
      `ask db to change\n${phase === 'rollback' ? 'repeat forever\nend repeat' : ''}`,
      host,
      { fuelPerRun: 70 },
    );
    group.load({ name: 'other', source: 'on go\nreturn 1\nend go' });
    const reports = group.pump(now).reports;
    expect(reports.filter(r => r.kind === 'stop').map(r => r.script)).toEqual([
      's',
      'other',
    ]);
    expect(lines.findIndex(l => l.startsWith('seg s/r1'))).toBeLessThan(
      lines.findIndex(l => l.startsWith('stopped ')),
    );
    expect(
      reports
        .filter(r => r.kind === 'stop')
        .every(r => r.reason === 'effect state unknown'),
    ).toBe(true);
    expect(host.events.filter(e => e.startsWith('rollback:'))).toHaveLength(1);
    expect(host.events.filter(e => e.startsWith('commit:'))).toHaveLength(
      phase === 'commit' ? 1 : 0,
    );
    expect(() => group.save()).toThrow('effects pending');
    expect(() => group.load({ name: 'new', source: '' })).toThrow(
      'effect state unknown',
    );
    expect(() => script.reload('', 'carry variables')).toThrow(
      'effect state unknown',
    );
    expect(() => script.extend('on ping\nend ping')).toThrow(
      'effect state unknown',
    );
    expect(() =>
      group.replaceLibrary(
        compileLibrary({ name: 'user', version: '1', source: '' }),
        'carry variables',
      ),
    ).toThrow('effect state unknown');
  },
);
test('failed rollback is terminal and is attempted exactly once', () => {
  const host = transactionalHost(
    { status: 'failed' },
    { rollback: () => ({ status: 'failed' }) },
  );
  const { group } = start('ask db to change', host);
  expect(group.pump(now).state).toBe('stopped');
  expect(host.events).toEqual([
    'begin:s/r1.s1',
    'change:s/r1.s1',
    'commit:s/r1.s1',
    'rollback:s/r1.s1',
  ]);
});
test('failed participating abandonment prevents commit, disables Grant and rolls back', () => {
  const host = transactionalHost(
    { status: 'ok' },
    {
      close: () => {
        throw new ScriptError('broken', 'broken');
      },
    },
  );
  const { group } = start(
    'ask db to open\nask db to change\nput 2 into count',
    host,
  );
  expect(runEnd(group)).toMatchObject({
    outcome: 'effect failed',
    effect: { phase: 'abandon', scope: 'transaction' },
  });
  expect(host.events.slice(-2)).toEqual([
    'abandon:s/r1.s1',
    'rollback:s/r1.s1',
  ]);
  expect(count(group)).toBe('0');
  expect(group.inspect().scripts[0]!.disabledGrants).toEqual(['db']);
});
test('Stop queued by commit lands after finalization and successful outcome publication', () => {
  const host = transactionalHost(
    { status: 'ok' },
    {
      commit: context => {
        context.group.script('s')!.stop('requested');
        return { status: 'ok' };
      },
    },
  );
  const { group, lines } = start('ask db to change\nput 2 into count', host);
  const reports = group.pump(now).reports;
  expect(reports.find(r => r.kind === 'run end')).toMatchObject({
    outcome: 'completed',
  });
  expect(host.events.at(-1)).toBe('commit:s/r1.s1');
  expect(count(group)).toBe('2');
  expect(lines.findIndex(l => l.startsWith('run '))).toBeLessThan(
    lines.findIndex(l => l.startsWith('stopped ')),
  );
});
test('Reload carries post-rollback variables and lifecycle uses last Clock without reentry', () => {
  const host = transactionalHost(
    { status: 'ok' },
    {
      rollback: context => {
        expect(context.now).toBe(now);
        expect(() => context.group.save()).toThrow('reentrant call');
        return { status: 'ok' };
      },
    },
  );
  const { group, script } = start(
    'ask db to change\nput 2 into count\nrepeat forever\nend repeat',
    host,
  );
  group.pump(now, { fuelSlice: 40 });
  expect(() => script.reload('on', 'carry variables')).toThrow();
  expect(host.events).toHaveLength(2);
  script.reload(
    'script variable count = 9\non go\nreturn count\nend go',
    'carry variables',
  );
  expect(host.events.at(-1)).toBe('rollback:s/r1.s1');
  expect(count(group)).toBe('0');
});
test('participant metadata is exported and lifecycle callbacks do not affect fingerprints', () => {
  const host = transactionalHost();
  const grant = host.cap.grant('all', undefined);
  expect(
    exportManifest({ kind: 'test', version: '1', grants: { db: grant } }),
  ).toContain('"segmentBound":true');
  const a = start('ask db to change', host).group;
  const b = start(
    'ask db to change',
    transactionalHost({ status: 'failed' }),
  ).group;
  expect(a.fingerprint()).toEqual(b.fingerprint());
});

test.each(['ok', 'failed'] as const)(
  'Decision veto is published only after %s commit',
  async status => {
    const host = transactionalHost({ status });
    const lines: string[] = [];
    const group = newGroup({ name: 'g', trace: line => lines.push(line) });
    const script = group.load({
      name: 's',
      source: 'on go, deciding\nask db to change\nveto "blocked"\nend go',
      grants: { db: host.cap.grant('all', undefined) },
    });
    const decision = script.decide({ name: 'go' });
    group.pump(now);
    expect(await decision.decided).toMatchObject(
      status === 'ok'
        ? { verdict: 'vetoed' }
        : { verdict: 'undecided', undecided: [{ outcome: 'effect failed' }] },
    );
    expect(
      lines.findIndex(
        l => l.startsWith('effect s/r1.s1') && l.includes('phase=commit'),
      ),
    ).toBeLessThan(lines.findIndex(l => l.startsWith('decided ')));
  },
);
test('senders receive effect failed and no Script error Handler executes', () => {
  const host = transactionalHost({ status: 'failed' });
  const group = newGroup({ name: 'g' });
  const grant = host.cap.grant('all', undefined);
  group.load({
    name: 'receiver',
    source:
      'script variable handled = 0\non go\nask db to change\nend go\non error e\nput 1 into handled\nend error',
    grants: { db: grant },
  });
  const sender = group.load({
    name: 'sender',
    source: 'on go\nsend go to receiver and wait\nend go',
  });
  sender.deliver({ name: 'go' });
  const reports = group.pump(now).reports;
  const ended = reports.find(
    r => r.kind === 'run end' && r.script === 'sender',
  );
  expect(ended).toMatchObject({
    outcome: 'errored',
    error: { code: 'send failed' },
  });
  if (ended?.kind === 'run end') {
    expect(ended.error!.data.get('reason').toString()).toBe('"effect failed"');
  }
  expect(group.inspect().scripts[0]!.vars[0]![1].toString()).toBe('0');
});
test('unrelated failed abandonment cannot veto participant commit', () => {
  const host = transactionalHost();
  const events: string[] = [];
  const resource = defineCapability('resource', {
    open: {
      mode: 'immediate',
      args: [],
      result: shape.nothing,
      cost: { fuel: 0 },
      scope: { opens: 'file', abandon: 'close' },
      do: () => {
        events.push('open');
        return nothing;
      },
    },
    close: {
      mode: 'immediate',
      args: [],
      result: shape.nothing,
      cost: { fuel: 0 },
      scope: { closes: 'file' },
      do: () => {
        events.push('abandon');
        throw new ScriptError('broken', 'broken');
      },
    },
  });
  const group = newGroup({ name: 'g' });
  const script = group.load({
    name: 's',
    source: 'on go\nask db to change\nask r to open\nend go',
    grants: {
      db: host.cap.grant('all', undefined),
      r: resource.grant('all', undefined),
    },
  });
  script.deliver({ name: 'go' });
  expect(runEnd(group)).toMatchObject({ outcome: 'completed' });
  expect(events).toEqual(['open', 'abandon']);
  expect(host.events.at(-1)).toBe('commit:s/r1.s1');
  expect(group.inspect().scripts[0]!.disabledGrants).toEqual(['r']);
});
test('unrelated scope survives cancellation rollback and is available to finally', () => {
  const host = transactionalHost();
  let open = false;
  const resource = defineCapability('resource', {
    open: {
      mode: 'immediate',
      args: [],
      result: shape.nothing,
      cost: { fuel: 0 },
      scope: { opens: 'file', abandon: 'close' },
      do: () => {
        open = true;
        return nothing;
      },
    },
    close: {
      mode: 'immediate',
      args: [],
      result: shape.nothing,
      cost: { fuel: 0 },
      scope: { closes: 'file' },
      do: () => {
        expect(open).toBe(true);
        expect(host.events.at(-1)).toBe('rollback:s/r1.s1');
        open = false;
        return nothing;
      },
    },
  });
  const group = newGroup({ name: 'g' });
  const script = group.load({
    name: 's',
    source:
      'on go\ntry\nask r to open\nask db to change\nrepeat forever\nend repeat\nfinally\nask r to close\nend try\nend go',
    grants: {
      db: host.cap.grant('all', undefined),
      r: resource.grant('all', undefined),
    },
  });
  script.deliver({ name: 'go' });
  group.pump(now, { fuelSlice: 40 });
  script.cancelRun('s/r1');
  expect(runEnd(group)).toMatchObject({ outcome: 'cancelled' });
  expect(open).toBe(false);
});
test.each(['begin', 'commit', 'rollback'] as const)(
  'exception and malformed %s results are fatal',
  phase => {
    for (const hook of [
      () => {
        throw new Error('broken');
      },
      () => Promise.resolve({ status: 'ok' }) as unknown as EffectResult,
      () => ({ status: 'invalid' }) as unknown as EffectResult,
    ]) {
      const host = transactionalHost(
        phase === 'rollback' ? { status: 'failed' } : { status: 'ok' },
        { [phase]: hook },
      );
      const { group } = start('ask db to change', host);
      expect(group.pump(now).state).toBe('stopped');
      expect(() => group.save()).toThrow('effects pending');
      expect(host.events.filter(e => e.startsWith('rollback:'))).toHaveLength(
        1,
      );
    }
  },
);
test('fatal rollback during Reload prevents replacement and stops the Group', () => {
  const host = transactionalHost(
    { status: 'ok' },
    { rollback: () => ({ status: 'failed' }) },
  );
  const { group, script } = start(
    'ask db to change\nrepeat forever\nend repeat',
    host,
  );
  group.load({ name: 'other', source: '' });
  group.pump(now, { fuelSlice: 40 });
  const reports = script.reload('script variable count = 9', 'carry variables');
  expect(reports).toContainEqual(
    expect.objectContaining({
      kind: 'effect failure',
      phase: 'rollback',
      status: 'failed',
    }),
  );
  expect(() =>
    script.reload('script variable count = 9', 'carry variables'),
  ).toThrow('effect state unknown');
  expect(count(group)).toBe('0');
  expect(group.pump(now).state).toBe('stopped');
  expect(host.events.at(-1)).toBe('rollback:s/r1.s1');
});
test('Stop during an Operation rolls back and never executes finally', () => {
  const host = transactionalHost(
    { status: 'ok' },
    {
      change: call => {
        call.group.script('s')!.stop('halt');
        return nothing;
      },
    },
  );
  const { group } = start(
    'try\nput 2 into count\nask db to change\nfinally\nput 3 into count\nend try',
    host,
  );
  expect(group.pump(now).state).toBe('stopped');
  expect(host.events).toEqual([
    'begin:s/r1.s1',
    'change:s/r1.s1',
    'rollback:s/r1.s1',
  ]);
  expect(count(group)).toBe('0');
});
test.each([
  [
    'alloc',
    `put count & "${'x'.repeat(200)}" into count`,
    { allocPerRun: 100 },
  ],
  [
    'persistent',
    `put count & "${'x'.repeat(200)}" into count`,
    { persistentState: 100 },
  ],
])(
  '%s boundary failure rolls back before publication',
  (limit, body, limits) => {
    const { group, host } = start(
      `ask db to change\n${body}`,
      transactionalHost(),
      limits,
    );
    expect(runEnd(group)).toMatchObject({ outcome: 'limit fault', limit });
    expect(host.events.at(-1)).toBe('rollback:s/r1.s1');
    expect(count(group)).toBe('0');
  },
);
test('call depth fault rolls back the participating Segment', () => {
  const host = transactionalHost();
  const group = newGroup({ name: 'g' });
  const script = group.load({
    name: 's',
    source:
      'on go\nask db to change\nreturn down(1)\nend go\nfunction down n\nreturn down(n + 1)\nend down',
    limits: { callDepth: 5 },
    grants: { db: host.cap.grant('all', undefined) },
  });
  script.deliver({ name: 'go' });
  expect(runEnd(group)).toMatchObject({
    outcome: 'limit fault',
    limit: 'depth',
  });
  expect(host.events.at(-1)).toBe('rollback:s/r1.s1');
});

test('runtime pattern-size fault rolls back the participating Segment', () => {
  const { group, host } = start(
    'ask db to change\nput <4 digits> into p\nput <(p), digit> into q',
    transactionalHost(),
    { patternSize: 5 },
  );
  expect(runEnd(group)).toMatchObject({
    outcome: 'limit fault',
    limit: 'pattern',
  });
  expect(host.events.at(-1)).toBe('rollback:s/r1.s1');
});
test('Join width fault abandons pending members and rolls back without publication', () => {
  const host = transactionalHost();
  let aborted = 0;
  const feed = defineCapability('feed', {
    later: {
      mode: 'suspending',
      args: [],
      cost: { fuel: 0 },
      start: call => {
        call.signal.addEventListener('abort', () => aborted++);
      },
    },
  });
  const group = newGroup({ name: 'g' });
  const script = group.load({
    name: 's',
    source:
      'on go\nask db to change\nwait for all\nask feed to later and wait\nask feed to later and wait\nend wait\nend go',
    limits: { maxJoin: 1 },
    grants: {
      db: host.cap.grant('all', undefined),
      feed: feed.grant('all', undefined),
    },
  });
  script.deliver({ name: 'go' });
  expect(runEnd(group)).toMatchObject({
    outcome: 'limit fault',
    limit: 'join',
  });
  expect(aborted).toBe(1);
  expect(host.events.at(-1)).toBe('rollback:s/r1.s1');
});
test('a commit failure at suspension abandons the started unrelated call', () => {
  const host = transactionalHost({ status: 'failed' });
  let aborted = false;
  const feed = defineCapability('feed', {
    later: {
      mode: 'suspending',
      args: [],
      cost: { fuel: 0 },
      start: call => {
        call.signal.addEventListener('abort', () => {
          aborted = true;
        });
      },
    },
  });
  const group = newGroup({ name: 'g' });
  const script = group.load({
    name: 's',
    source: 'on go\nask db to change\nask feed to later and wait\nend go',
    grants: {
      db: host.cap.grant('all', undefined),
      feed: feed.grant('all', undefined),
    },
  });
  script.deliver({ name: 'go' });
  expect(runEnd(group)).toMatchObject({ outcome: 'effect failed' });
  expect(aborted).toBe(true);
  expect(group.inspect().scripts[0]!.runs).toEqual([]);
});
test('an empty Join does not finalize a participant', () => {
  const { group, host } = start(
    'ask db to change\nwait for all\nif false then ask db to later and wait\nend wait\nask db to change',
  );
  expect(runEnd(group)).toMatchObject({ outcome: 'completed' });
  expect(host.events).toEqual([
    'begin:s/r1.s1',
    'change:s/r1.s1',
    'change:s/r1.s1',
    'commit:s/r1.s1',
  ]);
});
test('successful participant begin followed by ordinary Operation failure still commits', () => {
  const host = transactionalHost(
    { status: 'ok' },
    {
      change: () => {
        throw new ScriptError('unavailable', 'unavailable');
      },
    },
  );
  const { group } = start('ask db to change', host);
  expect(runEnd(group)).toMatchObject({
    outcome: 'errored',
    error: { code: 'unavailable' },
  });
  expect(host.events.at(-1)).toBe('commit:s/r1.s1');
});
test('conversion exhaustion after participating acquisition abandons before rollback', () => {
  const host = transactionalHost(
    { status: 'ok' },
    {
      close: call => {
        expect(call.automatic).toBe(true);
        return nothing;
      },
    },
  );
  // Host-successful acquisition precedes result-conversion charges; conversion
  // exhaustion must still abandon the acquired scope before rollback.
  const open = host.cap.operations.get('open')!;
  const cap = defineCapability(
    'store',
    {
      ...Object.fromEntries(host.cap.operations),
      open: {
        ...open,
        mode: 'immediate',
        result: shape.text,
        do: () => text('x'.repeat(2000)),
      },
    },
    host.cap.lifecycle,
  );
  const group = newGroup({ name: 'g' });
  const script = group.load({
    name: 's',
    source: 'on go\nask db to open\nend go',
    limits: { allocPerRun: 500 },
    grants: { db: cap.grant('all', undefined) },
  });
  script.deliver({ name: 'go' });
  expect(runEnd(group)).toMatchObject({
    outcome: 'limit fault',
    limit: 'alloc',
  });
  expect(host.events).toEqual([
    'begin:s/r1.s1',
    'abandon:s/r1.s1',
    'rollback:s/r1.s1',
  ]);
});
test('failed participating abandonment during required rollback retains the Limit Fault', () => {
  const host = transactionalHost(
    { status: 'ok' },
    {
      close: () => {
        throw new ScriptError('broken', 'broken');
      },
    },
  );
  const { group } = start('ask db to open\nrepeat forever\nend repeat', host, {
    fuelPerRun: 70,
  });
  expect(runEnd(group)).toMatchObject({ outcome: 'limit fault' });
  expect(host.events.at(-1)).toBe('rollback:s/r1.s1');
});
test('Library replacement rolls back before carrying variables and publishing new code', () => {
  const host = transactionalHost();
  const group = newGroup({ name: 'g' });
  group.addLibrary(
    compileLibrary({
      name: 'user',
      version: '1',
      source: 'function answer\nreturn 1\nend answer',
    }),
  );
  const script = group.load({
    name: 's',
    source:
      'use answer from user\nscript variable count = 0\non go\nput answer() into count\nask db to change\nrepeat forever\nend repeat\nend go',
    grants: { db: host.cap.grant('all', undefined) },
  });
  script.deliver({ name: 'go' });
  group.pump(now, { fuelSlice: 40 });
  expect(count(group)).toBe('1');
  group.replaceLibrary(
    compileLibrary({
      name: 'user',
      version: '2',
      source: 'function answer\nreturn 2\nend answer',
    }),
    'carry variables',
  );
  expect(count(group)).toBe('0');
  expect(host.events.at(-1)).toBe('rollback:s/r1.s1');
});
test('definite failure leaves the participant usable on a later Run', () => {
  let commits = 0;
  const host = transactionalHost(
    { status: 'ok' },
    { commit: () => ({ status: ++commits === 1 ? 'failed' : 'ok' }) },
  );
  const { group, script } = start(
    'ask db to change\nput count + 1 into count',
    host,
  );
  expect(runEnd(group)).toMatchObject({ outcome: 'effect failed' });
  script.deliver({ name: 'go' });
  expect(runEnd(group)).toMatchObject({ outcome: 'completed' });
  expect(count(group)).toBe('1');
  expect(host.state().committed).toBe(1);
});
test('definition requires all hooks, immediate mode and consistent scope metadata', () => {
  const op = {
    mode: 'immediate' as const,
    args: [],
    result: shape.nothing,
    cost: { fuel: 0 },
    do: () => nothing,
    segmentBound: true,
  };
  expect(() => defineCapability('invalid', { change: op })).toThrow(
    'lifecycle hooks',
  );
  const hooks = transactionalHost().cap.lifecycle!;
  expect(() =>
    defineCapability('invalid', { change: op }, {
      begin: hooks.begin,
    } as typeof hooks),
  ).toThrow('begin, commit and rollback');
  expect(() =>
    defineCapability(
      'invalid',
      {
        later: {
          mode: 'suspending',
          cost: { fuel: 0 },
          start: () => {},
          segmentBound: true,
        } as unknown as typeof op,
      },
      hooks,
    ),
  ).toThrow('immediate mode');
  expect(() =>
    defineCapability(
      'invalid',
      {
        open: { ...op, scope: { opens: 'tx', abandon: 'close' } },
        close: { ...op, segmentBound: false, scope: { closes: 'tx' } },
      },
      hooks,
    ),
  ).toThrow('agree on segmentBound');
});
test('copied participant metadata and hooks survive later Host declaration mutation', () => {
  const op = {
    mode: 'immediate' as const,
    args: [],
    result: shape.nothing,
    cost: { fuel: 0 },
    do: () => nothing,
    segmentBound: true,
  };
  const host = transactionalHost();
  const hooks = { ...host.cap.lifecycle! };
  const cap = defineCapability('store', { change: op }, hooks);
  op.segmentBound = false;
  hooks.begin = () => ({ status: 'unknown' });
  const group = newGroup({ name: 'g' });
  const script = group.load({
    name: 's',
    source: 'on go\nask db to change\nend go',
    grants: { db: cap.grant('all', undefined) },
  });
  script.deliver({ name: 'go' });
  expect(runEnd(group)).toMatchObject({ outcome: 'completed' });
  expect(host.events).toEqual(['begin:s/r1.s1', 'commit:s/r1.s1']);
});

test('Save/Restore retains participant declarations and disabled state without live effects', () => {
  const host = transactionalHost(
    { status: 'ok' },
    {
      close: () => {
        throw new ScriptError('broken', 'broken');
      },
    },
  );
  const { group, grant } = start('ask db to open', host);
  expect(runEnd(group)).toMatchObject({ outcome: 'effect failed' });
  const saved = group.save();
  const restored = restore(saved, {
    name: 'restored',
    onMismatch: 'reject',
    libraries: [],
    grants: () => grant,
    resolve: () => {
      throw new Error('no objects');
    },
  }).group;
  expect(restored.fingerprint()).toEqual(group.fingerprint());
  expect(restored.inspect().scripts[0]!.disabledGrants).toEqual(['db']);
  const script = restored.script('s')!;
  script.deliver({ name: 'go' });
  expect(runEnd(restored)).toMatchObject({
    outcome: 'errored',
    error: { code: 'capability disabled' },
  });
});
test('false and omitted participant metadata have equal identity and no lifecycle calls', () => {
  const op = {
    mode: 'immediate' as const,
    args: [],
    result: shape.nothing,
    cost: { fuel: 0 },
    do: () => nothing,
  };
  const host = transactionalHost();
  const fingerprints = [];
  const traces: string[][] = [];
  for (const metadata of [{}, { segmentBound: false }]) {
    const cap = defineCapability(
      'store',
      { change: { ...op, ...metadata } },
      host.cap.lifecycle,
    );
    const lines: string[] = [];
    const group = newGroup({ name: 'g', trace: line => lines.push(line) });
    const script = group.load({
      name: 's',
      source: 'on go\nask db to change\nend go',
      grants: { db: cap.grant('all', undefined) },
    });
    fingerprints.push(group.fingerprint());
    script.deliver({ name: 'go' });
    expect(runEnd(group)).toMatchObject({ outcome: 'completed' });
    traces.push(lines);
  }
  expect(fingerprints[0]).toEqual(fingerprints[1]);
  expect(traces[0]).toEqual(traces[1]);
  expect(host.events).toEqual([]);
});
test('rollback failure at cancellation attempts unrelated cleanup and never runs finally', () => {
  const host = transactionalHost(
    { status: 'ok' },
    { rollback: () => ({ status: 'failed' }) },
  );
  const { group, script } = start(
    'try\nask db to open\nrepeat forever\nend repeat\nfinally\nput 9 into count\nend try',
    host,
  );
  group.pump(now, { fuelSlice: 40 });
  script.cancelRun('s/r1');
  expect(group.pump(now).state).toBe('stopped');
  expect(count(group)).toBe('0');
  expect(host.events).toEqual([
    'begin:s/r1.s1',
    'open:s/r1.s1',
    'abandon:s/r1.s1',
    'rollback:s/r1.s1',
  ]);
});
test('cleanup Persistent State failure on ordinary error rolls back cleanup Segment', () => {
  const host = transactionalHost();
  const { group, script } = start(
    `try\nask db to change\nrepeat forever\nend repeat\nfinally\nask db to change\nput count & "${'x'.repeat(200)}" into count\nthrow "failed"\nend try`,
    host,
    { persistentState: 100 },
  );
  group.pump(now, { fuelSlice: 40 });
  script.cancelRun('s/r1');
  expect(runEnd(group)).toMatchObject({
    outcome: 'cancelled',
    cleanupFailed: { limit: 'persistent' },
  });
  expect(host.events.at(-1)).toBe('rollback:s/r1.s2');
  expect(count(group)).toBe('0');
});

test('unknown begin abandons existing scopes before rolling back the possibly acquired participant', () => {
  const events: string[] = [];
  const cap = defineCapability(
    'mixed',
    {
      open: {
        mode: 'immediate',
        args: [],
        result: shape.nothing,
        cost: { fuel: 0 },
        scope: { opens: 'resource', abandon: 'close' },
        do: () => {
          events.push('open');
          return nothing;
        },
      },
      close: {
        mode: 'immediate',
        args: [],
        result: shape.nothing,
        cost: { fuel: 0 },
        scope: { closes: 'resource' },
        do: () => {
          events.push('abandon');
          return nothing;
        },
      },
      change: {
        mode: 'immediate',
        args: [],
        result: shape.nothing,
        cost: { fuel: 0 },
        segmentBound: true,
        do: () => {
          events.push('change');
          return nothing;
        },
      },
    },
    {
      begin: () => {
        events.push('begin');
        return { status: 'unknown' };
      },
      commit: () => {
        events.push('commit');
        return { status: 'ok' };
      },
      rollback: () => {
        events.push('rollback');
        return { status: 'ok' };
      },
    },
  );
  const group = newGroup({ name: 'g' });
  const script = group.load({
    name: 's',
    source: 'on go\nask db to open\nask db to change\nend go',
    grants: { db: cap.grant('all', undefined) },
  });
  script.deliver({ name: 'go' });
  expect(group.pump(now).state).toBe('stopped');
  expect(events).toEqual(['open', 'begin', 'abandon', 'rollback']);
});

test('cancellation queued by the first Operation rolls back before a fresh cleanup Segment without preemption', () => {
  let cancelled = false;
  const host = transactionalHost(
    { status: 'ok' },
    {
      change: call => {
        if (!cancelled) {
          cancelled = true;
          call.group.script(call.scriptName)!.cancelRun(call.runId);
        }
        return nothing;
      },
    },
  );
  const { group } = start(
    'try\nask db to change\nput 2 into count\nfinally\nask db to change\nput 3 into count\nend try',
    host,
  );
  expect(runEnd(group)).toMatchObject({ outcome: 'cancelled' });
  expect(count(group)).toBe('3');
  expect(host.events).toEqual([
    'begin:s/r1.s1',
    'change:s/r1.s1',
    'rollback:s/r1.s1',
    'begin:s/r1.s2',
    'change:s/r1.s2',
    'commit:s/r1.s2',
  ]);
  expect(host.state().committed).toBe(1);
});

test('fatal rollback during Library replacement reports failure and prevents new code publication', () => {
  const host = transactionalHost(
    { status: 'ok' },
    { rollback: () => ({ status: 'failed', detail: 'Host repair required' }) },
  );
  const group = newGroup({ name: 'g' });
  group.addLibrary(
    compileLibrary({
      name: 'user',
      version: '1',
      source: 'function one\nreturn 1\nend one',
    }),
  );
  const script = group.load({
    name: 's',
    grants: { db: host.cap.grant('all', undefined) },
    source:
      'use one from user\non go\nask db to change\nrepeat forever\nend repeat\nend go',
  });
  script.deliver({ name: 'go' });
  group.pump(now, { fuelSlice: 40 });
  const before = group.fingerprint();
  const replacement = compileLibrary({
    name: 'user',
    version: '2',
    source: 'function one\nreturn 2\nend one',
  });
  const reports = group.replaceLibrary(replacement, 'carry variables');
  expect(group.fingerprint()).toEqual(before);
  expect(() => group.replaceLibrary(replacement, 'carry variables')).toThrow(
    'effect state unknown',
  );
  expect(reports).toContainEqual(
    expect.objectContaining({
      kind: 'effect failure',
      script: 's',
      run: 's/r1',
      grant: 'db',
      segment: 's/r1.s1',
      phase: 'rollback',
      status: 'failed',
      detail: 'Host repair required',
    }),
  );
  expect(
    host.events.filter(event => event.startsWith('rollback:')),
  ).toHaveLength(1);
  expect(() => group.save()).toThrow('effects pending');
});
