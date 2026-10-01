// The embedding interface's Group (chapter 9) for the Core's implemented
// subset: Load, Deliver and Request to a Script, Pump with Fuel Slices and a
// Fuel cap, and Inspect, writing chapter 11's Trace as it goes. Turns follow
// chapter 5's scheduler.
import { sizeOf, partSize } from './costs';
import {
  HostError,
  LoadError,
  MailboxFull,
  ScriptError,
  type HostErrorCode,
  type ScriptError as HostScriptError,
} from './errors';
import { formatInstant } from './dates';
import { lowerTree } from './lowering';
import {
  defaultLimits,
  deliver as dispatch,
  loadScript,
  type LimitName,
  type Limits,
  type Outcome,
  type Member,
  type Resumption,
  type Run,
  type RunHost,
  type Suspension,
  type Script as Loaded,
} from './machine';
import type { Grant } from './capabilities';
import {
  makeObject,
  stateOf,
  type HostObject,
  type ObjectKind,
  type ObjectState,
} from './objects';
import type { GrantDecls } from './effects';
import { NotImplementedError } from './operations';
import {
  identityOf,
  linksOf,
  loadOrReject,
  prepare,
  stdlibNames,
  type Library,
} from './library';
import { idList, recordLine, traceValue } from './trace';
import { ScriptError as OpScriptError } from './operations';
import { listValues, map, nothing, text, Value } from './values';

export type GroupOptions = {
  name: string;
  /** Receives each Trace line, without its LF. */
  trace?: (line: string) => void;
};
export type LoadOptions = {
  /** Its Grants, by the name the Script uses for each. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Grant of any binding, as talk.ts has it.
  grants?: Readonly<Record<string, Grant<any>>>;
  limits?: Partial<Limits>;
  name: string;
  /** Its well-known Host Objects, by the name the Script uses. */
  objects?: Readonly<Record<string, HostObject>>;
  /** The Host Object it owns: the start of its Message Path. */
  owner?: HostObject;
  source: string;
};
export type LimitOverride = Partial<
  Pick<Limits, 'fuelPerRun' | 'allocPerRun' | 'maxWaitMs' | 'maxJoin'>
>;
export type Message = { args?: Value[]; limits?: LimitOverride; name: string };
export type Verdict = 'allowed' | 'vetoed' | 'undecided';
export type Decided = {
  broadcast?: string;
  delivery?: string;
  undecided: { outcome: RunOutcome; run?: string; script: string }[];
  verdict: Verdict;
  vetoes: { reason: Value; run: string; script: string }[];
};
export type Deciding = { decided: Promise<Decided>; id: string };
export type Requested = { id: string; result: Promise<Value> };
export type PumpOptions = { fuelCap?: number; fuelSlice?: number };
export type RunOutcome =
  | 'completed'
  | 'errored'
  | 'limit fault'
  | 'cancelled'
  | 'unhandled'
  | 'dropped';
export type Report =
  | {
      alloc: number;
      broadcast?: string;
      delivery?: string;
      error?: Value;
      fuel: number;
      handler?: string;
      kind: 'run end';
      limit?: string;
      outcome: RunOutcome;
      result?: Value;
      run?: string;
      script: string;
    }
  | { delivery: string; kind: 'unhandled'; message: Message }
  | ({ kind: 'decided' } & Decided);
export type PumpResult = {
  fuelUsed: number;
  reports: Report[];
  state: 'idle' | 'sliced' | 'stopped';
};
export type Inspection = {
  scripts: {
    /** A Delivery's id, or for a message a Script sent, the sending Run. */
    mailbox: {
      delivery: string | null;
      from: string | null;
      message: Message;
    }[];
    name: string;
    runs: {
      handler: string;
      id: string;
      status: 'preempted' | 'ready' | 'suspended';
    }[];
    vars: [string, Value][];
  }[];
};

// The Trace's names for the limits a Limit Fault can pass (chapter 11).
const faultNames: Partial<Record<LimitName, string>> = {
  fuelPerRun: 'fuel',
  allocPerRun: 'alloc',
  persistentState: 'persistent',
  callDepth: 'depth',
  patternSize: 'pattern',
  maxJoin: 'join',
};
const overridable = new Set([
  'fuelPerRun',
  'allocPerRun',
  'maxWaitMs',
  'maxJoin',
]);

type Decision = {
  ballots: Ballot[];
  broadcast: boolean;
  id: string;
  resolve: (v: Decided) => void;
};
type Ballot = {
  decision: Decision;
  result?: {
    undecided?: Decided['undecided'][number];
    verdict: Verdict;
    veto?: Decided['vetoes'][number];
  };
};
type Delivery = {
  args: Value[];
  /** The object whose Owning Script holds it, which it climbs on from. */
  at: ObjectState | null;
  ballot?: Ballot;
  broadcast?: string;
  /** The failed message, for an internal `error` Delivery. */
  during?: Value;
  /** For a message a Script sent, the sending Run. */
  from: string | null;
  /** The delivery id; a message a Script sent has none. */
  id: string | null;
  limits: LimitOverride;
  message: string;
  /** For a `send … and wait`, the sender's call id, which the Run's end settles. */
  reply: string | null;
  request: { reject: (e: Error) => void; resolve: (v: Value) => void } | null;
  /** The object it was addressed to: `the target` all the way up. */
  target: ObjectState | null;
};
type Running = {
  delivery: Delivery;
  id: string;
  /** Ready to resume from a Suspension Point, not a preemption. */
  resuming: boolean;
  run: Run;
  selected?: boolean;
};
// A timer (chapter 5, A Pump): fired in deadline order, then set order.
type Timer = { deadline: bigint; fire: () => void; live: boolean; seq: number };
// A suspended Run waiting on a call: an Operation's answer, or a reply.
type Pending = {
  /** For a Join Member, its Join's members and the answers in so far. */
  join?: { answers: Map<string, Resumption>; members: Member[] };
  running: Running;
  s: ScriptState;
  timer: Timer;
};
type ScriptState = {
  debt: number;
  grants: ReadonlyMap<string, Grant<unknown>>;
  handle: Script;
  /** Deliveries queued to it that the next Pump drains. */
  incoming: number;
  limits: Limits;
  loaded: Loaded;
  name: string;
  /** The well-known Host Objects the Host bound at load, by name. */
  objects: Readonly<Record<string, HostObject>>;
  /** The object it owns, if any. */
  owner: ObjectState | null;
  /** Messages waiting for dispatch, and a preempted Run at its head. */
  queue: (Delivery | Running)[];
  runs: number;
  /** Its suspended Runs, which Persistent State counts. */
  suspended: Set<Running>;
  /** Its pending `wait for`s, in the order the waits began. */
  waiters: { running: Running; timers: Timer[] }[];
};
type QueuedInput = { apply: () => void; line: string | (() => string) };

