// The Wait table on bare Runs, with no Group or Script (ADR 0105).
import { expect, test } from 'bun:test';
import { Run, type Member, type Resumption } from '../src/machine';
import { dec, nothing } from '../src/values';
import {
  abandon,
  abandonMembers,
  abandonReason,
  Waits,
  type JoinWait,
} from '../src/waits';

type Bare = { run: Run };
type Script = { name: string };

const bare = (open: Member[] | null = null): Bare => ({
  run: Object.assign(Run.empty(), {
    suspended: null,
    resumption: null,
    join: open ? { frame: {}, members: open, start: 0 } : null,
  }),
});
const member = (id: string): Member => ({
  abort: new AbortController(),
  at: 0n,
  call: null,
  id,
  ms: 0,
  // These Wait-table tests never execute the member's instruction.
  site: { frame: {} as Member['site']['frame'], pc: 0 },
});
// A Capability call's member, which a preempted open Join keeps awaited.
const called = (id: string): Member => ({
  ...member(id),
  call: {} as Member['call'],
});
const answer = (n: string): Resumption => ({
  k: 'answer',
  value: dec(n),
  fuel: 0,
});
const none = () => [];
const s: Script = { name: 's' };

test('due timers fire by deadline, then by the order they were set', () => {
  const w = new Waits<Bare, Script>();
  const r = bare();
  const late = w.timer(20n, { k: 'wake', s, running: r }, r);
  const first = w.timer(10n, { k: 'wake', s, running: r }, r);
  const second = w.timer(10n, { k: 'wake', s, running: r }, r);
  const ended = w.timer(5n, { k: 'wake', s, running: r }, r);
  ended.live = false;
  expect(w.next()).toBe(10n);
  const fired = [];
  for (const t of w.takeDue(10n)) {
    fired.push(t);
    // A timer fired earlier can end a later one before it is reached.
    second.live = false;
  }
  expect(fired).toEqual([first]);
  expect(w.next()).toBe(20n);
  expect([...w.takeDue(30n)]).toEqual([late]);
  expect(w.next()).toBeNull();
});

test('a Join waits for all its members, answered in member order', () => {
  const w = new Waits<Bare, Script>();
  const r = bare();
  const members = [member('s/r1.c1'), member('s/r1.c2')];
  const join: JoinWait<Bare, Script> = { members, answers: new Map() };
  join.deadline = w.timer(
    50n,
    { k: 'deadline', s, running: r, after: nothing, join },
    r,
  );
  for (const m of members) {
    w.add(m.id, s, r, w.timer(40n, { k: 'call', id: m.id, ms: 40 }, r), join);
  }
  expect(w.settle('s/r1.c2', answer('2'), none)).toEqual({ k: 'held' });
  expect(w.pendingMembers(members)).toEqual([members[0]!]);
  const settled = w.settle('s/r1.c1', answer('1'), none);
  expect(settled).toEqual({
    k: 'ready',
    s,
    running: r,
    r: { k: 'joined', answers: [answer('1'), answer('2')] },
  });
  expect(join.deadline.live).toBe(false);
  expect(w.next()).toBeNull();
});

test('a failed Join member cuts its pending siblings in start order', () => {
  const w = new Waits<Bare, Script>();
  const r = bare();
  const members = ['c1', 'c2', 'c3', 'c4'].map(c => member(`s/r1.${c}`));
  const join: JoinWait<Bare, Script> = { members, answers: new Map() };
  for (const m of members) {
    w.add(m.id, s, r, w.timer(40n, { k: 'call', id: m.id, ms: 40 }, r), join);
  }
  w.settle('s/r1.c3', answer('3'), none);
  const settled = w.settle('s/r1.c2', { k: 'timeout', after: 40 }, none);
  expect(settled).toMatchObject({
    k: 'ready',
    r: {
      k: 'join-failed',
      index: 2,
      // The member that timed out first, then the siblings cut.
      abandon: ['s/r1.c2', 's/r1.c1', 's/r1.c4'],
    },
  });
  expect(members.map(m => m.abort!.signal.aborted)).toEqual([
    true,
    false,
    false,
    true,
  ]);
  expect(abandonReason(members[0]!.abort!)).toBe('join-failed');
  expect(w.has('s/r1.c4')).toBe(false);
  expect(w.next()).toBeNull();
});

test('an answer no Wait is on is held by a preempted Join, or late', () => {
  const w = new Waits<Bare, Script>();
  const open = called('s/r1.c1');
  const r = bare([open]);
  const runs = () => [{ running: r, s }];
  expect(w.settle('s/r1.c1', answer('1'), runs)).toEqual({ k: 'held' });
  expect(open.answer).toEqual(dec('1'));
  expect(w.settle('s/r1.c1', answer('1'), runs)).toEqual({ k: 'late' });
  expect(w.settle('s/r9.c1', answer('1'), runs)).toEqual({ k: 'late' });
});

