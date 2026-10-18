// The Wait table (ADR 0105): pending calls and replies, timers, `wait for`
// waiters, abandonment and save export/import. Settling a Wait changes its
// state and returns the Run that became ready; scheduling and Trace writes
// belong to the Group.
import type { Member, Resumption, Run, Suspension } from './machine';
import type { Value } from './values';

/**
 * The ways a call's Wait ends without its answer being used. Hosts see only
 * the aborted signal; neither the Trace nor a save records the reason.
 */
export type AbandonReason =
  | 'cancelled'
  | 'effect-failed'
  | 'join-ended'
  | 'join-failed'
  | 'limit'
  | 'rewound'
  | 'stopped'
  | 'timeout';

const reasons = new WeakMap<AbortController, AbandonReason>();

/** Signals an abandoned call's Host, keeping the first reason it was given. */
export const abandon = (
  abort: AbortController | null | undefined,
  reason: AbandonReason,
) => {
  if (!abort) {
    return;
  }
  if (!reasons.has(abort)) {
    reasons.set(abort, reason);
  }
  abort.abort();
};

/** Why a call was abandoned, if it was. */
export const abandonReason = (abort: AbortController) => reasons.get(abort);

/** Join Members neither answered nor replied to. */
export const unanswered = (members: readonly Member[]) =>
  members.filter(m => m.answer === undefined && !m.reply);

/** Abandons a Join's unanswered members in start order, returning their ids. */
export const abandonMembers = (
  members: readonly Member[],
  reason: AbandonReason,
): string[] => {
  const cut = unanswered(members);
  for (const m of cut) {
    abandon(m.abort, reason);
  }
  return cut.map(m => m.id);
};

/** The call or reply id a Run's own Wait is on, if it has one. */
export const suspensionCall = (s: Suspension | null): string | undefined =>
  s?.k === 'ask'
    ? s.call.id
    : s?.k === 'send' || s?.k === 'call-value'
      ? s.id
      : undefined;

/** Abandons a Run's own Wait on a call or reply, returning its id. */
export const abandonSuspension = (
  s: Suspension | null,
  reason: AbandonReason,
): string | undefined => {
  if (s?.k === 'ask') {
    abandon(s.abort, reason);
  }
  return suspensionCall(s);
};

/** The Group's view of a Run: `R` is its Running, `S` its Script. */
type Owner = { run: Run };

/** A `wait for`'s timers: its timeout, its `after` branches or a deadline. */
export type Waiter<R, S> = { running: R; timers: Timer<R, S>[] };

/** A suspended Join: its members, the answers in so far, and its deadline. */
export type JoinWait<R, S> = {
  answers: Map<string, Resumption>;
  deadline?: Timer<R, S>;
  members: Member[];
};

/** A timer (chapter 5, A Pump): fired in deadline order, then set order. */
export type TimerAction<R, S> =
  | { k: 'wake'; running: R; s: S }
  | { branch: number; k: 'event'; s: S; waiter: Waiter<R, S> }
  | {
      abort?: AbortController;
      /** A Timeout Block's duration, when its deadline is this call's. */
      deadline?: Value;
      id: string;
      k: 'call';
      ms: number;
    }
  /** A Timeout Block's deadline ending a wait, a `wait for` or a Join. */
  | {
      after: Value;
      join?: JoinWait<R, S>;
      k: 'deadline';
      running: R;
      s: S;
      waiter?: Waiter<R, S>;
    };

export type Timer<R, S> = {
  action: TimerAction<R, S>;
  deadline: bigint;
  live: boolean;
  running?: R;
  seq: number;
};

/** A suspended Run waiting on a call: an Operation's answer, or a reply. */
export type Pending<R, S> = {
  /** For a Join Member, its Join. */
  join?: JoinWait<R, S>;
  running: R;
  s: S;
  timer: Timer<R, S>;
};

/** A Run and its Script, as the Group lists them. */
export type Holder<R, S> = { running: R; s: S };

/** What answering a Wait did: a Run to make ready, or nothing yet. */
export type Settlement<R, S> =
  | { k: 'late' }
  | { k: 'held' }
  | { k: 'ready'; r: Resumption; running: R; s: S };