// Each granted Operation's mode and argument Shapes, for the load checks.
const declarationsOf = (
  grants: ReadonlyMap<string, Grant<unknown>>,
): GrantDecls =>
  Object.fromEntries(
    [...grants].map(([name, grant]) => [
      name,
      Object.fromEntries(
        [...grant.ops].map(op => {
          const decl = grant.capability.operations.get(op)!;
          return [op, { mode: decl.mode, args: decl.args ?? [] }];
        }),
      ),
    ]),
  );

/** A handle for calls addressed to one Script. */
export class Script {
  constructor(
    private readonly group: Group,
    readonly name: string,
  ) {}
  /** Queued. Returns the delivery id. */
  deliver(m: Message): string {
    return this.group.queueDelivery('deliver', this.name, m, null).id!;
  }
  /** Queued. Asks for a Verdict sealed in a Pump. */
  decide(m: Message): Deciding {
    return this.group.queueDecision(this.name, m);
  }
  /** Queued. Settles when a Pump ends the Run, or rejects with `send failed`. */
  request(m: Message): Requested {
    let settle!: Delivery['request'];
    const result = new Promise<Value>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // The Host may never read a failed result.
    result.catch(() => {});
    const delivery = this.group.queueDelivery('request', this.name, m, settle);
    return { id: delivery.id!, result };
  }
}

export class Group {
  readonly name: string;
  private readonly trace: (line: string) => void;
  private readonly scripts: ScriptState[] = [];
  private readonly libraries = new Map<string, Library>();
  private readonly pending = new Map<string, Pending>();
  private readonly objects = new Map<string, ObjectState>();
  // The reports of the Pump draining the input queue.
  private drainReports: Report[] = [];
  private timers: Timer[] = [];
  private timerSeq = 0;
  private inputs: QueuedInput[] = [];
  private deliveries = 0;
  private broadcasts = 0;
  private lastClock: bigint | null = null;
  private pumping = false;

  constructor(options: GroupOptions) {
    this.name = options.name;
    this.trace = options.trace ?? (() => {});
  }

  script(name: string): Script | undefined {
    return this.scripts.find(s => s.name === name)?.handle;
  }

  private worker() {
    if (this.pumping) {
      throw new HostError('reentrant call');
    }
  }

  /** Worker. Compiles, checks and loads a Script, or throws LoadError. */
  load(o: LoadOptions): Script {
    this.worker();
    const objects = [
      ...Object.keys(o.objects ?? {}),
      ...this.scripts.map(s => s.name),
    ];
    const owner = o.owner ? this.held(o.owner) : null;
    if (owner?.owner) {
      throw new HostError(
        'invalid value',
        `${owner.handle.value} already has an Owning Script, ${owner.owner}`,
      );
    }
    for (const object of Object.values(o.objects ?? {})) {
      this.held(object);
    }
    const grants = new Map(Object.entries(o.grants ?? {}));
    const p = prepare(
      'script',
      o.name,
      o.source,
      this.libraries,
      objects,
      declarationsOf(grants),
    );
    this.trace(recordLine('load', [o.name], [['identity', p.identity]], true));
    const limits = { ...defaultLimits, ...o.limits };
    let loaded: Loaded;
    try {
      if (p.diagnostics) {
        throw new LoadError(p.diagnostics);
      }
      loaded = loadOrReject(o.name, () =>
        loadScript(
          lowerTree(p.checked.tree!, { name: o.name, unit: 'script' }),
          limits,
          linksOf(p.imports),
        ),
      );
    } catch (error) {
      if (error instanceof LoadError) {
        for (const d of error.diagnostics) {
          this.trace(
            recordLine(
              'diag',
              [o.name],
              [
                ['code', JSON.stringify(d.code)],
                ['pos', `${d.line}:${d.col}`],
              ],
            ),
          );
        }
      }
      throw error;
    }
    const handle = new Script(this, o.name);
    if (owner) {
      owner.owner = o.name;
    }
    this.scripts.push({
      name: o.name,
      waiters: [],
      suspended: new Set(),
      objects: o.objects ?? {},
      owner,
      grants,
      handle,
      loaded,
      limits,
      queue: [],
      runs: 0,
      debt: 0,
      incoming: 0,
    });
    return handle;
  }

  /**
   * Worker, Host Input. Adds a compiled Library, whose imports the Group must
   * already hold, under a name it doesn't hold yet.
   */
  addLibrary(l: Library): void {
    this.worker();
    this.trace(
      recordLine('add-library', [l.name], [['identity', identityOf(l)]], true),
    );
    const refuse = (code: HostErrorCode, message: string): never => {
      this.trace(recordLine('refused', [], [['code', JSON.stringify(code)]]));
      throw new HostError(code, message);
    };
    if (stdlibNames.has(l.name)) {
      refuse('reserved name', `${l.name} is a stdlib Library's name`);
    }
    if (this.libraries.has(l.name)) {
      refuse('name reused', `The Group already holds a Library ${l.name}`);
    }
    // The stdlib Libraries are always there.
    for (const i of l.imports.filter(i => !stdlibNames.has(i.name))) {
      const held = this.libraries.get(i.name);
      if (!held || identityOf(held) !== identityOf(i)) {
        refuse(
          'library mismatch',
          `The Group doesn't hold the ${i.name} that ${l.name} imports`,
        );
      }
    }
    this.libraries.set(l.name, l);
  }

