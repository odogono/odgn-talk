// A TS Run as the save format's `run` record, and back (chapter 10, The
// save format). TS keeps some of a Run's state in another shape than the
// records: a frame's dispatch where the record has the Run's clause
// selection, and a Suspension and its timers where the record has one
// pending wait. Each is converted here.
import type { Delivery, Running, ScriptState } from './group';
import type {
  CallContext,
  CleanupControl,
  Code,
  CodePosition as RaisePosition,
  Control,
  DispatchControl,
  Frame,
  Item,
  Member,
  Resumption,
  Run,
  Search,
  Suspension,
  Then,
  WaitFor,
  RunState,
} from './machine';
import type { ObjectState } from './objects';
import type { AccountingState } from './run-accounting';
import type {
  CallRecord,
  ControlRecord,
  DeliveryRecord,
  FrameRecord,
  JoinRecord,
  MemberRecord,
  EventRecord,
  Override,
  PendingRecord,
  ResumeRecord,
  RunRecord,
  SearchRecord,
  Slot,
  Unit,
  ThenRecord,
  WaitedRecord,
} from './save-records';
import { scriptNames, unitOf, type UnitPlaces } from './save-state';
import {
  baseLengths,
  callSites,
  lastWaits,
  restOrders,
  stretchStarts,
  waitOrders,
  type WaitFields,
} from './save-marks';
import {
  bytes,
  listValues,
  map as mapValue,
  nothing as nothingValue,
  text,
  text as textValue,
  Value,
  type Value as V,
} from './values';
import { defaultLimits, msOf, type LimitName } from './machine';
import type { Body } from './code-unit';
import { ScriptError as ScriptErrorClass } from './errors';
import { subjectText as subjectUnits } from './operations';
import { property } from './operations';
import type { Waits } from './waits';

export type RunPlaces = UnitPlaces & {
  object(o: ObjectState | null | undefined): number | undefined;
};

/** What a save needs of a Group to write its Runs. */
export type RunSource = {
  accounting: AccountingState;
  scripts: readonly ScriptState[];
  waits: Waits<Running, ScriptState>;
};

const none: WaitedRecord = {
  id: '',
  block: false,
  call: undefined,
  grant: '',
  operation: '',
  declared: false,
  after: 0n,
};

/** A Duration Value as microseconds. */
export const microsOf = (after: Value): bigint => {
  const q = after.asQuantity();
  const n = (q?.number ?? after.asDecimal()!).toString();
  const unit = q?.unit ?? 'ms';
  const scale = unit === 's' || unit === 'second' || unit === 'seconds' ? 6 : 3;
  const [whole, fraction = ''] = n.replace('-', '').split('.');
  const digits = BigInt(whole! + fraction.padEnd(scale, '0').slice(0, scale));
  return n.startsWith('-') ? -digits : digits;
};

export const runRecords = (g: RunSource, places: RunPlaces) => {
  const live: { running: Running; s: ScriptState }[] = [];
  const perScript: number[] = [];
  for (const s of g.scripts) {
    const runs = [
      ...s.queue.filter((q): q is Running => 'run' in q),
      ...s.suspended,
      ...s.parked,
    ].sort((a, b) => (restOrders.get(a) ?? 0) - (restOrders.get(b) ?? 0));
    perScript.push(runs.length);
    for (const running of runs) {
      live.push({ running, s });
    }
  }
  const index = new Map<Running, number>();
  live.forEach(({ running }, i) => index.set(running, i));

  // The calls a Run still waits on, in the order they were made.
  const contexts: { ctx: CallContext; running: Running; s: ScriptState }[] = [];
  for (const { running, s } of live) {
    for (const ctx of awaitedCalls(running)) {
      contexts.push({ ctx, running, s });
    }
  }
  contexts.sort(
    (a, b) =>
      (callSites.get(a.ctx)?.order ?? 0) - (callSites.get(b.ctx)?.order ?? 0),
  );
  const callIndex = new Map<string, number>();
  const calls: CallRecord<Value>[] = contexts.map(({ ctx, running, s }, i) => {
    callIndex.set(ctx.id, i);
    const site = callSites.get(ctx);
    const [grant] = ctx.opName.split('.');
    return {
      id: ctx.id,
      script: s.name,
      grant: grant!,
      run: running.id,
      segment: site?.segment ?? '',
      now: instantOf(site?.now ?? 0n),
      args: (site?.args ?? []) as Value[],
      start: ctx.adoptable === true,
      charged: site?.charged ?? 0,
      atUnit: site?.at.unit ?? '',
      atPc: site?.at.pc ?? 0,
      atLine: site?.at.line ?? 0,
      atColumn: site?.at.col ?? 0,
    };
  });

  const writer = new RunWriter(g, places, callIndex);
  const runs = live.map(({ running, s }) => writer.run(running, s));

  // Every pending wait, in the order they began.
  const waits = live
    .flatMap(({ running }, run) => {
      const r = runs[run]!;
      return [
        ...(r.waiting
          ? [{ run, member: undefined, order: r.waiting.order }]
          : []),
        ...(r.join?.members ?? []).flatMap((m, member) =>
          m.pending ? [{ run, member, order: m.pending.order }] : [],
        ),
      ];
    })
    .sort((a, b) => a.order - b.order)
    .map(({ run, member }) => ({ run, member }));
  return { calls, index, perScript, runs, waits };
};

