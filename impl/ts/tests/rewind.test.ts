import { defineCapability, nothing } from '../src/index';
import { expect, test } from 'bun:test';
import { newGroup } from '../src/group';
import { num } from '../src/values';

// A Script whose `go` rewinds its own Run at the `rewind` crossing the first
// time, as a debugger landing a Rewind at that call would (ADR 0068).
const rewinding = () => {
  const g = newGroup({ name: 'g' });
  let rewound = false;
  const api = defineCapability('api', {
    rewind: {
      mode: 'immediate',
      cost: { fuel: 1 },
      do: call => {
        if (!rewound) {
          rewound = true;
          call.group.script('s')!.rewindRun(call.runId);
        }
        return nothing;
      },
    },
  });
  const s = g.load({
    name: 's',
    grants: { api: api.grant('all', undefined) },
    source:
      'script variable n = 0\non go\n add 1 to n\n ask api to rewind\n return n\nend go',
  });
  return { g, s };
};

test('a Rewind ends the Pump as rewound and reports its Run discarded', () => {
  const { g, s } = rewinding();
  s.deliver({ name: 'go' });
  const pumped = g.pump(0n);
  expect(pumped.state).toBe('rewound');
  expect(pumped.reports.map(r => r.kind)).toEqual([
    'run started',
    'run discarded',
    'run accounting',
    'causal work',
  ]);
  expect(pumped.reports[1]).toMatchObject({
    run: 's/r1',
    rootDelivery: 'd1',
    reason: 'rewind',
  });
  expect(pumped.reports[2]).toMatchObject({
    run: 's/r1',
    state: 'discarded',
    fuel: pumped.fuelUsed,
  });
  // The message waits in the mailbox again, and no Run is live.
  expect(pumped.reports[3]).toMatchObject({
    rootDelivery: 'd1',
    liveRuns: 0,
    queuedMessages: 1,
  });
  expect(s.counters().mailboxLen).toBe(1);
});

test('a Reload that keeps the mailbox runs the rewound message on the new code', () => {
  const { g, s } = rewinding();
  s.deliver({ name: 'go' });
  g.pump(0n);
  const reloaded = s.reload(
    'script variable n = 0\non go\n return n + 10\nend go',
    'carry variables',
    { keepMailbox: true },
  );
  expect(reloaded.find(r => r.kind === 'stop')).toMatchObject({
    reason: 'reload',
    discardedRuns: [],
    droppedMessages: [],
  });
  const { state, reports } = g.pump(1n);
  expect(state).toBe('idle');
  expect(reports.find(r => r.kind === 'run started')).toMatchObject({
    run: 's/r2',
    rootDelivery: 'd1',
  });
  // n rolled back with the Segment, so the new code sees 0.
  const ended = reports.find(r => r.kind === 'run end');
  expect(ended).toMatchObject({ run: 's/r2', delivery: 'd1' });
  expect(ended?.kind === 'run end' && ended.result?.equals(num(10))).toBe(true);
});

test('an ordinary Reload drops the rewound message', () => {
  const { g, s } = rewinding();
  s.deliver({ name: 'go' });
  g.pump(0n);
  const reloaded = s.reload('on go\nend go', 'reset variables');
  expect(reloaded.find(r => r.kind === 'stop')).toMatchObject({
    droppedMessages: ['d1'],
  });
  expect(g.pump(1n).reports).toEqual([]);
});

test('a Rewind on a Run past its first Segment does nothing', () => {
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source: 'on go\n wait 1 s\n return 1\nend go',
  });
  s.deliver({ name: 'go' });
  g.pump(0n);
  s.rewindRun('s/r1');
  const pumped = g.pump(1n);
  expect(pumped.state).not.toBe('rewound');
  expect(pumped.reports.some(r => r.kind === 'run discarded')).toBe(false);
});