  // What a Run of the Script reaches outside it through (machine.ts).
  private hostFor(s: ScriptState, run: Run): RunHost {
    const group = this;
    return {
      grants: s.grants,
      get now() {
        return group.lastClock!;
      },
      get me() {
        return s.owner?.handle.value ?? nothing;
      },
      object: name =>
        Object.hasOwn(s.objects, name) ? s.objects[name]!.value : undefined,
      isScript: name => this.scripts.some(other => other.name === name),
      send: (to, message, args, reply) => {
        // A Script, or the nearest Owning Script of an object (chapter 5).
        const r =
          typeof to === 'string'
            ? (() => {
                const named = this.scripts.find(other => other.name === to)!;
                return { s: named, at: named.owner };
              })()
            : this.route(to);
        if (!r) {
          return null;
        }
        this.enqueue(r.s, to, {
          id: null,
          from: reply ?? run.id,
          at: r.at,
          target: typeof to === 'string' ? null : to,
          message,
          args,
          limits: {},
          reply,
          request: null,
        });
        return r.s.name;
      },
      // A Command Call with no Handler climbs from its Script's owner.
      sendUp: (message, args, reply) => {
        const r = this.route(s.owner?.parent ?? null);
        if (!r) {
          return null;
        }
        this.enqueue(r.s, r.s.name, {
          id: null,
          from: reply ?? run.id,
          at: r.at,
          target: s.owner,
          message,
          args,
          limits: {},
          reply,
          request: null,
        });
        return r.s.name;
      },
      answer: (id, value, fuel) =>
        this.inputs.push({
          line: recordLine(
            'answer',
            [id],
            [
              ['value', traceValue(value)],
              ['fuel', fuel ? String(fuel) : null],
            ],
            true,
          ),
          apply: () => this.settle(id, { k: 'answer', value, fuel }),
        }),
      fail: (id, error) =>
        this.inputs.push({
          line: recordLine(
            'fail',
            [id],
            [['error', traceValue(failMap(error))]],
            true,
          ),
          apply: () => this.settle(id, { k: 'fail', error }),
        }),
    };
  }

  // A message a Script sent, into its receiver's mailbox, unless it is full.
  private enqueue(
    receiver: ScriptState,
    to: string | ObjectState,
    delivery: Delivery,
  ) {
    const waiting = receiver.queue.filter(item => !('run' in item)).length;
    if (waiting + receiver.incoming >= receiver.limits.mailboxDepth) {
      throw new OpScriptError(
        'mailbox full',
        [['to', typeof to === 'string' ? text(to) : to.handle.value]],
        true,
      );
    }
    receiver.queue.push(delivery);
  }

  private timer(deadline: bigint, fire: () => void): Timer {
    const t = { deadline, fire, live: true, seq: this.timerSeq++ };
    this.timers.push(t);
    return t;
  }

  // A suspended Run made ready: it joins the back of its Script's queue.
  private ready(s: ScriptState, running: Running, r: Resumption) {
    s.suspended.delete(running);
    running.run.wake(r);
    running.resuming = true;
    s.queue.push(running);
  }

  // A call's answer or failure, or a reply; one no longer pending is noted.
  private settle(id: string, r: Resumption) {
    const p = this.pending.get(id);
    if (!p) {
      if (r.k === 'answer' || r.k === 'fail') {
        this.trace(recordLine('note', [id], [['kind', 'late-answer']]));
      }
      return;
    }
    this.pending.delete(id);
    p.timer.live = false;
    if (!p.join) {
      this.ready(p.s, p.running, r);
      return;
    }
    // A Join Member: it waits for all, or fails fast (chapter 5, Joins).
    const { members, answers } = p.join;
    const index = members.findIndex(m => m.id === id);
    if (r.k === 'answer' || r.k === 'reply') {
      answers.set(id, r);
      members[index]!.answer = r.value;
      if (answers.size === members.length) {
        this.ready(p.s, p.running, {
          k: 'joined',
          answers: members.map(m => answers.get(m.id)!),
        });
      }
      return;
    }
    const abandon = members.filter(m => m.id !== id && this.pending.has(m.id));
    for (const m of abandon) {
      this.pending.get(m.id)!.timer.live = false;
      this.pending.delete(m.id);
      m.abort?.abort();
    }
    this.ready(p.s, p.running, {
      k: 'join-failed',
      index: index + 1,
      failure: r,
      // A member that timed out is abandoned too, first.
      abandon: [...(r.k === 'timeout' ? [id] : []), ...abandon.map(m => m.id)],
    });
  }

  private endWaiter(s: ScriptState, waiter: ScriptState['waiters'][number]) {
    for (const t of waiter.timers) {
      t.live = false;
    }
    s.waiters = s.waiters.filter(w => w !== waiter);
  }

  // A message being dispatched resumes every pending `wait for` of its
  // Script that it matches, in the order the waits began (chapter 5).
  private observe(s: ScriptState, delivery: Delivery) {
    const from = delivery.from?.split('/')[0] ?? null;
    for (const waiter of s.waiters) {
      const fired = waiter.running.run.matchEvent(
        delivery.message,
        delivery.args,
        from,
      );
      if (fired) {
        this.endWaiter(s, waiter);
        this.seal(delivery, { verdict: 'allowed' });
        this.ready(s, waiter.running, fired);
      }
    }
  }