const instantOf = (us: bigint) => {
  let seconds = us / 1_000_000n;
  let micros = us % 1_000_000n;
  if (micros < 0n) {
    micros += 1_000_000n;
    seconds -= 1n;
  }
  return { seconds, micros: Number(micros) };
};

/** The Capability calls a Run holds: pending, or answered and not yet resumed. */
const awaitedCalls = (running: Running): CallContext[] => {
  const r = running.run.savedState();
  const out: CallContext[] = [];
  const add = (ctx: CallContext | null | undefined) => {
    if (ctx && !out.includes(ctx)) {
      out.push(ctx);
    }
  };
  for (const s of [r.suspended, r.waitedOn]) {
    if (s?.k === 'ask') {
      add(s.call);
    } else if (s?.k === 'join') {
      s.members.forEach(m => add(m.call));
    }
  }
  r.join?.members.forEach(m => add(m.call));
  const last = lastWaits.get(running);
  add(last?.waited?.call as CallContext | undefined);
  return out;
};

class RunWriter {
  /** Each shared internal value's record, made once a save. */
  private sharedItems = new Map<object, unknown>();
  private shared<T>(item: object, make: () => T): T {
    let x = this.sharedItems.get(item) as T | undefined;
    if (!x) {
      x = make();
      this.sharedItems.set(item, x);
    }
    return x;
  }

  constructor(
    private g: RunSource,
    private places: RunPlaces,
    private calls: ReadonlyMap<string, number>,
  ) {}

  private unit(script: string, code: Code) {
    return unitOf(this.places, script, code);
  }

  private slots(stack: readonly Item[]): Slot<Value>[] {
    return stack.map((item): Slot<Value> => {
      if (Value.isValue(item)) {
        return { k: 'value', value: item };
      }
      switch (item.k) {
        case 'receiver':
          return { k: 'value', value: scriptName(item.name) };
        case 'deadline':
          return { k: 'deadline', at: item.at, us: microsOf(item.after) };
        case 'iterator':
          return {
            k: 'iterator',
            it: this.shared(item, () => ({
              subject: item.source ?? undefined,
              position: item.source ? item.at : 0,
              left: item.source ? 0 : item.count - item.at,
            })),
          };
        case 'reader':
          return {
            k: 'reader',
            it: this.shared(item, () => ({
              subject: bytesValue(item.bytes),
              position: item.at,
            })),
          };
        case 'replacement':
          return {
            k: 'replacement',
            it: this.shared(item, () => {
              // The record counts in UTF-8 bytes, TS in the Text's units.
              const offsets = [0];
              for (const c of item.cs) {
                offsets.push(offsets.at(-1)! + utf8Length(c));
              }
              return {
                text: item.subject,
                matches: listOf(item.matches),
                spans: item.found.map(
                  f => [offsets[f.start]!, offsets[f.end]!] as [number, number],
                ),
                next: item.at,
                position: offsets[item.from]!,
                pieces: item.pieces,
              };
            }),
          };
      }
    });
  }

  /** Frames, each caller's pc one past its call, as the record numbers them. */
  private frames(
    script: string,
    frames: readonly Frame[],
    top: boolean,
    entry = false,
  ): FrameRecord<Value>[] {
    return frames.map((f, i) => ({
      unit: this.unit(script, f.code),
      body: f.body.index,
      pc: top && i === frames.length - 1 ? f.pc : f.pc + 1,
      locals: f.locals,
      stack: this.slots(f.stack),
      called: (!entry || i > 0) && f.dispatch !== null,
      restricted: f.restricted,
    }));
  }

  private search(s: Search): SearchRecord {
    return {
      frame: s.frame,
      entry: s.entry,
      raised: s.raised,
      limit: s.limit ?? undefined,
      position: s.position,
      skip: s.skip ?? undefined,
    };
  }

  private then(t: Then): ThenRecord<Value> {
    switch (t.k) {
      case 'accept':
        return {
          k: 'accept',
          frame: t.frame,
          pc: t.pc,
          stack: this.slots(t.stack),
        };
      case 'end':
      case 'cancel':
        return { k: t.k };
      case 'transfer':
        return {
          k: 'transfer',
          frame: t.frame,
          offerEntry: t.offerEntry,
          record: t.record,
          offer: t.offer,
          args: t.args,
          attempt: t.attempt,
          limit: t.limit ?? undefined,
        };
      case 'search':
        return { k: 'search', search: this.search(t.search) };
    }
  }

  private control(script: string, c: Control): ControlRecord<Value> {
    if (c.k === 'dispatch') {
      const d = c as DispatchControl;
      return {
        k: 'dispatch',
        error: d.error,
        owner: d.owner,
        place: d.place,
        held: this.frames(script, d.held, false),
        ownerStack: this.slots(d.ownerStack),
        ownerPc: d.ownerPc + 1,
        search: this.search(d.search),
      };
    }
    const u = c as CleanupControl;
    return {
      k: 'cleanup',
      error: u.error,
      cleanups: u.cleanups.map(x => ({ ...x })),
      next: u.next,
      left: u.left,
      failed: u.failed,
      failedFrame: u.failedFrame ?? undefined,
      held: this.frames(script, u.held, false),
      then: this.then(u.then),
    };
  }

  /** A Suspension's fields as a wait records them. */
  private waitFields(
    running: Running,
    s: Suspension,
  ): Omit<WaitedRecord, 'block' | 'after'> {
    if (s.k === 'ask') {
      const [grant, operation] = s.call.opName.split('.');
      return {
        id: s.call.id,
        call: this.calls.get(s.call.id),
        grant: grant!,
        operation: operation!,
        declared: true,
      };
    }
    void running;
    return {
      id: s.k === 'send' || s.k === 'call-value' ? s.id : '',
      call: undefined,
      grant: '',
      operation: '',
      declared: false,
    };
  }

