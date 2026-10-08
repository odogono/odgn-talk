import { operationalReports } from './operational-reports';
import { describe, expect, test } from 'bun:test';
import {
  defineObjectKind,
  newGroup,
  num,
  parseInstant,
  restore,
  type Group,
  type Inspection,
  ScriptError,
} from '../src/index';

// A Request or Call that rejects with `send failed`, giving the reason in its data.
const expectSendFailed = async (result: Promise<unknown>, reason: string) => {
  const error = await result.then(
    () => null,
    (error_: unknown) => error_,
  );
  expect(error).toBeInstanceOf(ScriptError);
  expect((error as ScriptError).code).toBe('send failed');
  expect((error as ScriptError).data.get('reason').asText()).toBe(reason);
};

const clock = parseInstant('2026-09-30T09:00:00Z');
const room = defineObjectKind<null>({ name: 'room', props: {} });
const handler = (label: string) => `script variable seen = []
on ping n
  put n after seen
  return ["${label}", the target]
end ping
on hold
  repeat 10 times
    put 1 into x
  end repeat
end hold`;
const setup = () => {
  const lines: string[] = [];
  const group = newGroup({ name: 'moving', trace: line => lines.push(line) });
  const oldObject = group.object(room, 'old', null);
  const newObject = group.object(room, 'new', null);
  const leaf = group.object(room, 'leaf', null);
  const old = group.load({
    name: 'old',
    owner: oldObject,
    source: handler('old'),
  });
  const next = group.load({
    name: 'next',
    owner: newObject,
    source: handler('next'),
  });
  group.setParent(leaf, oldObject);
  group.pump(clock);
  return { group, old, next, oldObject, newObject, leaf, lines };
};
const seen = (group: Group, name: string) =>
  group
    .inspect()
    .scripts.find(s => s.name === name)!
    .vars[0]![1].toString();
const restoredOptions = {
  name: 'copy',
  libraries: [],
  grants: () => undefined,
  resolve: () => ({ native: null }),
  onMismatch: 'reject' as const,
};

describe('moving Host Object messages', () => {
  test('a Delivery follows parent changes drained after it, without dispatching in the old Script', async () => {
    const { group, leaf, newObject } = setup();
    const request = group.request(leaf, { name: 'ping', args: [num(1)] });
    group.setParent(leaf, newObject);
    const reports = operationalReports(group.pump(clock).reports);
    expect((await request.result).toString()).toBe(
      '["next", <object room "leaf">]',
    );
    expect(seen(group, 'old')).toBe('[]');
    expect(seen(group, 'next')).toBe('[1]');
    expect(
      reports.filter(r => r.kind === 'run end').map(r => r.script),
    ).toEqual(['next']);
  });

  test('a message waiting behind a preempted Run moves to the new mailbox tail', async () => {
    const { group, old, next, leaf, newObject } = setup();
    old.deliver({ name: 'hold' });
    const request = group.request(leaf, { name: 'ping', args: [num(1)] });
    group.pump(clock, { fuelCap: 1 });
    expect(group.inspect().scripts[0]!.mailbox).toHaveLength(1);
    group.setParent(leaf, newObject);
    next.deliver({ name: 'ping', args: [num(9)] });
    group.pump(clock);
    expect((await request.result).index(1).asText()).toBe('next');
    expect(seen(group, 'next')).toBe('[9, 1]');
    expect(seen(group, 'old')).toBe('[]');
  });

  test('a moved message with no remaining owner is unhandled without starting a Run', async () => {
    const { group, leaf, lines } = setup();
    const request = group.request(leaf, { name: 'ping', args: [num(1)] });
    group.setParent(leaf, undefined);
    const result = group.pump(clock);
    await expectSendFailed(request.result, 'unhandled');
    expect(lines).toContain(
      '> set-parent object=<object room "leaf"> parent=nothing',
    );
    expect(result.fuelUsed).toBe(0);
    expect(operationalReports(result.reports)).toEqual([
      {
        kind: 'unhandled',
        delivery: request.id,
        message: { name: 'ping', args: [num(1)] },
        target: leaf,
      },
    ]);
  });

  test('accepted messages can move into a full mailbox', async () => {
    const { group, leaf } = setup();
    const small = group.object(room, 'small', null);
    const receiver = group.load({
      name: 'small',
      owner: small,
      source: handler('small'),
      limits: { mailboxDepth: 1 },
    });
    const request = group.request(leaf, { name: 'ping', args: [num(1)] });
    receiver.deliver({ name: 'ping', args: [num(9)] });
    group.setParent(leaf, small);
    group.pump(clock);
    expect((await request.result).index(1).asText()).toBe('small');
    expect(seen(group, 'small')).toBe('[9, 1]');
  });

  test('limits cannot loosen when the object moves to a more restricted Script', async () => {
    const { group, leaf } = setup();
    const small = group.object(room, 'small', null);
    group.load({
      name: 'small',
      owner: small,
      source: handler('small'),
      limits: { fuelPerRun: 5 },
    });
    const request = group.request(leaf, {
      name: 'ping',
      args: [num(1)],
      limits: { fuelPerRun: 100 },
    });
    group.setParent(leaf, small);
    const reports = operationalReports(group.pump(clock).reports);
    await expectSendFailed(request.result, 'limit fault');
    expect(reports).toContainEqual(
      expect.objectContaining({
        kind: 'run end',
        script: 'small',
        outcome: 'limit fault',
        limit: 'fuel',
      }),
    );
    expect(seen(group, 'small')).toBe('[]');
  });

  test('Script-addressed messages keep their receiver when the owner moves', async () => {
    const { group, old, oldObject, newObject } = setup();
    const request = old.request({ name: 'ping', args: [num(1)] });
    group.setParent(oldObject, newObject);
    group.pump(clock);
    expect((await request.result).toString()).toBe(
      '["old", <object room "old">]',
    );
  });

  test('a Decision follows the new path and is sealed by its new receiver', async () => {
    const { group, leaf } = setup();
    const gate = group.object(room, 'gate', null);
    group.load({
      name: 'gate',
      owner: gate,
      source: 'on ping n, deciding\n veto "closed"\nend ping',
    });
    const decision = group.decide(leaf, { name: 'ping', args: [num(1)] });
    group.setParent(leaf, gate);
    group.pump(clock);
    expect(await decision.decided).toMatchObject({
      verdict: 'vetoed',
      vetoes: [{ script: 'gate', reason: expect.anything() }],
    });
    expect(seen(group, 'old')).toBe('[]');
  });

  test('save/restore keeps a queued message route and pending parent change', () => {
    const { group, old, leaf, newObject } = setup();
    old.deliver({ name: 'hold' });
    group.deliver(leaf, { name: 'ping', args: [num(1)] });
    group.pump(clock, { fuelCap: 1 });
    group.setParent(leaf, newObject);
    const copy = restore(group.save(), restoredOptions).group;
    copy.pump(clock);
    expect(seen(copy, 'old')).toBe('[]');
    expect(seen(copy, 'next')).toBe('[1]');
  });
});