  // A Run that suspended: wait on its timer, its answer or its reply.
  private suspended(s: ScriptState, running: Running, sus: Suspension) {
    s.suspended.add(running);
    const now = this.lastClock!;
    if (sus.k === 'wait') {
      return this.timer(now + sus.ns, () =>
        this.ready(s, running, { k: 'wake' }),
      ).deadline;
    }
    if (sus.k === 'wait-for') {
      // A timeout, and each `after` branch, is a timer; the first to fire
      // ends the wait, as a matching message does.
      const waiter = { running, timers: [] as Timer[] };
      const fire = (branch: number) => () => {
        this.endWaiter(s, waiter);
        this.ready(s, running, { k: 'event-timeout', branch });
      };
      if (sus.timeout !== null) {
        waiter.timers.push(this.timer(now + sus.timeout, fire(0)));
      }
      for (const after of sus.afters) {
        waiter.timers.push(this.timer(now + after.ns, fire(after.branch)));
      }
      s.waiters.push(waiter);
      return waiter.timers.reduce<bigint | null>(
        (min, t) => (min === null || t.deadline < min ? t.deadline : min),
        null,
      );
    }
    if (sus.k === 'join') {
      // Each member waits on its own `maxPending` or `MaxWait`.
      const join = {
        members: sus.members,
        answers: new Map<string, Resumption>(),
      };
      for (const m of sus.members) {
        const timer = this.timer(now + BigInt(m.ms) * 1_000_000n, () =>
          this.settle(m.id, { k: 'timeout', after: m.ms }),
        );
        this.pending.set(m.id, { s, running, timer, join });
      }
      return null;
    }
    const id = sus.k === 'ask' ? sus.call.id : sus.id;
    const ms = sus.k === 'ask' ? sus.ms : s.limits.maxWaitMs;
    const timer = this.timer(now + BigInt(ms) * 1_000_000n, () => {
      this.pending.delete(id);
      if (sus.k === 'ask') {
        sus.abort.abort();
      }
      this.ready(s, running, { k: 'timeout', after: ms });
    });
    this.pending.set(id, { s, running, timer });
    return null;
  }

  /** A queued Delivery: its id now, its line and its mailbox entry at the next Pump. */
  queueDelivery(
    record: 'deliver' | 'request' | 'decide',
    to: string | ObjectState,
    m: Message,
    request: Delivery['request'],
    ballot?: Ballot,
  ): Delivery {
    const named = typeof to === 'string';
    const toText = named ? to : traceValue(to.handle.value);
    // The Script it routes to at the call, whose mailbox depth it counts
    // against: a Script, or an object's nearest Owning Script.
    const state = named
      ? this.scripts.find(s => s.name === to)
      : this.route(to)?.s;
    if (named && !state) {
      throw new HostError('invalid value', `No Script ${to} in the Group`);
    }
    // A Host Input refused at the call is written, with no ids, then `refused`.
    const refuse = (code: string, error: Error): never => {
      this.trace(this.deliveryLine(record, null, toText, m));
      this.trace(recordLine('refused', [], [['code', JSON.stringify(code)]]));
      throw error;
    };
    for (const [name, value] of Object.entries(m.limits ?? {})) {
      const limit = (state?.limits ?? defaultLimits)[name as LimitName];
      if (!overridable.has(name) || value! > limit) {
        refuse(
          'invalid value',
          new HostError(
            'invalid value',
            `A limit override may only tighten ${name}`,
          ),
        );
      }
    }
    if (state) {
      const waiting =
        state.queue.filter(item => !('run' in item)).length + state.incoming;
      if (waiting >= state.limits.mailboxDepth) {
        refuse('mailbox full', new MailboxFull());
      }
    }
    const delivery: Delivery = {
      ...(ballot ? { ballot } : {}),
      id: `d${++this.deliveries}`,
      from: null,
      at: named ? state!.owner : null,
      target: named ? null : to,
      reply: null,
      message: m.name,
      args: m.args ?? [],
      limits: m.limits ?? {},
      request,
    };
    if (state) {
      state.incoming++;
    }
    this.inputs.push({
      line: this.deliveryLine(record, delivery.id, toText, m),
      apply: () => {
        if (state) {
          state.incoming--;
        }
        if (named) {
          state!.queue.push(delivery);
          return;
        }
        // An object's message is routed by the parents as they are now.
        const r = this.route(to);
        if (!r) {
          this.unhandled(delivery, this.drainReports);
          return;
        }
        r.s.queue.push({ ...delivery, at: r.at });
      },
    });
    return delivery;
  }

  /** Queued. Asks the object's Message Path for a Verdict. */
  decide(to: HostObject, m: Message): Deciding {
    return this.queueDecision(this.held(to), m);
  }

  queueDecision(to: string | ObjectState, m: Message): Deciding {
    let resolve!: Decision['resolve'];
    const decided = new Promise<Decided>(settle => {
      resolve = settle;
    });
    const decision: Decision = {
      id: '',
      broadcast: false,
      ballots: [],
      resolve,
    };
    const ballot: Ballot = { decision };
    decision.ballots.push(ballot);
    decision.id = this.queueDelivery('decide', to, m, null, ballot).id!;
    return { id: decision.id, decided };
  }

  /** Queued. Takes recipients at drain, then waits for every Verdict. */
  decideBroadcast(m: Message): Deciding {
    for (const [name, value] of Object.entries(m.limits ?? {})) {
      if (!overridable.has(name) || value! > defaultLimits[name as LimitName]) {
        this.trace(recordLine('decide-broadcast', [], messageFields(m), true));
        this.trace(recordLine('refused', [], [['code', '"invalid value"']]));
        throw new HostError(
          'invalid value',
          `A Broadcast override may only tighten ${name}`,
        );
      }
    }
    let resolve!: Decision['resolve'];
    const decided = new Promise<Decided>(settle => {
      resolve = settle;
    });
    const decision: Decision = {
      id: `b${++this.broadcasts}`,
      broadcast: true,
      ballots: [],
      resolve,
    };
    let recipients: { delivery: Delivery; s: ScriptState }[] = [];
    this.inputs.push({
      line: () => {
        recipients = this.scripts
          .filter(
            s =>
              s.loaded.clauses.has(m.name) ||
              s.waiters.some(
                w =>
                  w.running.run.suspended?.k === 'wait-for' &&
                  w.running.run.suspended.whens.some(b => b.message === m.name),
              ),
          )
          .map(s => {
            const ballot: Ballot = { decision };
            decision.ballots.push(ballot);
            return {
              s,
              delivery: {
                ballot,
                broadcast: decision.id,
                id: `d${++this.deliveries}`,
                from: null,
                at: s.owner,
                target: null,
                reply: null,
                request: null,
                message: m.name,
                args: m.args ?? [],
                limits: Object.fromEntries(
                  Object.entries(m.limits ?? {}).map(([name, value]) => [
                    name,
                    Math.min(value!, s.limits[name as LimitName]),
                  ]),
                ),
              },
            };
          });
        return recordLine(
          'decide-broadcast',
          [decision.id],
          [
            ...messageFields(m),
            [
              'recipients',
              idList(recipients.map(r => `${r.s.name}:${r.delivery.id}`)),
            ],
          ],
          true,
        );
      },
      apply: () => {
        for (const { s, delivery } of recipients) {
          s.queue.push(delivery);
        }
        if (!recipients.length) {
          this.reportDecision(decision);
        }
      },
    });
    return { id: decision.id, decided };
  }