  /** A suspended Run's own wait. */
  private pending(
    running: Running,
    s: Suspension,
  ): PendingRecord<Value> | undefined {
    const r = running.run.savedState();
    if (s.k === 'join') {
      const w = lastWaits.get(running)?.waiting;
      return w && s.deadline
        ? {
            ...w,
            call: undefined,
            deadline: s.deadline.at,
            order: waitOrders.get(running) ?? 0,
            member: undefined,
            branch: 0,
            event: undefined,
          }
        : undefined;
    }
    const timers = this.g.waits
      .exportState()
      .timers.filter(t => t.running === running && t.action.k !== 'call')
      .concat(
        this.g.waits
          .exportState()
          .timers.filter(
            t =>
              t.running === running &&
              t.action.k === 'call' &&
              t.action.id === this.waitFields(running, s).id,
          ),
      );
    const deadlineTimer = timers.find(
      t =>
        t.action.k === 'deadline' ||
        (t.action.k === 'call' && t.action.deadline !== undefined),
    );
    const own = timers.filter(t => t !== deadlineTimer);
    const earliest = own.reduce<(typeof own)[number] | undefined>(
      (min, t) => (!min || t.deadline < min.deadline ? t : min),
      undefined,
    );
    const block = !!deadlineTimer;
    const deadline = deadlineTimer?.deadline ?? earliest?.deadline;
    let after = 0n;
    let branch = 0;
    if (block) {
      after = microsOf(s.deadline!.after);
    } else if (s.k === 'ask') {
      after = BigInt(s.ms) * 1000n;
    } else if (s.k === 'send' || s.k === 'call-value') {
      after = BigInt(r.limits.maxWaitMs) * 1000n;
    } else if (s.k === 'wait-for' && earliest?.action.k === 'event') {
      branch = earliest.action.branch;
    }
    const fields = this.waitFields(running, s);
    return {
      ...fields,
      id: s.k === 'ask' ? '' : fields.id,
      deadline,
      order: waitOrders.get(running) ?? 0,
      after,
      member: undefined,
      block,
      branch,
      event: s.k === 'wait-for' ? this.event(running, s) : undefined,
    };
  }

  private event(running: Running, s: WaitFor) {
    const timers = this.g.waits
      .exportState()
      .timers.filter(t => t.running === running && t.action.k === 'event');
    const branches = new Map<
      number,
      { at: bigint } | { captures: V[]; from: V | undefined }
    >();
    for (const w of s.whens) {
      branches.set(w.branch, {
        from:
          w.from === null
            ? undefined
            : typeof w.from === 'string'
              ? scriptName(w.from)
              : w.from,
        captures: w.captures,
      });
    }
    for (const a of s.afters) {
      const t = timers.find(
        t => t.action.k === 'event' && t.action.branch === a.branch,
      );
      branches.set(a.branch, { at: t?.deadline ?? 0n });
    }
    return {
      unit: this.unit(running.run.script.name, s.code),
      entry: eventEntry(running),
      any: s.any,
      branches: [...branches]
        .sort(([a], [b]) => a - b)
        .map(([, b]) =>
          'at' in b
            ? { k: 'after' as const, at: b.at }
            : { k: 'when' as const, from: b.from, captures: b.captures },
        ),
    };
  }

  private join(running: Running, r: RunState): JoinRecord<Value> | undefined {
    const join = r.join;
    if (!join) {
      return undefined;
    }
    const at = (f: Frame) => r.frames.indexOf(f);
    const table = [...this.g.waits.exportState().pending.values()].find(
      p => p.running === running && p.join,
    )?.join;
    const failed = r.resumption?.k === 'join-failed' ? r.resumption : undefined;
    const suspended = r.suspended?.k === 'join';
    const ready = !!r.resumption;
    return {
      frame: at(join.frame),
      start: join.start,
      members: join.members.map((m, i): MemberRecord<Value> => {
        const [grant, operation] = m.call ? m.call.opName.split('.') : ['', ''];
        const call = m.call ? this.calls.get(m.id) : undefined;
        const settled =
          failed && i === failed.index - 1
            ? failed.failure
            : (table?.answers.get(m.id) ?? m.reply ?? null);
        const waiting = ready
          ? false
          : suspended
            ? this.g.waits.has(m.id)
            : !m.reply && m.answer === undefined;
        return {
          frame: at(m.site.frame),
          start: m.site.pc,
          pending: waiting
            ? {
                id: m.call ? '' : m.id,
                deadline: m.at,
                order: waitOrders.get(m) ?? 0,
                call,
                grant: grant!,
                operation: operation!,
                declared: !!m.call,
                after: BigInt(m.ms) * 1000n,
                member: i,
                block: false,
                branch: 0,
                event: undefined,
              }
            : undefined,
          waited: {
            id: m.id,
            block: false,
            call,
            grant: grant!,
            operation: operation!,
            declared: !!m.call,
            after: BigInt(m.ms) * 1000n,
          },
          with: this.resume(settled),
          cut:
            !!failed && i !== failed.index - 1 && failed.abandon.includes(m.id),
        };
      }),
    };
  }

