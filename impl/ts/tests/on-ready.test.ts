import { expect, test } from 'bun:test';
import {
  defineCapability,
  defineObjectKind,
  HostError,
  MailboxFull,
  newGroup,
  num,
  parseInstant,
  restore,
  ScriptError,
  shape,
  type Call,
  type Settlement,
} from '../src/index';

const clock = parseInstant('2026-09-30T09:00:00Z');
const kind = defineObjectKind({ name: 'ready-object', props: {} });

const setup = () => {
  let ready = 0;
  const options = { name: 'test', onReady: () => ready++ };
  const group = newGroup(options);
  const object = group.object(kind, 'a', undefined);
  const script = group.load({
    name: 'a',
    owner: object,
    source:
      'on go\n  return 7\nend go\non choose, deciding\nend choose\non exported\n  return given x: x\nend exported',
  });
  script.deliver({ name: 'exported' });
  const report = group.pump(clock).reports[0]!;
  if (report.kind !== 'run end' || !report.result) {
    throw new Error('No exported Function Value');
  }
  ready = 0;
  return { group, script, object, fn: report.result, ready: () => ready };
};

test('every queued Delivery notifies the Host before returning', () => {
  let ready = 0;
  const options = { name: 'test', onReady: () => ready++ };
  const group = newGroup(options);
  const script = group.load({ name: 'a', source: 'on go\nend go' });
  expect(ready).toBe(0);

  script.deliver({ name: 'go' });
  expect(ready).toBe(1);
  script.deliver({ name: 'go' });
  expect(ready).toBe(2);

  expect(group.pump(clock).reports).toHaveLength(2);
  expect(ready).toBe(2);
});

const queuedCalls: [string, (state: ReturnType<typeof setup>) => unknown][] = [
  [
    'Group.deliver',
    ({ group, object }) => group.deliver(object, { name: 'go' }),
  ],
  ['Script.request', ({ script }) => script.request({ name: 'go' })],
  [
    'Group.request',
    ({ group, object }) => group.request(object, { name: 'go' }),
  ],
  ['Broadcast', ({ group }) => group.broadcast({ name: 'go' })],
  ['Script.decide', ({ script }) => script.decide({ name: 'choose' })],
  [
    'Group.decide',
    ({ group, object }) => group.decide(object, { name: 'choose' }),
  ],
  ['DecideBroadcast', ({ group }) => group.decideBroadcast({ name: 'choose' })],
  ['Call', ({ group, fn }) => group.call(fn, [num(3)])],
  ['SetParent', ({ group, object }) => group.setParent(object, undefined)],
  ['Dispose', ({ group, object }) => group.dispose(object)],
  ['Stop', ({ script }) => script.stop('done')],
  ['CancelRun', ({ script }) => script.cancelRun('a/r1')],
  ['Revoke', ({ script }) => script.revoke('absent')],
];

test.each(queuedCalls)(
  '%s notifies for each accepted queued call',
  (_, call) => {
    const state = setup();
    call(state);
    expect(state.ready()).toBe(1);
    call(state);
    expect(state.ready()).toBe(2);
    state.group.pump(clock);
    expect(state.ready()).toBe(2);
  },
);

const cancellableCalls: [
  string,
  (state: ReturnType<typeof setup>, signal: AbortSignal) => unknown,
][] = [
  [
    'Script.request',
    ({ script }, signal) => script.request({ name: 'go' }, { signal }),
  ],
  [
    'Group.request',
    ({ group, object }, signal) =>
      group.request(object, { name: 'go' }, { signal }),
  ],
  [
    'Script.decide',
    ({ script }, signal) => script.decide({ name: 'choose' }, { signal }),
  ],
  [
    'Group.decide',
    ({ group, object }, signal) =>
      group.decide(object, { name: 'choose' }, { signal }),
  ],
  [
    'DecideBroadcast',
    ({ group }, signal) =>
      group.decideBroadcast({ name: 'choose' }, { signal }),
  ],
  ['Call', ({ group, fn }, signal) => group.call(fn, [num(3)], { signal })],
];

test.each(cancellableCalls)(
  '%s signal cancellation notifies separately',
  (_, call) => {
    const state = setup();
    const controller = new AbortController();
    call(state, controller.signal);
    expect(state.ready()).toBe(1);
    controller.abort();
    expect(state.ready()).toBe(2);
    controller.abort();
    expect(state.ready()).toBe(2);
    state.group.pump(clock);
    expect(state.ready()).toBe(2);
  },
);

test.each(cancellableCalls)(
  '%s with an aborted signal notifies for both inputs',
  (_, call) => {
    const state = setup();
    call(state, AbortSignal.abort());
    expect(state.ready()).toBe(2);
    state.group.pump(clock);
    expect(state.ready()).toBe(2);
  },
);

const pendingGroup = () => {
  const calls: Call<void>[] = [];
  let ready = 0;
  const capability = defineCapability('ready', {
    get: {
      mode: 'suspending',
      result: shape.number,
      cost: { fuel: 0 },
      start: call => calls.push(call),
    },
  });
  const grant = capability.grant('all', undefined);
  const options = { name: 'test', onReady: () => ready++ };
  const group = newGroup(options);
  group
    .load({
      name: 'a',
      source: 'on go\n  ask ready to get and wait\n  return it\nend go',
      grants: { ready: grant },
    })
    .deliver({ name: 'go' });
  group.pump(clock);
  ready = 0;
  return { group, calls, grant, ready: () => ready };
};