  private seal(delivery: Delivery, result: NonNullable<Ballot['result']>) {
    const ballot = delivery.ballot;
    if (!ballot || ballot.result) {
      return;
    }
    ballot.result = result;
    if (ballot.decision.ballots.every(b => b.result)) {
      this.reportDecision(ballot.decision);
    }
  }

  private reportDecision(decision: Decision) {
    const vetoes = decision.ballots.flatMap(b =>
      b.result?.veto ? [b.result.veto] : [],
    );
    const undecided = decision.ballots.flatMap(b =>
      b.result?.undecided ? [b.result.undecided] : [],
    );
    const result: Decided = {
      ...(decision.broadcast
        ? { broadcast: decision.id }
        : { delivery: decision.id }),
      verdict: vetoes.length
        ? 'vetoed'
        : undecided.length
          ? 'undecided'
          : 'allowed',
      vetoes,
      undecided,
    };
    this.trace(
      recordLine(
        'decided',
        [decision.id],
        [
          ['verdict', result.verdict],
          [
            'vetoes',
            vetoes.length
              ? traceValue(
                  listValues(
                    vetoes.map(v =>
                      map([
                        ['script', text(v.script)],
                        ['run', text(v.run)],
                        ['reason', v.reason],
                      ]),
                    ),
                  ),
                )
              : null,
          ],
          [
            'undecided',
            undecided.length
              ? traceValue(
                  listValues(
                    undecided.map(v =>
                      map([
                        ['script', text(v.script)],
                        ...(v.run
                          ? [['run', text(v.run)] as [string, Value]]
                          : []),
                        ['outcome', text(v.outcome)],
                      ]),
                    ),
                  ),
                )
              : null,
          ],
        ],
      ),
    );
    this.drainReports.push({ kind: 'decided', ...result });
    decision.resolve(result);
  }

  /** Queued. Routes to the object's nearest Owning Script; returns the delivery id. */
  deliver(to: HostObject, m: Message): string {
    return this.queueDelivery('deliver', this.held(to), m, null).id!;
  }
  /** Queued. As `deliver`, and settles when a Pump ends the Run. */
  request(to: HostObject, m: Message): Requested {
    let settle!: Delivery['request'];
    const result = new Promise<Value>((resolve, reject) => {
      settle = { resolve, reject };
    });
    result.catch(() => {});
    const delivery = this.queueDelivery('request', this.held(to), m, settle);
    return { id: delivery.id!, result };
  }

  /** Makes a handle for a Host-owned thing, the first time it crosses in. */
  object<N>(kind: ObjectKind<N>, id: string, native: N): HostObject<N> {
    const key = `${kind.name}\u0000${id}`;
    if (this.objects.has(key)) {
      throw new HostError(
        'duplicate object id',
        `The Group already has a ${kind.name} ${id}`,
      );
    }
    const state = makeObject(kind, id, native);
    this.objects.set(key, state);
    return state.handle as HostObject<N>;
  }

  // The Group's state of a handle, which must be one of its own.
  private held(o: HostObject): ObjectState {
    const state = stateOf(o.value);
    if (!state || this.objects.get(`${o.kind.name}\u0000${o.id}`) !== state) {
      throw new HostError('wrong group', `${o.value} isn't this Group's`);
    }
    return state;
  }

  /** Queued. Sets an object's parent, which the Core holds; a cycle is refused. */
  setParent(o: HostObject, parent: HostObject | undefined): void {
    const child = this.held(o);
    const up = parent ? this.held(parent) : null;
    const line = recordLine(
      'set-parent',
      [],
      [
        ['object', traceValue(child.handle.value)],
        ['parent', up ? traceValue(up.handle.value) : null],
      ],
      true,
    );
    for (let x = up; x; x = x.parent) {
      if (x === child) {
        this.trace(line);
        this.trace(recordLine('refused', [], [['code', '"parent cycle"']]));
        throw new HostError(
          'parent cycle',
          `${o.value} would be its own ancestor`,
        );
      }
    }
    this.inputs.push({
      line,
      apply: () => {
        child.parent = up;
      },
    });
  }

  /** Queued. Disposes an object: it stays a value, and sends to it raise `object gone`. */
  dispose(o: HostObject): void {
    const state = this.held(o);
    if (state.owner) {
      throw new NotImplementedError('disposing an Owning Script’s object');
    }
    this.inputs.push({
      line: recordLine(
        'dispose',
        [],
        [['object', traceValue(state.handle.value)]],
        true,
      ),
      apply: () => {
        state.disposed = true;
      },
    });
  }

  // The nearest Owning Script from an object up its parents, skipping
  // disposed objects (chapter 5, The Message Path).
  private route(
    from: ObjectState | null,
  ): { at: ObjectState; s: ScriptState } | null {
    for (let x = from; x; x = x.parent) {
      if (!x.disposed && x.owner) {
        const s = this.scripts.find(other => other.name === x!.owner);
        if (s) {
          return { s, at: x };
        }
      }
    }
    return null;
  }

  // A message past the last Owning Script: `unhandled`, and a `send … and
  // wait` or Request for it fails with `send failed`.
  private unhandled(delivery: Delivery, reports: Report[]) {
    this.trace(
      recordLine(
        'unhandled',
        [delivery.id],
        [
          ['message', delivery.message],
          [
            'args',
            delivery.args.length ? traceValue(listValues(delivery.args)) : null,
          ],
          [
            'target',
            delivery.target ? traceValue(delivery.target.handle.value) : null,
          ],
        ],
      ),
    );
    if (delivery.id) {
      reports.push({
        kind: 'unhandled',
        delivery: delivery.id,
        message: { name: delivery.message, args: delivery.args },
      });
    }
    this.seal(delivery, { verdict: 'allowed' });
    this.answer(delivery, { kind: 'unhandled' });
  }