test('forgetting a Run takes only its Waits, timers and waiters', () => {
  const w = new Waits<Bare, Script>();
  const [a, b] = [bare(), bare()];
  for (const [r, id] of [
    [a, 's/r1.c1'],
    [b, 's/r2.c1'],
  ] as const) {
    w.add(id, s, r, w.timer(10n, { k: 'call', id, ms: 10 }, r));
    w.addWaiter(s, {
      running: r,
      timers: [w.timer(20n, { k: 'wake', s, running: r }, r)],
    });
  }
  w.forget(s, a);
  expect(w.has('s/r1.c1')).toBe(false);
  expect(w.has('s/r2.c1')).toBe(true);
  expect(w.waitersOf(s).map(x => x.running)).toEqual([b]);
  expect([...w.takeDue(30n)].map(t => t.running)).toEqual([b, b]);
});

test('ending a `wait for` while iterating still visits every one begun', () => {
  const w = new Waits<Bare, Script>();
  const runs = [bare(), bare(), bare()];
  for (const r of runs) {
    w.addWaiter(s, {
      running: r,
      timers: [w.timer(10n, { k: 'wake', s, running: r }, r)],
    });
  }
  const visited = [];
  for (const waiter of w.waitersOf(s)) {
    visited.push(waiter.running);
    w.endWaiter(s, waiter);
  }
  expect(visited).toEqual(runs);
  expect(w.waitersOf(s)).toEqual([]);
  expect(w.next()).toBeNull();
});

test('abandoning keeps the first reason and skips answered members', () => {
  const abort = new AbortController();
  abandon(abort, 'timeout');
  abandon(abort, 'stopped');
  expect(abort.signal.aborted).toBe(true);
  expect(abandonReason(abort)).toBe('timeout');
  const members = [member('s/r1.c1'), member('s/r1.c2'), member('s/r1.c3')];
  members[0]!.answer = dec('1');
  members[1]!.reply = { k: 'reply', value: nothing };
  expect(abandonMembers(members, 'join-ended')).toEqual(['s/r1.c3']);
  expect(members.map(m => m.abort!.signal.aborted)).toEqual([
    false,
    false,
    true,
  ]);
});

test('a call is awaited by its Wait or by a preempted open Join', () => {
  const w = new Waits<Bare, Script>();
  const suspended = bare();
  const preempted = bare([called('s/r2.c2'), called('s/r2.c1')]);
  w.add(
    's/r1.c1',
    s,
    suspended,
    w.timer(10n, { k: 'call', id: 's/r1.c1', ms: 10 }),
  );
  const runs = () => [
    { running: suspended, s },
    { running: preempted, s },
  ];
  expect(w.awaited('s/r1.c1', runs)?.running).toBe(suspended);
  expect(w.awaited('s/r2.c1', runs)).toEqual({ running: preempted, s });
  expect(w.awaited('s/r3.c1', runs)).toBeUndefined();
  expect(
    w.awaitedCalls(runs, (a, b) => a.localeCompare(b)).map(([id]) => id),
  ).toEqual(['s/r1.c1', 's/r2.c1', 's/r2.c2']);
});

test('a save exports the table and a restore rebuilds it', () => {
  const w = new Waits<Bare, Script>();
  const r = bare();
  const ended = w.timer(5n, { k: 'wake', s, running: r }, r);
  ended.live = false;
  const timer = w.timer(10n, { k: 'call', id: 's/r1.c1', ms: 10 }, r);
  w.add('s/r1.c1', s, r, timer);
  const waiter = {
    running: r,
    timers: [w.timer(20n, { k: 'wake', s, running: r }, r)],
  };
  w.addWaiter(s, waiter);
  const saved = w.exportState();
  expect(saved.timers.map(t => t.deadline)).toEqual([10n, 20n]);
  expect(saved.timerSeq).toBe(3);

  const restored = new Waits<Bare, Script>();
  restored.importTimerSeq(saved.timerSeq);
  restored.importWaits(saved.pending, saved.timers);
  restored.importWaiters(s, [...w.waitersOf(s)]);
  expect(restored.has('s/r1.c1')).toBe(true);
  expect(restored.waitersOf(s)).toEqual([waiter]);
  expect(restored.timer(30n, { k: 'wake', s, running: r }).seq).toBe(3);
  expect(restored.next()).toBe(10n);
});