  private waited(w: WaitFields): WaitedRecord {
    return {
      id: w.id,
      block: w.block,
      call:
        w.call === undefined
          ? undefined
          : this.calls.get((w.call as CallContext).id),
      grant: w.grant,
      operation: w.operation,
      declared: w.declared,
      after: w.after,
    };
  }

  private resume(r: Resumption | null): ResumeRecord<Value> {
    if (!r) {
      return { k: 'none' };
    }
    switch (r.k) {
      case 'wake':
        return { k: 'woke' };
      case 'restore-fail':
        return { k: r.code === 'call lost' ? 'lost' : 'revoked' };
      case 'answer':
        return { k: 'answer', value: r.value, fuel: r.fuel };
      case 'fail':
        return r.error
          ? {
              k: 'failed',
              failure: {
                code: r.error.code,
                message: r.error.message || undefined,
                data: Value.isValue(r.error.data) ? r.error.data : undefined,
              },
            }
          : { k: 'broken', detail: r.detail };
      case 'timeout':
      case 'deadline':
        return { k: 'timeout' };
      case 'reply':
        return { k: 'reply', value: r.value };
      case 'send failed':
        return {
          k: 'send failed',
          reason: r.reason,
          error: r.error ?? undefined,
        };
      case 'joined':
        return { k: 'joined' };
      case 'event':
        return {
          k: 'event',
          message: r.message,
          branch: r.branch,
          binds: r.binds,
        };
      case 'event-timeout':
        return { k: 'event', message: undefined, branch: r.branch, binds: 0 };
      case 'join-failed':
        return { k: 'join failed', member: r.index - 1 };
    }
  }

  run(running: Running, s: ScriptState): RunRecord<Value> {
    const r = running.run.savedState();
    const row = this.g.accounting.runs.get(running.id);
    const first = r.frames[0];
    const d = first?.dispatch ?? null;
    const selecting = !!d && !running.selected && !running.delivery.fn;
    const last = lastWaits.get(running);
    const sus = r.suspended;
    // A Run at a Suspension Point, or ready to resume from one, is one past
    // its suspending instruction; a parked Run is at its first.
    const waited = !!sus || !!r.waitedOn;
    const ended =
      waited || running.parked === true || (running.resuming && !r.resumption);
    const named = s.loaded.clauses.get(running.delivery.message)?.length ?? 0;
    return {
      id: running.id,
      order: row?.order ?? 0,
      reportedFuel: row?.reportedFuel,
      fuel: r.fuel,
      alloc: r.alloc,
      // A clause that took the Decision holds its Verdict, which its
      // Delivery no longer carries.
      delivery: {
        ...deliveryOf(running.delivery, this.places),
        ...(r.openVerdict || running.selected ? { decision: false } : {}),
      },
      handler: running.delivery.fn ? '' : running.delivery.message,
      clause: r.clause,
      limits: limitList(r.limits),
      // The clause rate the next instruction pays: the entry clause's, or a
      // Command Call's clause's, preempted before its first instruction.
      clauseFuel: r.frames.at(-1)?.clauseCharge ? 4 : 0,
      preemptedIn:
        selecting && running.resuming === false && !sus
          ? {
              body: {
                unit: this.unit(s.name, first!.code),
                body: first!.body.index,
              },
              fallback: r.viaFallback,
            }
          : undefined,
      continuing: !running.resuming && !sus && !running.parked,
      clausesSeen: d ? (r.viaFallback ? named : d.next) : 0,
      cleanupFrom: r.cleanupFrom ?? undefined,
      cleanupLimited: false,
      controls: r.controls.map(c => this.control(s.name, c)),
      attempts: r.offerAttempt,
      calls: r.calls,
      segmentFuel: stretchStarts.get(running)?.fuel ?? r.fuel,
      segmentAlloc: stretchStarts.get(running)?.alloc ?? r.alloc,
      started: true,
      waiting: sus ? this.pending(running, sus) : undefined,
      resumeWith: running.parked
        ? { k: 'none' }
        : running.resuming && !r.resumption && !r.waitedOn
          ? { k: 'unparked' }
          : this.resume(r.resumption),
      suspendedAt: last?.suspendedAt ?? '',
      waited: last?.waited ? this.waited(last.waited) : none,
      raisedAt: r.raisedAt
        ? { line: r.raisedAt.line, column: r.raisedAt.col }
        : undefined,
      join: this.join(running, r),
      clauseBody:
        d && !running.delivery.fn
          ? { unit: this.unit(s.name, first!.code), body: first!.body.index }
          : undefined,
      fallback: r.viaFallback,
      selectAt: selecting ? first!.body.acceptedAt : undefined,
      parked: running.parked === true,
      abandoned: [...r.cancellationAbandons],
      base: 0,
      segments: ended ? r.segment : r.segment - 1,
      verdict: r.openVerdict,
      segmentBase: r.segmentBase.slice(
        0,
        baseLengths.get(r.segmentBase) ?? r.segmentBase.length,
      ),
      frames: this.frames(s.name, r.frames, !waited, true),
    };
  }
}

const encoder = new TextEncoder();
const utf8Length = (s: string) => encoder.encode(s).length;

const scriptName = (name: string) => {
  const v = text(name);
  scriptNames.add(v);
  return v;
};

const bytesValue = (b: Uint8Array) => bytes(b);
const listOf = (vs: readonly Value[]) => listValues(vs);
const eventEntry = (running: Running) => {
  const f = running.run.savedState().frames.at(-1)!;
  return f.code.unit.code[f.pc]!.operands[0] as number;
};
export const limitNames = Object.keys(defaultLimits) as LimitName[];
const limitList = (l: Run['limits']) => limitNames.map(n => l[n]);
const deliveryNumber = (id: string | null | undefined) =>
  id ? Number(id.slice(1)) : 0;