  // Settle what waits on a message's Run: a sender's reply, or a Request.
  private answer(delivery: Delivery, outcome: Outcome) {
    if (delivery.reply) {
      this.settle(
        delivery.reply,
        outcome.kind === 'completed'
          ? { k: 'reply', value: outcome.result }
          : {
              k: 'send failed',
              reason: outcome.kind,
              error: outcome.kind === 'errored' ? outcome.error : null,
            },
      );
    }
    if (delivery.request) {
      if (outcome.kind === 'completed') {
        delivery.request.resolve(outcome.result);
      } else {
        const reason =
          outcome.kind === 'limit fault' ? 'limit fault' : outcome.kind;
        delivery.request.reject(
          new ScriptError(
            'send failed',
            `No answer came: the receiver's Run ended ${reason}`,
            { reason },
          ),
        );
      }
    }
  }

  private deliveryLine(
    record: string,
    id: string | null,
    to: string,
    m: Message,
  ) {
    return recordLine(record, [id], [['to', to], ...messageFields(m)], true);
  }

  /** Worker. One Clock reading, the queue drained, then turns until done (chapter 5). */
  pump(now: bigint, o: PumpOptions = {}): PumpResult {
    this.worker();
    if (this.lastClock !== null && now < this.lastClock) {
      throw new HostError('clock backwards');
    }
    this.lastClock = now;
    const slice = o.fuelSlice ?? 0;
    const cap = o.fuelCap ?? 0;
    for (const input of this.inputs) {
      this.trace(typeof input.line === 'string' ? input.line : input.line());
    }
    this.trace(
      recordLine(
        'pump',
        [],
        [
          ['clock', formatInstant(now)],
          ['fuel-slice', slice ? String(slice) : null],
          ['fuel-cap', cap ? String(cap) : null],
        ],
        true,
      ),
    );
    const drained = this.inputs;
    this.inputs = [];
    const reports: Report[] = [];
    this.drainReports = reports;
    for (const input of drained) {
      input.apply();
    }
    // Due timers fire in deadline order, then in the order they were set.
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
        t.fire();
      }
    }
    this.timers = this.timers.filter(t => t.live);
    this.pumping = true;
    let fuel = 0;
    try {
      // Each Script's Fuel this Pump, against its slice less any debt.
      const spent = new Map<ScriptState, number>();
      const allowance = new Map<ScriptState, number>();
      for (const s of this.scripts) {
        spent.set(s, 0);
        if (slice) {
          const available = slice - s.debt;
          allowance.set(s, Math.max(0, available));
          s.debt = available < 0 ? -available : 0;
        }
      }
      const capped = () => cap > 0 && fuel >= cap;
      const sliced = (s: ScriptState) =>
        slice > 0 && spent.get(s)! >= allowance.get(s)!;
      const preempt = (s: ScriptState) =>
        sliced(s) ? 'slice' : capped() ? 'cap' : null;
      let progress = true;
      while (progress && !capped()) {
        progress = false;
        for (const s of this.scripts) {
          if (!s.queue.length || sliced(s) || capped()) {
            continue;
          }
          progress = true;
          this.turn(
            s,
            reports,
            () => preempt(s),
            cost => {
              spent.set(s, spent.get(s)! + cost);
              fuel += cost;
            },
          );
        }
      }
      for (const s of this.scripts) {
        if (slice && spent.get(s)! > allowance.get(s)!) {
          s.debt += spent.get(s)! - allowance.get(s)!;
        }
      }
    } finally {
      this.pumping = false;
    }
    const state = this.scripts.some(s => s.queue.length) ? 'sliced' : 'idle';
    this.timers = this.timers.filter(t => t.live);
    const next = this.timers.reduce<bigint | null>(
      (min, t) => (min === null || t.deadline < min ? t.deadline : min),
      null,
    );
    this.trace(
      recordLine(
        'pumped',
        [],
        [
          ['state', state],
          ['fuel', String(fuel)],
          ['next', next === null ? null : formatInstant(next)],
        ],
      ),
    );
    return { state, fuelUsed: fuel, reports };
  }

  // A Script's turn: its queue's head runs until it ends or is preempted.
  private turn(
    s: ScriptState,
    reports: Report[],
    preempt: () => 'slice' | 'cap' | null,
    charge: (fuel: number) => void,
  ) {
    let head = s.queue[0]!;
    let how: 'start' | 'continue' | 'resume' = 'continue';
    if (!('run' in head)) {
      const delivery = head;
      this.observe(s, delivery);
      const run = dispatch(
        s.loaded,
        delivery.message,
        delivery.args,
        delivery.limits,
      );
      // At this Run's end, the rest of the queue is what the Script keeps.
      run.persistentState = () => this.persistentState(s, 1);
      head = {
        id: `${s.name}/r${++s.runs}`,
        delivery,
        run,
        resuming: false,
      };
      run.id = head.id;
      run.host = this.hostFor(s, run);
      if (delivery.during) {
        run.setDuring(delivery.during);
      }
      // The object it was delivered to, or for a message to a Script, the
      // Script's owner (chapter 5, `the target`).
      run.target = (delivery.target ?? s.owner)?.handle.value ?? nothing;
      s.queue[0] = head;
      how = 'start';
    }
    const running = head;
    if (running.resuming) {
      running.resuming = false;
      how = 'resume';
    }
    const { run } = running;
    const fuel0 = run.fuel;
    const alloc0 = run.alloc;
    const records0 = run.records.length;
    const selected = () => {
      const clause = run.selectedClause;
      if (!running.selected && clause) {
        running.selected = true;
        if (!clause.deciding) {
          this.seal(running.delivery, { verdict: 'allowed' });
        }
        run.openVerdict =
          clause.deciding === true &&
          !!running.delivery.ballot &&
          !running.delivery.ballot.result;
      }
    };
    selected();
    let last = run.fuel;
    let by: 'slice' | 'cap' | null = null;
    while (!run.done && !run.suspended) {
      by = preempt();
      if (by) {
        break;
      }
      run.step();
      selected();
      charge(run.fuel - last);
      last = run.fuel;
    }
    for (const rec of run.records.slice(records0)) {
      if (rec.kind === 'abandon') {
        this.trace(recordLine('abandon', [rec.id], []));
        continue;
      }
      if (rec.kind === 'unhandled') {
        this.trace(
          recordLine(
            'unhandled',
            [],
            [
              ['message', rec.message],
              [
                'args',
                rec.args.length ? traceValue(listValues(rec.args)) : null,
              ],
              ['target', rec.target ? traceValue(rec.target) : null],
            ],
          ),
        );
        continue;
      }
      if (rec.kind === 'prop') {
        this.trace(
          recordLine(
            'prop',
            [running.id],
            [
              ['object', traceValue(rec.object)],
              ['name', rec.name],
              ['op', rec.op],
              ['value', rec.value ? traceValue(rec.value) : null],
              ['error', rec.error ? traceValue(rec.error) : null],
            ],
          ),
        );
        continue;
      }
      if (rec.kind === 'call') {
        this.trace(
          recordLine(
            'call',
            [rec.id],
            [
              ['op', rec.op],
              ['args', traceValue(listValues(rec.args))],
              ['result', rec.result ? traceValue(rec.result) : null],
              ['error', rec.error ? traceValue(rec.error) : null],
              ['charged', rec.charged ? String(rec.charged) : null],
            ],
          ),
        );
        continue;
      }
      if (rec.kind === 'call-failed') {
        this.trace(recordLine('call-failed', [rec.id], [['op', rec.op]]));
        continue;
      }
      if (rec.kind === 'send') {
        this.trace(
          recordLine(
            'send',
            [rec.id ?? running.id],
            [
              ['to', rec.to],
              ['message', rec.message],
              [
                'args',
                rec.args.length ? traceValue(listValues(rec.args)) : null,
              ],
              ['wait', rec.join ? 'join' : rec.id ? 'yes' : null],
            ],
          ),
        );
        continue;
      }
      const at = `${rec.unit}:${rec.pc}`;
      const pos = `${rec.line}:${rec.col}`;
      this.trace(
        rec.kind === 'raise'
          ? recordLine(
              'raise',
              [running.id],
              [
                ['code', JSON.stringify(rec.code)],
                ['at', at],
                ['pos', pos],
              ],
            )
          : recordLine(
              'guard-skip',
              [running.id],
              [
                ['at', at],
                ['pos', pos],
                [
                  'code',
                  rec.code === undefined ? null : JSON.stringify(rec.code),
                ],
                ['value', rec.value ? traceValue(rec.value) : null],
              ],
            ),
      );
    }
    const outcome = run.ended;
    if (outcome?.kind === 'completed' && outcome.veto && !run.openVerdict) {
      this.trace(recordLine('note', [running.id], [['kind', 'no-verdict']]));
    }
    if (outcome) {
      s.suspended.delete(running);
    }
    if (outcome?.kind === 'limit fault') {
      this.trace(
        recordLine(
          'fault',
          [running.id],
          [
            ['limit', faultNames[outcome.limit] ?? outcome.limit],
            ['at', `${outcome.unit}:${outcome.pc}`],
            ['pos', `${outcome.line}:${outcome.col}`],
            ['rollback', idList(outcome.rollback)],
          ],
        ),
      );
      for (const id of run.faultAbandons) {
        this.trace(recordLine('abandon', [id], []));
      }
    }
    const handler = s.loaded.clauses.has(running.delivery.message)
      ? running.delivery.message
      : null;
    const start: [string, string | null][] =
      how === 'start'
        ? [
            ['delivery', running.delivery.id],
            ['broadcast', running.delivery.broadcast ?? null],
            ['from', running.delivery.from],
            ['handler', handler],
            // No clause matched an unhandled Run.
            [
              'clause',
              run.clauseNumber && outcome?.kind !== 'unhandled'
                ? String(run.clauseNumber)
                : null,
            ],
          ]
        : [];
    const stretch: [string, string][] = [
      ['fuel', String(run.fuel - fuel0)],
      ['alloc', String(run.alloc - alloc0)],
    ];
    if (!outcome && run.suspended) {
      s.queue.shift();
      const deadline = this.suspended(s, running, run.suspended);
      this.trace(
        recordLine(
          'seg',
          [running.id, how],
          [
            ...start,
            ...stretch,
            ['state', String(this.persistentState(s))],
            [
              'end',
              run.suspended.k === 'wait-for' && run.suspended.any
                ? 'wait-for-any'
                : suspendReasons[run.suspended.k],
            ],
            ['until', deadline === null ? null : formatInstant(deadline)],
          ],
        ),
      );
      this.seal(running.delivery, { verdict: 'allowed' });
      run.openVerdict = false;
      return;
    }
    if (!outcome) {
      this.trace(
        recordLine(
          'preempt',
          [running.id, how],
          [...start, ['by', by], ...stretch],
        ),
      );
      return;
    }
    s.queue.shift();
    this.trace(
      recordLine(
        'seg',
        [running.id, how],
        [
          ...start,
          ...stretch,
          ['state', String(this.persistentState(s))],
          ['end', endReason(outcome)],
          [
            'value',
            outcome.kind === 'completed' &&
            outcome.veto?.kind !== 'nothing' &&
            outcome.veto
              ? traceValue(outcome.veto)
              : null,
          ],
        ],
      ),
    );
    if (outcome.kind === 'completed' && !outcome.passed) {
      this.seal(
        running.delivery,
        outcome.veto
          ? {
              verdict: 'vetoed',
              veto: { script: s.name, run: running.id, reason: outcome.veto },
            }
          : { verdict: 'allowed' },
      );
    }
    run.openVerdict = false;
    this.endRun(s, running, outcome, reports, handler);
  }

  private endRun(
    s: ScriptState,
    running: Running,
    outcome: Outcome,
    reports: Report[],
    handler: string | null,
  ) {
    const { run, delivery } = running;
    const word = outcome.kind === 'limit fault' ? 'limit-fault' : outcome.kind;
    const result = outcome.kind === 'completed' ? outcome.result : null;
    const error = outcome.kind === 'errored' ? outcome.error : null;
    const limit =
      outcome.kind === 'limit fault'
        ? (faultNames[outcome.limit] ?? outcome.limit)
        : null;
    this.trace(
      recordLine(
        'run',
        [running.id],
        [
          ['outcome', word],
          ['delivery', delivery.id],
          ['broadcast', delivery.broadcast ?? null],
          ['handler', handler],
          [
            'value',
            result && result.kind !== 'nothing' ? traceValue(result) : null,
          ],
          ['error', error ? traceValue(error) : null],
          ['limit', limit],
          ['fuel', String(run.fuel)],
          ['alloc', String(run.alloc)],
        ],
      ),
    );
    reports.push({
      kind: 'run end',
      script: s.name,
      run: running.id,
      ...(delivery.id ? { delivery: delivery.id } : {}),
      ...(delivery.broadcast ? { broadcast: delivery.broadcast } : {}),
      ...(handler ? { handler } : {}),
      outcome: outcome.kind,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
      ...(limit ? { limit } : {}),
      fuel: run.fuel,
      alloc: run.alloc,
    });
    if (outcome.kind === 'errored' || outcome.kind === 'limit fault') {
      this.seal(delivery, {
        verdict: 'undecided',
        undecided: { script: s.name, run: running.id, outcome: outcome.kind },
      });
    }
    if (
      outcome.kind === 'errored' &&
      delivery.message !== 'error' &&
      s.loaded.clauses.has('error')
    ) {
      const waiting =
        s.queue.filter(item => !('run' in item)).length + s.incoming;
      if (waiting >= s.limits.mailboxDepth) {
        this.trace(
          recordLine('note', [running.id], [['kind', 'error-dropped']]),
        );
      } else {
        s.queue.push({
          id: null,
          from: running.id,
          at: s.owner,
          target: s.owner,
          message: 'error',
          args: [outcome.error],
          limits: {},
          reply: null,
          request: null,
          during: map([
            ['name', text(delivery.message)],
            ['args', listValues(delivery.args)],
          ]),
        });
      }
    }
    if (
      delivery.during &&
      (outcome.kind === 'unhandled' ||
        (outcome.kind === 'completed' && outcome.passed))
    ) {
      return;
    }
    if (
      delivery.broadcast &&
      (outcome.kind === 'unhandled' ||
        (outcome.kind === 'completed' && outcome.passed))
    ) {
      this.seal(delivery, { verdict: 'allowed' });
      return;
    }
    if (
      outcome.kind === 'unhandled' ||
      (outcome.kind === 'completed' && outcome.passed)
    ) {
      // It climbs on from the parent of the object whose Owning Script
      // received it, to the next Owning Script up (chapter 5).
      const next = this.route(delivery.at?.parent ?? null);
      if (!next) {
        this.unhandled(delivery, reports);
        return;
      }
      const waiting =
        next.s.queue.filter(item => !('run' in item)).length + next.s.incoming;
      if (waiting >= next.s.limits.mailboxDepth) {
        this.trace(recordLine('note', [running.id], [['kind', 'climb-full']]));
        this.unhandled(delivery, reports);
        return;
      }
      next.s.queue.push({ ...delivery, at: next.at });
      return;
    }
    this.answer(delivery, outcome);
  }

  /** A Script's Persistent State: its Script Variables and the messages it holds. */
  private persistentState(s: ScriptState, skip = 0): number {
    let total = s.loaded.variablesSize();
    for (const r of s.suspended) {
      total += r.run.size();
    }
    for (const item of s.queue.slice(skip)) {
      if (!('run' in item)) {
        total += partSize(
          'message',
          0,
          item.args.reduce((sum, v) => sum + sizeOf(v), 0),
        );
      }
    }
    return total;
  }

  /** Worker, and the Host Input `vars`: the Group, read without changing it. */
  inspect(): Inspection {
    this.worker();
    this.trace(recordLine('vars', [], [], true));
    const scripts = this.scripts.map(s => {
      const vars = s.loaded.unit.variables.map(
        (n, i) => [n, s.loaded.variables[i] ?? nothing] as [string, Value],
      );
      this.trace(
        recordLine(
          'vars',
          [s.name],
          vars.map(([n, v]) => [n, traceValue(v)]),
        ),
      );
      return {
        name: s.name,
        vars,
        runs: [
          ...s.queue.flatMap(item =>
            'run' in item
              ? [
                  {
                    id: item.id,
                    status: item.resuming
                      ? ('ready' as const)
                      : ('preempted' as const),
                    handler: item.delivery.message,
                  },
                ]
              : [],
          ),
          ...[...s.suspended].map(item => ({
            id: item.id,
            status: 'suspended' as const,
            handler: item.delivery.message,
          })),
        ],
        mailbox: s.queue.flatMap(item =>
          'run' in item
            ? []
            : [
                {
                  delivery: item.id,
                  from: item.from,
                  message: { name: item.message, args: item.args },
                },
              ],
        ),
      };
    });
    return { scripts };
  }
}