const waitSource = (from: string) => `script variable seen = []
on watch
  wait for ping n from ${from}
  put it after seen
end watch
on ping n
end ping`;
describe('wait for Host Object targets', () => {
  test('a wait observes only its object Target after rerouting', () => {
    const { group, leaf, newObject } = setup();
    const observer = group.object(room, 'observer', null);
    const watcher = group.load({
      name: 'watcher',
      owner: observer,
      objects: { watched: leaf },
      source: waitSource('watched'),
    });
    group.setParent(newObject, observer);
    watcher.deliver({ name: 'watch' });
    group.pump(clock);
    watcher.deliver({ name: 'ping', args: [num(9)] });
    group.pump(clock);
    expect(seen(group, 'watcher')).toBe('[]');
    group.setParent(leaf, observer);
    group.deliver(leaf, { name: 'ping', args: [num(1)] });
    group.pump(clock);
    expect(seen(group, 'watcher')).toBe('[{name: "ping", args: [1]}]');
  });

  test('wait for from me matches Script-addressed messages by their owner Target', () => {
    const group = newGroup({ name: 'wait' });
    const owner = group.object(room, 'owner', null);
    const watcher = group.load({
      name: 'watcher',
      owner,
      source: waitSource('me'),
    });
    watcher.deliver({ name: 'watch' });
    group.pump(clock);
    watcher.deliver({ name: 'ping', args: [num(2)] });
    group.pump(clock);
    expect(seen(group, 'watcher')).toBe('[{name: "ping", args: [2]}]');
  });

  test('a non-object from value raises wrong kind instead of suspending', () => {
    const group = newGroup({ name: 'wait' });
    group
      .load({ name: 'watcher', source: waitSource('7') })
      .deliver({ name: 'watch' });
    const report = operationalReports(group.pump(clock).reports).find(
      r => r.kind === 'run end',
    );
    expect(report?.kind === 'run end' && report.error?.code).toBe('wrong kind');
  });

  test('a saved object filter retains its identity after restore', () => {
    const group = newGroup({ name: 'wait' });
    const owner = group.object(room, 'owner', null);
    group
      .load({ name: 'watcher', owner, source: waitSource('me') })
      .deliver({ name: 'watch' });
    group.pump(clock);
    const copy = restore(group.save(), restoredOptions).group;
    copy.script('watcher')!.deliver({ name: 'ping', args: [num(2)] });
    copy.pump(clock);
    expect(seen(copy, 'watcher')).toBe('[{name: "ping", args: [2]}]');
  });
});