const override = (limits: Delivery['limits']): Override | undefined =>
  Object.keys(limits).length
    ? {
        fuelPerRun: limits.fuelPerRun,
        allocPerRun: limits.allocPerRun,
        maxWaitMs: limits.maxWaitMs,
        maxJoin: limits.maxJoin,
      }
    : undefined;
export { override as overrideRecord, deliveryNumber };

export const deliveryRecord = (
  d: Delivery,
  ref: (o: ObjectState | null | undefined) => number | undefined,
): DeliveryRecord<Value> => {
  const root = d.ancestry?.rootDelivery;
  return {
    id: deliveryNumber(d.id),
    root: root && root !== d.id ? deliveryNumber(root) : 0,
    message: d.message,
    args: d.args,
    request: d.request !== null,
    during: d.during,
    from: d.from ?? undefined,
    internalError: d.during !== undefined,
    waits: d.reply !== null,
    target: d.path ? ref(d.target) : undefined,
    at: d.path ? ref(d.path.after ? d.at : d.path.from) : undefined,
    function: d.fn,
    decision: !!d.ballot && !d.ballot.result,
    decides: !!d.ballot,
    broadcast: deliveryNumber(d.broadcast),
    limits: override(d.limits),
    passedBy: d.path?.after ? ref(d.path.from) : undefined,
  };
};
const deliveryOf = (d: Delivery, places: RunPlaces) =>
  deliveryRecord(d, o => places.object(o));

// ------------------------------------------------------------------ restoring

/** What a restore gives a Run's record to rebuild it against. */
export type RunContext = {
  /** The call a record names, as its Run's context. */
  call(i: number): CallContext;
  /** A unit's code, relative to the Run's Script. */
  code(unit: Unit): Code;
  /** The objects a Delivery names. */
  delivery(d: DeliveryRecord<Value>): Delivery;
  invalid(): never;
  /** The Run, made for its Script. */
  make(): Run;
  /** The Group's Clock reading when it was saved. */
  now: bigint;
  script: ScriptState;
};

/** A restored Run and what its waits need. */
export type Restored = {
  /** Its own wait's call id, for a Capability call or a reply. */
  pendingId?: string;
  record: RunRecord<Value>;
  running: Running;
};

const rangeLength = (v: Value) =>
  BigInt(property('length', v).asDecimal()!.toString());

const handlerName = (body: Body) =>
  body.kind === 'lambda' ? body.name.replace(/(?::\d+:\d+)+$/, '') : body.name;

const resumptionOf = (
  r: ResumeRecord<Value>,
  ctx: RunContext,
  extra: {
    abandon?: string[];
    after?: bigint;
    block?: boolean;
    members?: Member[];
    resumptions?: Resumption[];
    timeoutKind?: 'call' | 'deadline';
  } = {},
): Resumption | null => {
  switch (r.k) {
    case 'none':
    case 'unparked':
    case 'cancelled':
      return null;
    case 'woke':
      return { k: 'wake' };
    case 'lost':
      return { k: 'restore-fail', code: 'call lost' };
    case 'revoked':
      return { k: 'restore-fail', code: 'capability revoked' };
    case 'answer':
      return { k: 'answer', value: r.value, fuel: r.fuel };
    case 'failed':
      return {
        k: 'fail',
        error: new ScriptErrorClass(
          r.failure.code,
          r.failure.message ?? '',
          r.failure.data ?? nothingValue,
        ),
      };
    case 'broken':
      return {
        k: 'fail',
        error: null,
        ...(r.detail === undefined ? {} : { detail: r.detail }),
      };
    case 'timeout':
      return extra.timeoutKind === 'deadline'
        ? {
            k: 'deadline',
            after: msOf(extra.after ?? 0n),
            abandon: extra.abandon ?? [],
          }
        : {
            k: 'timeout',
            after: Number((extra.after ?? 0n) / 1000n),
            ...(extra.block ? { deadline: msOf(extra.after ?? 0n) } : {}),
          };
    case 'reply':
      return { k: 'reply', value: r.value };
    case 'send failed':
      return { k: 'send failed', reason: r.reason, error: r.error ?? null };
    case 'joined':
      return { k: 'joined', answers: extra.resumptions ?? [] };
    case 'event':
      return r.message === undefined
        ? { k: 'event-timeout', branch: r.branch }
        : {
            k: 'event',
            branch: r.branch,
            message: r.message,
            binds: r.binds,
          };
    case 'join failed': {
      const failure = extra.resumptions?.[r.member];
      return failure
        ? {
            k: 'join-failed',
            index: r.member + 1,
            failure,
            abandon: extra.abandon ?? [],
          }
        : ctx.invalid();
    }
    case 'limited':
      return ctx.invalid();
  }
};