export type WaitsExport<R, S> = {
  pending: Map<string, Pending<R, S>>;
  timers: Timer<R, S>[];
  timerSeq: number;
};

export class Waits<R extends Owner, S> {
  /** The calls and replies waited on, in the order the Waits began. */
  private pending = new Map<string, Pending<R, S>>();
  private timers: Timer<R, S>[] = [];
  /** How many timers have been set: the next timer's order. */
  private timerSeq = 0;
  /** Each Script's pending `wait for`s, in the order the waits began. */
  private waiters = new Map<S, Waiter<R, S>[]>();

  /** Sets a timer. Of equal deadlines, the earlier set fires first. */
  timer(deadline: bigint, action: TimerAction<R, S>, running?: R) {
    const t = { deadline, action, live: true, seq: this.timerSeq++, running };
    this.timers.push(t);
    return t;
  }

  /** Waits on a call or reply, as a Run's own Wait or a Join Member's. */
  add(id: string, s: S, running: R, timer: Timer<R, S>, join?: JoinWait<R, S>) {
    this.pending.set(
      id,
      join ? { s, running, timer, join } : { s, running, timer },
    );
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  /** The members of a Join still waited on, in start order. */
  pendingMembers(members: readonly Member[]): Member[] {
    return members.filter(m => this.pending.has(m.id));
  }

  /**
   * Cuts a Join's still-pending members in start order, abandoning their
   * calls, and returns them (chapter 5, Joins).
   */
  cut(members: readonly Member[], reason: AbandonReason): Member[] {
    const cut = this.pendingMembers(members);
    for (const m of cut) {
      this.pending.get(m.id)!.timer.live = false;
      this.pending.delete(m.id);
      abandon(m.abort, reason);
    }
    return cut;
  }

  /**
   * Answers the Wait on `id`. A Join waits for all its members or fails
   * fast, cutting its pending siblings. A call no longer waited on may be
   * held by a preempted Join in `runs`, or is late.
   */
  settle(
    id: string,
    r: Resumption,
    runs: () => Iterable<Holder<R, S>>,
  ): Settlement<R, S> {
    const p = this.pending.get(id);
    if (!p) {
      for (const { running } of runs()) {
        if (running.run.replyToOpenJoin(id, r)) {
          return { k: 'held' };
        }
      }
      return { k: 'late' };
    }
    this.pending.delete(id);
    p.timer.live = false;
    const { s, running } = p;
    if (!p.join) {
      return { k: 'ready', s, running, r };
    }
    const { members, answers } = p.join;
    const index = members.findIndex(m => m.id === id);
    if (r.k === 'answer' || r.k === 'reply') {
      answers.set(id, r);
      members[index]!.answer = r.value;
      if (answers.size < members.length) {
        return { k: 'held' };
      }
      if (p.join.deadline) {
        p.join.deadline.live = false;
      }
      const all = members.map(m => answers.get(m.id)!);
      return { k: 'ready', s, running, r: { k: 'joined', answers: all } };
    }
    const cut = this.cut(
      members.filter(m => m.id !== id),
      'join-failed',
    );
    if (p.join.deadline) {
      p.join.deadline.live = false;
    }
    return {
      k: 'ready',
      s,
      running,
      r: {
        k: 'join-failed',
        index: index + 1,
        failure: r,
        // A member that timed out is abandoned too, first.
        abandon: [...(r.k === 'timeout' ? [id] : []), ...cut.map(m => m.id)],
      },
    };
  }

  /** Begins a `wait for`, after the Script's earlier ones. */
  addWaiter(s: S, waiter: Waiter<R, S>) {
    this.waiters.set(s, [...this.waitersOf(s), waiter]);
  }

  /** A Script's pending `wait for`s, in the order they began. */
  waitersOf(s: S): readonly Waiter<R, S>[] {
    return this.waiters.get(s) ?? [];
  }

  /**
   * Ends a `wait for` and its timers. A caller iterating `waitersOf` keeps
   * its own list, so every waiter it began with is visited.
   */
  endWaiter(s: S, waiter: Waiter<R, S>) {
    for (const t of waiter.timers) {
      t.live = false;
    }
    const kept = this.waitersOf(s).filter(w => w !== waiter);
    if (kept.length) {
      this.waiters.set(s, kept);
    } else {
      this.waiters.delete(s);
    }
  }

  /** Takes every Wait and timer of a Run out of the table. */
  forget(s: S, running: R) {
    for (const waiter of this.waitersOf(s).filter(w => w.running === running)) {
      this.endWaiter(s, waiter);
    }
    for (const timer of this.timers) {
      if (timer.running === running) {
        timer.live = false;
      }
    }
    for (const [id, p] of this.pending) {
      if (p.running === running) {
        this.pending.delete(id);
      }
    }
  }

  /**
   * The timers due at `now`, by deadline and then by the order they were
   * set. Each is taken as it is reached, so one fired earlier can end it.
   */
  *takeDue(now: bigint): Generator<Timer<R, S>> {
    const due = this.timers
      .filter(t => t.live && t.deadline <= now)
      .sort((a, b) =>
        a.deadline < b.deadline
          ? -1
          : a.deadline > b.deadline
            ? 1
            : a.seq - b.seq,
      );
    for (const t of due) {
      if (t.live) {
        t.live = false;
        yield t;
      }
    }
    this.prune();
  }

  /** The earliest deadline still pending. */
  next(): bigint | null {
    this.prune();
    return this.timers.reduce<bigint | null>(
      (min, t) => (min === null || t.deadline < min ? t.deadline : min),
      null,
    );
  }

  /**
   * The earliest deadline a suspended Run shows. A call's own deadline
   * shows only when `call` is set, inside a Timeout Block.
   */
  until(running: R, call: boolean): bigint | undefined {
    const deadlines = this.timers
      .filter(
        t =>
          t.live &&
          t.running === running &&
          (t.action.k === 'wake' ||
            t.action.k === 'event' ||
            t.action.k === 'deadline' ||
            (t.action.k === 'call' && call)),
      )
      .map(t => t.deadline);
    return deadlines.length
      ? deadlines.reduce((a, b) => (b < a ? b : a))
      : undefined;
  }

  /**
   * The Run awaiting a call: suspended on it, or preempted in the open Join
   * that started it, which a save keeps too (chapter 10, What a save holds).
   */
  awaited(
    id: string,
    runs: () => Iterable<Holder<R, S>>,
  ): Holder<R, S> | undefined {
    return this.pending.get(id) ?? this.openJoinCalls(runs).get(id);
  }

  /** Every awaited call with its Run, in Call-id order by `compare`. */
  awaitedCalls(
    runs: () => Iterable<Holder<R, S>>,
    compare: (a: string, b: string) => number,
  ): [string, Holder<R, S>][] {
    return [...this.pending, ...this.openJoinCalls(runs)].sort(([a], [b]) =>
      compare(a, b),
    );
  }

  private openJoinCalls(
    runs: () => Iterable<Holder<R, S>>,
  ): Map<string, Holder<R, S>> {
    return new Map(
      [...runs()].flatMap(({ running, s }) =>
        running.run.openJoinCalls().map(m => [m.id, { running, s }] as const),
      ),
    );
  }

  /** The table's state for a save; each Script's waiters come from `waitersOf`. */
  exportState(): WaitsExport<R, S> {
    return {
      timers: this.timers.filter(t => t.live),
      pending: this.pending,
      timerSeq: this.timerSeq,
    };
  }

  /** Restores the timer order, which a variables-only restore keeps too. */
  importTimerSeq(timerSeq: number) {
    this.timerSeq = timerSeq;
  }

  /** Restores the calls waited on and the live timers. */
  importWaits(
    pending: ReadonlyMap<string, Pending<R, S>>,
    timers: Timer<R, S>[],
  ) {
    for (const [id, p] of pending) {
      this.pending.set(id, p);
    }
    this.timers = timers;
  }

  /** Restores a Script's `wait for`s, in the order they began. */
  importWaiters(s: S, waiters: Waiter<R, S>[]) {
    if (waiters.length) {
      this.waiters.set(s, waiters);
    }
  }

  private prune() {
    this.timers = this.timers.filter(t => t.live);
  }
}