const pumpUntil = (group: Group, ready: (state: Inspection) => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (ready(group.inspect())) {
      return;
    }
    group.pump(clock, { fuelCap: 1 });
  }
  throw new Error('Expected mailbox state never became ready');
};
const hasMessage = (state: Inspection, script: string, message: string) =>
  state.scripts
    .find(s => s.name === script)!
    .mailbox.some(m => m.message.name === message);

describe('moving message lifecycle', () => {
  test('a Script send keeps its reply id and target when its queued message moves', () => {
    const { group, leaf, newObject } = setup();
    const sender = group.load({
      name: 'sender',
      objects: { leaf },
      source:
        'script variable reply\non go\n send ping with 3 to leaf and wait\n put it into reply\nend go',
    });
    sender.deliver({ name: 'go' });
    pumpUntil(group, state => hasMessage(state, 'old', 'ping'));
    group.setParent(leaf, newObject);
    group.pump(clock);
    expect(seen(group, 'sender')).toBe('["next", <object room "leaf">]');
    expect(seen(group, 'old')).toBe('[]');
  });

  test('a passed message follows the current parent of its last owner without re-entering that owner', async () => {
    const group = newGroup({ name: 'climb' });
    const child = group.object(room, 'child', null);
    const older = group.object(room, 'old', null);
    const newer = group.object(room, 'new', null);
    const lower = group.load({
      name: 'child',
      owner: child,
      source:
        'script variable seen = 0\non ping n\n add 1 to seen\n pass ping\nend ping',
    });
    group.load({ name: 'old', owner: older, source: handler('old') });
    group.load({ name: 'next', owner: newer, source: handler('next') });
    group.setParent(child, older);
    const request = lower.request({ name: 'ping', args: [num(3)] });
    pumpUntil(group, state => hasMessage(state, 'old', 'ping'));
    group.setParent(child, newer);
    group.pump(clock);
    expect((await request.result).toString()).toBe(
      '["next", <object room "child">]',
    );
    expect(seen(group, 'child')).toBe('1');
    expect(seen(group, 'old')).toBe('[]');
  });

  test('an unresolved Command Call follows its sending owner parent after moving', () => {
    const group = newGroup({ name: 'command' });
    const child = group.object(room, 'child', null);
    const older = group.object(room, 'old', null);
    const newer = group.object(room, 'new', null);
    group
      .load({
        name: 'child',
        owner: child,
        source:
          'script variable reply\non go\n ping 4 and wait\n put it into reply\nend go',
      })
      .deliver({ name: 'go' });
    group.load({ name: 'old', owner: older, source: handler('old') });
    group.load({ name: 'next', owner: newer, source: handler('next') });
    group.setParent(child, older);
    pumpUntil(group, state => hasMessage(state, 'old', 'ping'));
    group.setParent(child, newer);
    group.pump(clock);
    expect(seen(group, 'child')).toBe('["next", <object room "child">]');
  });

  test('a cancellation finds a Delivery after it has transferred mailboxes', async () => {
    const { group, leaf, newObject, old, next } = setup();
    const abort = new AbortController();
    old.deliver({ name: 'hold' });
    const request = group.request(
      leaf,
      { name: 'ping', args: [num(1)] },
      { signal: abort.signal },
    );
    next.deliver({ name: 'hold' });
    group.pump(clock, { fuelCap: 1 });
    group.setParent(leaf, newObject);
    pumpUntil(group, state => hasMessage(state, 'next', 'ping'));
    abort.abort();
    const reports = operationalReports(group.pump(clock).reports);
    await expectSendFailed(request.result, 'cancelled');
    expect(reports).toContainEqual(
      expect.objectContaining({
        kind: 'run end',
        script: 'next',
        delivery: request.id,
        outcome: 'cancelled',
        fuel: 0,
      }),
    );
    expect(seen(group, 'next')).toBe('[]');
  });

  test('moving does not restart or transfer a Run that already dispatched', async () => {
    const { group, old, leaf, newObject } = setup();
    old.extend('on sleep\n wait 1 s\n return the target\nend sleep');
    const request = group.request(leaf, { name: 'sleep' });
    group.pump(clock);
    group.setParent(leaf, newObject);
    const reports = operationalReports(
      group.pump(clock + 1_000_000_000n).reports,
    );
    expect(await request.result).toBe(leaf.value);
    expect(reports).toContainEqual(
      expect.objectContaining({
        kind: 'run end',
        script: 'old',
        delivery: request.id,
      }),
    );
  });

  test('disposed intermediary objects are skipped when a queued message walks its path', async () => {
    const { group, leaf, newObject } = setup();
    const bridge = group.object(room, 'bridge', null);
    group.setParent(bridge, newObject);
    const request = group.request(leaf, { name: 'ping', args: [num(1)] });
    group.setParent(leaf, bridge);
    group.dispose(bridge);
    group.pump(clock);
    expect((await request.result).index(1).asText()).toBe('next');
  });
});