/** A Run from its record, against its Script's code as restored. */
export const runFromRecord = (
  rec: RunRecord<Value>,
  ctx: RunContext,
): Restored => {
  const { script: s } = ctx;
  const bad = (ok: unknown) => (ok ? undefined : ctx.invalid());
  const waited =
    rec.waiting !== undefined ||
    (rec.resumeWith.k !== 'none' &&
      rec.resumeWith.k !== 'unparked' &&
      rec.resumeWith.k !== 'cancelled') ||
    (rec.join !== undefined &&
      rec.suspendedAt === 'join-end' &&
      !rec.continuing &&
      !rec.parked);
  const items = new Map<object, Item>();
  const item = (slot: Slot<Value>): Item => {
    switch (slot.k) {
      case 'value':
        return scriptNames.has(slot.value)
          ? { k: 'receiver', name: slot.value.asText()! }
          : slot.value;
      case 'deadline':
        return { k: 'deadline', at: slot.at, after: msOf(slot.us) };
      default: {
        const known = items.get(slot.it);
        if (known) {
          return known;
        }
        let made: Item;
        if (slot.k === 'iterator') {
          const it = slot.it;
          const source = it.subject ?? null;
          made = {
            k: 'iterator',
            source,
            at: source ? it.position : 0,
            count: source
              ? source.kind === 'list'
                ? source.length
                : Number(rangeLength(source))
              : it.left,
          };
          bad(!source || made.at <= made.count);
        } else if (slot.k === 'reader') {
          const b = slot.it.subject.bytesView();
          bad(b && slot.it.position <= b.length);
          made = { k: 'reader', bytes: b!, at: slot.it.position };
        } else {
          const x = slot.it;
          const subject = x.text;
          bad(subject.kind === 'text' && x.matches.kind === 'list');
          const cs = subjectUnits(subject);
          const units = new Map<number, number>([[0, 0]]);
          let at = 0;
          cs.forEach((c, i) => {
            at += utf8Length(c);
            units.set(at, i + 1);
          });
          const unit = (byte: number) => units.get(byte) ?? ctx.invalid();
          const matches = Array.from({ length: x.matches.length }, (_, i) =>
            x.matches.index(i + 1),
          );
          bad(x.spans.length === matches.length && x.next <= matches.length);
          made = {
            k: 'replacement',
            subject,
            cs,
            found: x.spans.map(([a, b]) => ({ start: unit(a), end: unit(b) })),
            matches,
            at: x.next,
            pieces: x.pieces,
            from: unit(x.position),
          };
        }
        items.set(slot.it, made);
        return made;
      }
    }
  };
  const frame = (f: FrameRecord<Value>, shifted: boolean): Frame => {
    const code = ctx.code(f.unit);
    const body = code.unit.bodies[f.body] ?? ctx.invalid();
    const pc = shifted ? f.pc - 1 : f.pc;
    bad(
      pc >= body.start &&
        pc < body.end &&
        f.locals.length === body.locals.length,
    );
    return {
      body,
      clauseCharge: false,
      code,
      dispatch: f.called ? calledDispatch(code, body, f.locals) : null,
      handler: handlerName(body),
      locals: [...f.locals],
      pc,
      restricted: f.restricted,
      stack: f.stack.map(item),
    };
  };
  const frames = rec.frames.map((f, i) =>
    frame(f, i < rec.frames.length - 1 || waited),
  );
  const held = (fs: readonly FrameRecord<Value>[]) =>
    fs.map(f => frame(f, true));
  // eslint-disable-next-line unicorn/consistent-function-scoping -- Kept beside the other record conversions it pairs with.
  const search = (x: SearchRecord): Search => ({
    frame: x.frame,
    entry: x.entry,
    raised: x.raised,
    limit: x.limit ?? null,
    position: x.position,
    skip: x.skip ?? null,
  });
  const controls: Control[] = rec.controls.map((c): Control => {
    if (c.k === 'dispatch') {
      return {
        k: 'dispatch',
        error: c.error,
        owner: c.owner,
        place: c.place,
        held: held(c.held),
        ownerStack: c.ownerStack.map(item),
        ownerPc: c.ownerPc - 1,
        search: search(c.search),
      };
    }
    const t = c.then;
    const then: Then =
      t.k === 'accept'
        ? { k: 'accept', frame: t.frame, pc: t.pc, stack: t.stack.map(item) }
        : t.k === 'transfer'
          ? {
              k: 'transfer',
              frame: t.frame,
              offerEntry: t.offerEntry,
              record: t.record,
              offer: t.offer,
              args: t.args,
              attempt: t.attempt,
              limit: t.limit ?? null,
            }
          : t.k === 'search'
            ? { k: 'search', search: search(t.search) }
            : { k: t.k };
    return {
      k: 'cleanup',
      error: c.error,
      cleanups: c.cleanups.map(x => ({ ...x })),
      next: c.next,
      left: c.left,
      failed: c.failed,
      failedFrame: c.failedFrame ?? null,
      held: held(c.held),
      then,
    };
  });

  const delivery = ctx.delivery(rec.delivery);
  const run = ctx.make();
  const r = run.savedState();
  const first = frames[0];
  // The entry dispatch: the clause it is in, and those it would try next.
  if (first && rec.clauseBody && !delivery.fn) {
    const named = s.loaded.clauses.get(delivery.message) ?? [];
    const fallbacks = s.loaded.fallback;
    const args = rec.fallback
      ? [
          mapValue([
            ['name', textValue(delivery.message)],
            ['args', listValues(delivery.args)],
          ]),
        ]
      : delivery.args;
    first.dispatch = {
      args,
      clauses: rec.fallback ? fallbacks : named,
      code: first.code,
      next: rec.fallback ? fallbacks.indexOf(first.body) + 1 : rec.clausesSeen,
      ...(!rec.fallback &&
      !delivery.during &&
      !delivery.ballot &&
      !delivery.broadcast &&
      fallbacks.length
        ? { fallback: { clauses: fallbacks, selector: delivery.message } }
        : {}),
    };
    bad(first.dispatch.next > 0);
  }
  const charged = frames.at(-1);
  if (charged && rec.clauseFuel > 0) {
    bad(charged.dispatch !== null);
    charged.clauseCharge = true;
  }
  r.frames = frames;
  r.controls = controls;
  r.fuel = rec.fuel;
  r.alloc = rec.alloc;
  r.clause = rec.clause;
  r.viaFallback = rec.fallback;
  r.cleanupFrom = rec.cleanupFrom ?? null;
  r.offerAttempt = rec.attempts;
  r.calls = rec.calls;
  const ended =
    waited ||
    rec.parked ||
    rec.resumeWith.k === 'unparked' ||
    rec.resumeWith.k === 'cancelled';
  r.segment = ended ? rec.segments : rec.segments + 1;
  bad(r.segment >= 1);
  r.openVerdict = rec.verdict;
  r.cancellationAbandons = [...rec.abandoned];
  r.faultAbandons = [];
  r.abandoning = [];
  r.during = delivery.during ?? nothingValue;
  r.target = delivery.fn
    ? nothingValue
    : ((delivery.target ?? s.owner)?.handle.value ?? nothingValue);
  r.segmentBase = [...(rec.segmentBase ?? s.loaded.variables)];
  if (r.segmentBase.length < s.loaded.variables.length) {
    // An extension's variables since the Segment began roll back to their
    // first values, as the TS Core pads the base when it loads one.
    const padded = r.segmentBase.length;
    r.segmentBase.push(...initialVariables(s).slice(padded));
    baseLengths.set(r.segmentBase, padded);
  }
  r.raisedAt = rec.raisedAt ? raisedAtOf(rec, frames, controls) : null;
  r.records = [];

  // Its Join: the frame that started it and each member's call and result.
  const memberResumptions: Resumption[] = [];
  if (rec.join) {
    const j = rec.join;
    const joinFrame = frames[j.frame] ?? ctx.invalid();
    const suspendedAtEnd =
      !!rec.waiting || (!rec.continuing && rec.suspendedAt === 'join-end');
    const members: Member[] = j.members.map((m, i) => {
      const call = m.waited.call === undefined ? null : ctx.call(m.waited.call);
      const settled = resumptionOf(m.with, ctx);
      const ms = Number(m.waited.after / 1000n);
      const member: Member = {
        site: { frame: frames[m.frame] ?? ctx.invalid(), pc: m.start },
        id: m.waited.id,
        call,
        abort: call ? new AbortController() : null,
        ms,
        at: m.pending?.deadline ?? ctx.now + BigInt(ms) * 1000n,
      };
      if (m.pending) {
        waitOrders.set(member, m.pending.order);
      }
      if (settled) {
        memberResumptions[i] = settled;
        if (settled.k === 'answer' || settled.k === 'reply') {
          member.answer = settled.value;
        }
        if (!suspendedAtEnd) {
          member.reply = settled;
        }
      }
      return member;
    });
    r.join = {
      frame: joinFrame,
      members,
      start: j.start,
    };
  }
  const cut = rec.join
    ? rec.join.members.flatMap((m, i) =>
        m.cut ? [r.join!.members[i]!.id] : [],
      )
    : [];

  // The wait it is suspended in, or the one it resumes from.
  const top = frames.at(-1);
  const blockOf = () => {
    const stack = top?.stack ?? [];
    for (let i = stack.length - 1; i >= 0; i--) {
      const x = stack[i]!;
      if (!Value.isValue(x) && x.k === 'deadline') {
        return x;
      }
    }
    return undefined;
  };
  const suspension = (
    at: string,
    w: WaitedRecord,
    event?: EventRecord<Value>,
  ): Suspension => {
    const block = w.block ? blockOf() : undefined;
    const withBlock = <S extends object>(x: S) =>
      (block ? { ...x, deadline: block } : x) as Suspension;
    switch (at) {
      case 'wait':
        return withBlock({ k: 'wait', us: 0n });
      case 'ask-wait': {
        const call = w.call === undefined ? ctx.invalid() : ctx.call(w.call);
        return withBlock({
          k: 'ask',
          call,
          abort: new AbortController(),
          ms: w.block
            ? call.op.mode === 'suspending'
              ? (call.op.maxPendingMs ?? r.limits.maxWaitMs)
              : 0
            : Number(w.after / 1000n),
        });
      }
      case 'send-wait':
        return withBlock({
          k: 'send',
          id: w.id,
          to: '',
          message: '',
          args: [],
        });
      case 'call-value-wait':
        return withBlock({
          k: 'call-value',
          id: w.id,
          to: '',
          fn: nothingValue,
          args: [],
        });
      case 'join-end':
        return withBlock({
          k: 'join',
          members: r.join?.members ?? ctx.invalid(),
        });
      case 'wait-for':
      case 'wait-for-any': {
        bad(top);
        const ins = top!.code.unit.code[top!.pc];
        const entryIndex = event?.entry ?? (ins?.operands[0] as number);
        const entry = top!.code.unit.events[entryIndex] ?? ctx.invalid();
        bad(!event || event.branches.length === entry.branches.length);
        const sus: WaitFor = {
          code: top!.code,
          k: 'wait-for',
          any: at === 'wait-for-any',
          whens: [],
          afters: [],
          timeout: entry.timeout ? 0n : null,
        };
        entry.branches.forEach((br, n) => {
          const saved = event?.branches[n];
          if (br.kind === 'after') {
            bad(!saved || saved.k === 'after');
            sus.afters.push({ branch: n + 1, us: 0n });
            return;
          }
          bad(!saved || saved.k === 'when');
          const from =
            saved?.k === 'when' && saved.from
              ? scriptNames.has(saved.from)
                ? saved.from.asText()!
                : saved.from
              : null;
          sus.whens.push({
            branch: n + 1,
            message: br.message,
            from,
            body: br.body,
            binds: br.binds,
            captures: saved?.k === 'when' ? saved.captures : [],
          });
        });
        return withBlock(sus);
      }
      default:
        return ctx.invalid();
    }
  };
  let pendingId: string | undefined;
  if (rec.waiting) {
    const w = rec.waiting;
    const at = rec.suspendedAt;
    r.suspended = suspension(at, w, w.event);
    pendingId = w.call === undefined ? w.id || undefined : ctx.call(w.call).id;
  } else if (
    rec.join &&
    !rec.continuing &&
    !rec.parked &&
    rec.suspendedAt === 'join-end' &&
    rec.resumeWith.k === 'none'
  ) {
    r.suspended = suspension('join-end', rec.waited);
  }
  if (!rec.waiting && waited && rec.resumeWith.k !== 'none') {
    const w = rec.waited;
    const s0 = suspension(rec.suspendedAt, w);
    r.waitedOn = s0;
    const timeoutKind =
      s0.k === 'ask' || s0.k === 'send' || s0.k === 'call-value'
        ? 'call'
        : 'deadline';
    r.resumption = resumptionOf(rec.resumeWith, ctx, {
      after: w.after,
      block: w.block,
      timeoutKind,
      abandon:
        rec.resumeWith.k === 'join failed'
          ? [
              ...(memberResumptions[rec.resumeWith.member]?.k === 'timeout'
                ? [r.join!.members[rec.resumeWith.member]!.id]
                : []),
              ...cut,
            ]
          : cut,
      resumptions: memberResumptions,
    });
  }
  // A Capability call it waits on keeps its record, for its arguments.
  for (const ctxCall of [
    r.suspended?.k === 'ask' ? r.suspended.call : null,
    ...(r.join?.members.map(m => m.call) ?? []),
  ]) {
    if (ctxCall) {
      const site = callSites.get(ctxCall);
      r.records.push({
        kind: 'call',
        id: ctxCall.id,
        op: ctxCall.opName,
        args: [...((site?.args ?? []) as Value[])],
        charged: site?.charged ?? 0,
      });
    }
  }

  const running: Running = {
    id: rec.id,
    delivery,
    run,
    resuming:
      !rec.continuing &&
      !rec.waiting &&
      !rec.parked &&
      rec.resumeWith.k !== 'none'
        ? true
        : rec.resumeWith.k === 'unparked' || rec.resumeWith.k === 'cancelled',
    ...(rec.parked ? { parked: true } : {}),
    ...(rec.resumeWith.k === 'cancelled' ? { cleanupReady: true } : {}),
    ...(rec.clauseBody && rec.selectAt === undefined ? { selected: true } : {}),
    recordsWritten: r.records.length,
  };
  run.restoreState(r);
  run.id = rec.id;
  if (rec.waiting) {
    waitOrders.set(running, rec.waiting.order);
  }
  stretchStarts.set(running, {
    fuel: rec.segmentFuel,
    alloc: rec.segmentAlloc,
  });
  lastWaits.set(running, {
    suspendedAt: rec.suspendedAt,
    waited:
      rec.waited.id ||
      rec.waited.call !== undefined ||
      rec.waited.after !== 0n ||
      rec.waited.block
        ? waitFieldsOf(rec.waited, ctx)
        : undefined,
    ...(rec.waiting ? { waiting: waitFieldsOf(rec.waiting, ctx) } : {}),
  });
  return { running, record: rec, ...(pendingId ? { pendingId } : {}) };
};