test.each(['answer', 'fail'] as const)(
  'Call.%s notifies, including a late answer',
  reply => {
    const state = pendingGroup();
    const call = state.calls[0]!;
    const respond = () =>
      reply === 'answer'
        ? call.answer(num(3), { fuel: 1 })
        : call.fail(new ScriptError('unavailable', 'Try later'));
    respond();
    expect(state.ready()).toBe(1);
    expect(state.group.pump(clock).reports).toContainEqual(
      expect.objectContaining({
        kind: 'run end',
        outcome: reply === 'answer' ? 'completed' : 'errored',
      }),
    );
    respond();
    expect(state.ready()).toBe(2);
  },
);

test.each<[string, Settlement]>([
  ['answer', { answer: num(3) }],
  ['fail', { fail: new ScriptError('unavailable', 'Try later') }],
  ['reissue', { reissue: true }],
  ['adopt', { adopt: true }],
])('Settle(%s) uses the restored Group callback', (_, settlement) => {
  const state = pendingGroup();
  let ready = 0;
  const { group } = restore(state.group.save(), {
    name: 'copy',
    onReady: () => ready++,
    libraries: [],
    grants: () => state.grant,
    resolve: () => undefined,
    onMismatch: 'reject',
  });
  expect(ready).toBe(0);
  const adopted = group.settle('a/r1.c1', settlement);
  expect(ready).toBe(1);
  expect(state.ready()).toBe(0);
  expect(() => group.settle('a/r1.c1', settlement)).toThrow(HostError);
  expect(ready).toBe(1);
  group.pump(clock);
  expect(ready).toBe(1);
  if (adopted) {
    adopted.answer(num(4));
    expect(ready).toBe(2);
  }
});

test('refused calls and worker calls do not notify', () => {
  let ready = 0;
  const options = { name: 'test', onReady: () => ready++ };
  const group = newGroup(options);
  const script = group.load({
    name: 'a',
    source: 'on go\nend go',
    limits: { mailboxDepth: 1 },
  });
  group.inspect();
  group.fingerprint();
  group.save();
  expect(ready).toBe(0);
  expect(() => group.call(num(1), [])).toThrow(HostError);
  script.deliver({ name: 'go' });
  expect(ready).toBe(1);
  expect(() => script.deliver({ name: 'go' })).toThrow(MailboxFull);
  expect(ready).toBe(1);
});

test.each(['answer', 'fail'] as const)(
  'Call.%s and other inputs queued inside a Pump notify after it returns',
  async reply => {
    const events: string[] = [];
    let returned = false;
    let armed = false;
    const controller = new AbortController();
    const group = newGroup({
      name: 'test',
      onReady: () => {
        events.push('ready');
        if (armed) {
          expect(returned).toBe(true);
          expect(() => group.inspect()).not.toThrow();
        }
      },
    });
    const capability = defineCapability('ready', {
      get: {
        mode: 'suspending',
        result: shape.number,
        cost: { fuel: 0 },
        start: call => {
          events.push('start');
          group.script('a')!.deliver({ name: 'later' });
          if (reply === 'answer') {
            call.answer(num(3));
          } else {
            call.fail(new ScriptError('unavailable', 'Try later'));
          }
          group
            .script('a')!
            .request({ name: 'later' }, { signal: controller.signal });
          controller.abort();
          group.script('a')!.cancelRun('a/r1');
          events.push('end');
        },
      },
    });
    group
      .load({
        name: 'a',
        source:
          'on go\n  ask ready to get and wait\nend go\non later\nend later',
        grants: { ready: capability.grant('all', undefined) },
      })
      .deliver({ name: 'go' });
    events.length = 0;
    armed = true;
    group.pump(clock);
    returned = true;
    expect(events).toEqual(['start', 'end']);
    await Promise.resolve();
    expect(events).toEqual([
      'start',
      'end',
      'ready',
      'ready',
      'ready',
      'ready',
      'ready',
    ]);
    expect(group.pump(clock).reports).toContainEqual(
      expect.objectContaining({
        kind: 'run end',
        handler: 'later',
        outcome: 'completed',
      }),
    );
  },
);

test('a Stop queued by a property callback notifies after the Pump returns', async () => {
  let ready = 0;
  const group = newGroup({ name: 'test', onReady: () => ready++ });
  const kind = defineObjectKind({
    name: 'ready-switch',
    props: {
      value: {
        get: () => {
          group.script('a')!.stop('off');
          expect(ready).toBe(0);
          return num(1);
        },
      },
    },
  });
  const object = group.object(kind, 'a', undefined);
  group
    .load({
      name: 'a',
      source: 'on go\n  return the value of switcher\nend go',
      objects: { switcher: object },
    })
    .deliver({ name: 'go' });
  ready = 0;
  expect(group.pump(clock).state).toBe('stopped');
  expect(ready).toBe(0);
  await Promise.resolve();
  expect(ready).toBe(1);
});