describe('object event filters', () => {
  test('block waits pick the first matching object branch', () => {
    const group = newGroup({ name: 'events' });
    const owner = group.object(room, 'owner', null);
    const other = group.object(room, 'other', null);
    const watcher = group.load({
      name: 'watcher',
      owner,
      objects: { other },
      source:
        'script variable seen = 0\non watch\n wait for\n  when ping from other then\n   put 1 into seen\n  when ping from me then\n   put 2 into seen\n  when ping from me then\n   put 3 into seen\n end wait\nend watch\non ping\nend ping',
    });
    watcher.deliver({ name: 'watch' });
    group.pump(clock);
    watcher.deliver({ name: 'ping' });
    group.pump(clock);
    expect(seen(group, 'watcher')).toBe('2');
  });

  test('Script filters still match the sender independently of the Target', () => {
    const group = newGroup({ name: 'events' });
    const owner = group.object(room, 'owner', null);
    const leaf = group.object(room, 'leaf', null);
    const watcher = group.load({
      name: 'watcher',
      owner,
      source: waitSource('sender'),
    });
    const sender = group.load({
      name: 'sender',
      objects: { leaf },
      source: 'on go\n send ping with 1 to leaf\nend go',
    });
    group.setParent(leaf, owner);
    watcher.deliver({ name: 'watch' });
    group.pump(clock);
    sender.deliver({ name: 'go' });
    group.pump(clock);
    expect(seen(group, 'watcher')).toBe('[{name: "ping", args: [1]}]');
  });

  test('event subscriptions retain evaluated object filters even if a Script Variable changes', () => {
    const group = newGroup({ name: 'events' });
    const owner = group.object(room, 'owner', null);
    const other = group.object(room, 'other', null);
    const watcher = group.load({
      name: 'watcher',
      owner,
      source:
        'script variable watched\nscript variable seen = 0\non watch obj\n put obj into watched\n wait for ping from watched\n put 1 into seen\nend watch\non change obj\n put obj into watched\nend change\non ping\nend ping',
    });
    watcher.deliver({ name: 'watch', args: [owner.value] });
    group.pump(clock);
    watcher.deliver({ name: 'change', args: [other.value] });
    watcher.deliver({ name: 'ping' });
    group.pump(clock);
    expect(group.inspect().scripts[0]!.vars[1]![1].toString()).toBe('1');
  });
});

test('an event filter retains one object value in Persistent State', () => {
  const states = ['', ' from me'].map(from => {
    const lines: string[] = [];
    const group = newGroup({ name: 'size', trace: line => lines.push(line) });
    const owner = group.object(room, 'owner', null);
    group
      .load({
        name: 'watcher',
        owner,
        source: `on watch\n wait for ping${from}\nend watch`,
      })
      .deliver({ name: 'watch' });
    group.pump(clock);
    return Number(
      lines.find(line => line.startsWith('seg '))!.match(/state=(\d+)/)![1],
    );
  });
  expect(states[1]! - states[0]!).toBe(16);
});

test('an object-filtered event test executes its extension code unit', () => {
  const group = newGroup({ name: 'extension' });
  const owner = group.object(room, 'owner', null);
  const watcher = group.load({
    name: 'watcher',
    owner,
    source: 'on ping n\n return 0\nend ping',
  });
  watcher.extend(
    'script variable seen = []\non watch\n wait for ping n from me\n put n after seen\nend watch',
  );
  watcher.deliver({ name: 'watch' });
  group.pump(clock);
  watcher.deliver({ name: 'ping', args: [num(7)] });
  group.pump(clock);
  expect(seen(group, 'watcher')).toBe('[7]');
});

test('only the destination observes a moved Decision through its pending wait', async () => {
  const { group, old, next, leaf, newObject } = setup();
  const source =
    'on watch watched\n wait for ping n from watched\n put it after seen\nend watch';
  old.extend(source);
  next.extend(source);
  old.deliver({ name: 'watch', args: [leaf.value] });
  next.deliver({ name: 'watch', args: [leaf.value] });
  group.pump(clock);
  const decision = group.decide(leaf, { name: 'ping', args: [num(2)] });
  group.setParent(leaf, newObject);
  group.pump(clock);
  expect((await decision.decided).verdict).toBe('allowed');
  expect(seen(group, 'old')).toBe('[]');
  expect(seen(group, 'next')).toBe('[2, {name: "ping", args: [2]}]');
  expect(group.inspect().scripts[0]!.runs[0]!.status).toBe('suspended');
});