// A pending call's record leaves its id to its call.
const waitFieldsOf = (w: WaitedRecord, ctx: RunContext): WaitFields => ({
  id: w.id || (w.call === undefined ? '' : ctx.call(w.call).id),
  block: w.block,
  ...(w.call === undefined ? {} : { call: ctx.call(w.call) }),
  grant: w.grant,
  operation: w.operation,
  declared: w.declared,
  after: w.after,
});

/** A Command Call's frame's dispatch: its Handler's clauses after this one. */
const calledDispatch = (code: Code, body: Body, locals: readonly Value[]) => {
  const clauses = code.clauses.get(body.name) ?? [];
  return {
    args: locals.slice(1, body.params.length + 1),
    clauses,
    code,
    next: clauses.indexOf(body) + 1,
  };
};

/** Where its current error was raised: its line and column, and the frame. */
const raisedAtOf = (
  rec: RunRecord<Value>,
  frames: readonly Frame[],
  controls: readonly Control[],
): RaisePosition => {
  const c = controls.at(-1);
  const f = c?.held.at(-1) ?? frames.at(-1)!;
  return {
    unit: f.code.name,
    handler: f.handler,
    pc: c?.k === 'dispatch' ? c.place : f.pc,
    line: rec.raisedAt!.line,
    col: rec.raisedAt!.column,
  };
};

let initialVariables: (s: ScriptState) => readonly Value[] = s =>
  s.loaded.variables;
export const setInitialVariables = (f: typeof initialVariables) => {
  initialVariables = f;
};
