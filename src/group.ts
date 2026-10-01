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
  type Run,
  type RunHost,
  type Script as Loaded,
} from './machine';
import type { Grant } from './capabilities';
import type { GrantDecls } from './effects';
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
import { listValues, nothing, text, type Value } from './values';

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
  /** Well-known object names bound at load; Host Objects follow later. */
  objects?: readonly string[];
  source: string;
};
export type LimitOverride = Partial<
  Pick<Limits, 'fuelPerRun' | 'allocPerRun' | 'maxWaitMs' | 'maxJoin'>
>;
export type Message = { args?: Value[]; limits?: LimitOverride; name: string };
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
  | { delivery: string; kind: 'unhandled'; message: Message };
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
    runs: { handler: string; id: string; status: 'preempted' }[];
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

type Delivery = {
  args: Value[];
  /** For a message a Script sent, the sending Run. */
  from: string | null;
  /** The delivery id; a message a Script sent has none. */
  id: string | null;
  limits: LimitOverride;
  message: string;
  request: { reject: (e: Error) => void; resolve: (v: Value) => void } | null;
};
type Running = {
  delivery: Delivery;
  id: string;
  run: Run;
  started: boolean;
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
  /** The well-known Host Object names the Host bound at load. */
  objects: readonly string[];
  /** Messages waiting for dispatch, and a preempted Run at its head. */
  queue: (Delivery | Running)[];
  runs: number;
};
type QueuedInput = { apply: () => void; line: string };

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
  private inputs: QueuedInput[] = [];
  private deliveries = 0;
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
    const objects = [...(o.objects ?? []), ...this.scripts.map(s => s.name)];
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
    this.scripts.push({
      name: o.name,
      objects: o.objects ?? [],
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
      isObject: name => s.objects.includes(name),
      isScript: name => this.scripts.some(other => other.name === name),
      send: (to, message, args) => {
        const receiver = this.scripts.find(other => other.name === to)!;
        const waiting = receiver.queue.filter(item => !('run' in item)).length;
        if (waiting + receiver.incoming >= receiver.limits.mailboxDepth) {
          throw new OpScriptError('mailbox full', [['to', text(to)]], true);
        }
        receiver.queue.push({
          id: null,
          from: run.id,
          message,
          args,
          limits: {},
          request: null,
        });
      },
    };
  }

  /** A queued Delivery: its id now, its line and its mailbox entry at the next Pump. */
  queueDelivery(
    record: 'deliver' | 'request',
    to: string,
    m: Message,
    request: Delivery['request'],
  ): Delivery {
    const state = this.scripts.find(s => s.name === to);
    if (!state) {
      throw new HostError('invalid value', `No Script ${to} in the Group`);
    }
    // A Host Input refused at the call is written, with no ids, then `refused`.
    const refuse = (code: string, error: Error): never => {
      this.trace(this.deliveryLine(record, null, to, m));
      this.trace(recordLine('refused', [], [['code', JSON.stringify(code)]]));
      throw error;
    };
    for (const [name, value] of Object.entries(m.limits ?? {})) {
      if (!overridable.has(name) || value! > state.limits[name as LimitName]) {
        refuse(
          'invalid value',
          new HostError(
            'invalid value',
            `A limit override may only tighten ${name}`,
          ),
        );
      }
    }
    const waiting =
      state.queue.filter(item => !('run' in item)).length + state.incoming;
    if (waiting >= state.limits.mailboxDepth) {
      refuse('mailbox full', new MailboxFull());
    }
    const delivery: Delivery = {
      id: `d${++this.deliveries}`,
      from: null,
      message: m.name,
      args: m.args ?? [],
      limits: m.limits ?? {},
      request,
    };
    state.incoming++;
    this.inputs.push({
      line: this.deliveryLine(record, delivery.id, to, m),
      apply: () => {
        state.incoming--;
        state.queue.push(delivery);
      },
    });
    return delivery;
  }

  private deliveryLine(
    record: string,
    id: string | null,
    to: string,
    m: Message,
  ) {
    const limits = Object.entries(m.limits ?? {});
    return recordLine(
      record,
      [id],
      [
        ['to', to],
        ['message', m.name],
        ['args', m.args?.length ? traceValue(listValues(m.args)) : null],
        [
          'limits',
          limits.length
            ? `{${limits.map(([k, v]) => `${k}: ${v}`).join(', ')}}`
            : null,
        ],
      ],
      true,
    );
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
      this.trace(input.line);
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
    for (const input of drained) {
      input.apply();
    }
    this.pumping = true;
    const reports: Report[] = [];
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
    this.trace(
      recordLine(
        'pumped',
        [],
        [
          ['state', state],
          ['fuel', String(fuel)],
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
    let how: 'start' | 'continue' = 'continue';
    if (!('run' in head)) {
      const delivery = head;
      const run = dispatch(
        s.loaded,
        delivery.message,
        delivery.args,
        delivery.limits,
      );
      // At this Run's end, the rest of the queue is what the Script keeps.
      run.persistentState = () => this.persistentState(s, 1);
      head = { id: `${s.name}/r${++s.runs}`, delivery, run, started: false };
      run.id = head.id;
      run.host = this.hostFor(s, run);
      s.queue[0] = head;
      how = 'start';
    }
    const running = head;
    const { run } = running;
    const fuel0 = run.fuel;
    const alloc0 = run.alloc;
    const records0 = run.records.length;
    let last = run.fuel;
    let by: 'slice' | 'cap' | null = null;
    while (!run.done) {
      by = preempt();
      if (by) {
        break;
      }
      run.step();
      charge(run.fuel - last);
      last = run.fuel;
    }
    for (const rec of run.records.slice(records0)) {
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
            [running.id],
            [
              ['to', rec.to],
              ['message', rec.message],
              [
                'args',
                rec.args.length ? traceValue(listValues(rec.args)) : null,
              ],
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
    }
    const handler = s.loaded.clauses.has(running.delivery.message)
      ? running.delivery.message
      : null;
    const start: [string, string | null][] =
      how === 'start'
        ? [
            ['delivery', running.delivery.id],
            ['from', running.delivery.from],
            ['handler', handler],
            ['clause', run.clauseNumber ? String(run.clauseNumber) : null],
          ]
        : [];
    const stretch: [string, string][] = [
      ['fuel', String(run.fuel - fuel0)],
      ['alloc', String(run.alloc - alloc0)],
    ];
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
        ],
      ),
    );
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
      ...(handler ? { handler } : {}),
      outcome: outcome.kind,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
      ...(limit ? { limit } : {}),
      fuel: run.fuel,
      alloc: run.alloc,
    });
    if (outcome.kind === 'unhandled' && delivery.id) {
      // A Script addressed directly has no Message Path to climb.
      this.trace(
        recordLine(
          'unhandled',
          [delivery.id],
          [
            ['message', delivery.message],
            [
              'args',
              delivery.args.length
                ? traceValue(listValues(delivery.args))
                : null,
            ],
          ],
        ),
      );
      reports.push({
        kind: 'unhandled',
        delivery: delivery.id,
        message: { name: delivery.message, args: delivery.args },
      });
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
            {
              reason,
            },
          ),
        );
      }
    }
  }

  /** A Script's Persistent State: its Script Variables and the messages it holds. */
  private persistentState(s: ScriptState, skip = 0): number {
    let total = s.loaded.variablesSize();
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
        runs: s.queue.flatMap(item =>
          'run' in item
            ? [
                {
                  id: item.id,
                  status: 'preempted' as const,
                  handler: item.delivery.message,
                },
              ]
            : [],
        ),
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

const endReason = (outcome: Outcome): string => {
  switch (outcome.kind) {
    case 'completed':
      return 'return';
    case 'errored':
      return 'error';
    case 'limit fault':
      return 'fault';
    case 'unhandled':
      return 'unhandled';
  }
};

export const newGroup = (o: GroupOptions): Group => new Group(o);