// The end reason of a stretch that suspended: its instruction's name.
const suspendReasons: Record<Suspension['k'], string> = {
  wait: 'wait',
  ask: 'ask-wait',
  send: 'send-wait',
  join: 'join-end',
  'wait-for': 'wait-for',
};
// A `Fail` as the Trace's `fail` line writes it: `{}` for what isn't a Script error.
const failMap = (error: HostScriptError | null): Value =>
  error
    ? map([
        ['code', text(error.code)],
        ...(error.message
          ? [['message', text(error.message)] as [string, Value]]
          : []),
        ...(Value.isValue(error.data) && error.data.kind === 'map'
          ? error.data.entries()
          : []),
      ])
    : map([]);

const endReason = (outcome: Outcome): string => {
  switch (outcome.kind) {
    case 'completed':
      return outcome.veto ? 'veto' : outcome.passed ? 'pass' : 'return';
    case 'errored':
      return 'error';
    case 'limit fault':
      return 'fault';
    case 'unhandled':
      return 'unhandled';
  }
};

const messageFields = (m: Message): [string, string | null][] => {
  const limits = Object.entries(m.limits ?? {});
  return [
    ['message', m.name],
    ['args', m.args?.length ? traceValue(listValues(m.args)) : null],
    [
      'limits',
      limits.length
        ? `{${limits.map(([k, v]) => `${k}: ${v}`).join(', ')}}`
        : null,
    ],
  ];
};

export const newGroup = (o: GroupOptions): Group => new Group(o);
