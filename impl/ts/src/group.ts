import {
  emptyAccounting,
  accountRoot,
  accountingTail,
  type AccountingReport,
  type RunAncestry,
} from './run-accounting';
export type {
  RunAncestry,
  RunStarted,
  RunDiscarded,
  RunAccounting,
  CausalWork,
} from './run-accounting';
import { validMessageSelector } from './selectors';
import {
  DebugController,
  machineDebug,
  statementStarts,
  type DebugEvaluation,
  type DebugPause,
  type DebugSnapshot,
  type RepeatedEffect,
  type DebugSource,
} from './debug';
// The embedding interface's Group (chapter 9) for the Core's implemented
// subset: Load, Deliver and Request to a Script, Pump with Fuel Slices and a
// Fuel cap, and Inspect, writing chapter 11's Trace as it goes. Turns follow
// chapter 5's scheduler.
import { sizeOf, partSize } from './costs';
import { invoke, type Group, type Script } from './embedding';
import {
  HostError,
  LoadError,
  MailboxFull,
  ScriptError,
  sendFailed,
  type HostErrorCode,
  ScriptError as HostScriptError,
} from './errors';
import { formatInstant, isInstant } from './dates';
import { lowerTree } from './lowering';
import {
  defaultLimits,
  deliver as dispatch,
  loadScript,
  type CodePosition,
  type LimitName,
  type Limits,
  type Outcome,
  type Resumption,
  type RunRecord as MachineRunRecord,
  Run,
  type RunHost,
  type Member,
  type CallContext,
  type Frame,
  msOf,
  type Suspension,
  type Script as Loaded,
} from './machine';
import {
  abandon,
  Waits,
  type JoinWait as WaitJoin,
  type Pending as WaitPending,
  type Timer as WaitTimer,
  type TimerAction as WaitTimerAction,
  type Waiter as WaitWaiter,
} from './waits';
import {
  type Grant,
  type Call,
  type ChargeRequest,
  type ChargeResult,
  type ReleaseReason,
} from './capabilities';
import { languageVersion, costModel } from './generated/machine';
import { canonicalJSON, grantData, operationsOf } from './manifest';
import {
  compareNames,
  decodeSave,
  encodeGroup,
  invalidSave,
  stateFingerprint,
  type DecodedSave,
  type GroupSnapshot,
  hexOf,
} from './group-snapshot';
import { saveSections } from './save-format';
import {
  RecordReader,
  type DeliveryRecord,
  type Input,
  type Mark,
  type Part,
  type ResumeRecord,
  type RunRecord,
  type Unit,
} from './save-records';
import { ValueReader, placeOf } from './save-values';
import { functionHead, type Body } from './code-unit';
import { standardChecks } from './standard-capability-checks';
import {
  makeObject,
  propertyChecks,
  objectKind,
  rebindObject,
  stateOf,
  type HostObject,
  type ObjectKind,
  type ObjectState,
} from './objects';
import { operationUses, type GrantDecls } from './effects';
import type { SemanticTree } from './semantic';
import type { ExistingName } from './checker';
import type { Code } from './machine';
import { viewSource } from './view';
import { sha256 } from './sha256';
import { checkDecisionCalls } from './decisions';
import {
  codeIdentity,
  codeOf,
  compileKey,
  replacementLibraries,
  identityOf,
  linksOf,
  loadOrReject,
  prepare,
  stdlibNames,
  type Library,
  type OperationRef,
} from './library';
import { idList, recordLine, traceValue } from './trace';
import { ScriptError as OpScriptError } from './operations';
import {
  functionValue,
  functionsBelongTo,
  displayText,
  listValues,
  map,
  nothing,
  requireArgs,
  requireValue,
  text,
  Value,
} from './values';
import { compareText } from './text';
import { nextRandom, seedState } from './random';
import {
  baseLengths,
  callSites,
  lastWaits,
  markRest,
  waitOrders,
} from './save-marks';
import {
  internals as runInternals,
  limitNames,
  microsOf,
  runFromRecord,
} from './save-runs';
import type { CodeUnit } from './code-unit';

// Process-wide compiled code. Checks and initialisation still happen for every
// load, since Grants, limits, bindings and Script state aren't code identity.
const compiledScripts = new Map<string, CodeUnit>();

export type GroupOptions = {
  name: string;
  /**
   * Called once per queued Host Input. Don't pump inside it.
   * Inputs queued during a Pump notify in a microtask after it returns.
   */
  onReady?(): void;
  /**
   * Seeds the generator `random` draws from, a whole number 0 to 2^64 - 1;
   * 0 when absent (chapter 7, Random numbers).
   */
  seed?: bigint;
  /** Receives each Trace line, without its LF. */
  trace?: (line: string) => void;
};
/**
 * TS-internal, and not exported from the package: the Trace records a
 * Session Host follows its Runs through (ADR 0045), as typed values.
 */
export type RunEvent =
  | {
      /** Suspended: the calls, replies or Join Members it still waits for. */
      calls: string[];
      /** At a start, its Delivery. */
      delivery?: string;
      end: string;
      how: 'start' | 'resume' | 'continue';
      k: 'seg';
      run: string;
      until?: bigint;
    }
  | { call: string; k: 'call'; run: string }
  | { args: Value[]; k: 'unhandled'; message: string; run?: string }
  | {
      delivery?: string;
      error?: Value;
      k: 'run';
      outcome: string;
      run: string;
    };
/**
 * TS-internal, and not exported from the package: how a Session Host follows
 * a TS Core Group (ADR 0045). The Group calls `connect` once, when the port
 * attaches, with the controls only the Session drives.
 */
export type SessionPort = {
  connect(controls: SessionControls): void;
  runs(r: RunEvent): void;
  values(tree: unknown): void;
};
export type SessionControls = {
  /** Whether Host Inputs wait for the next Pump (chapter 12, The foreground). */
  queuedInputs(): boolean;
  /** Settles a Call the Session's message layer answered. */
  reply(id: string, reply: Resumption): void;
};
/** The TS Core's own options, beyond the embedding interface's. */
export type TsGroupOptions = GroupOptions & { session?: SessionPort };
export type TsRestoreOptions = RestoreOptions & { session?: SessionPort };
export type LoadOptions = {
  /** Its Grants, by the name the Script uses for each. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Grant of any binding, as talk.ts has it.
  grants?: Readonly<Record<string, Grant<any>>>;
  /** Keep only Operations used by this source and its Libraries. */
  grantsAsUsed?: boolean;
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
/** Admission failure has no handle. A refused Pump retains the admitted Request. */
export type PumpedRequest =
  | { admitted: false; error: unknown }
  | {
      admitted: true;
      pump: { ok: true; result: PumpResult } | { error: unknown; ok: false };
      requested: Requested;
    };
/** Native TS only; the Zig-backed adapter retains its own save format. */
export type SaveOptions = { sources?: 'embedded' | 'external' };
export type ScriptCodeRequest = {
  /** Base source first, then extensions in their saved order. */
  identities: readonly string[];
  name: string;
};
export type ScriptSources = { extensions?: readonly string[]; source: string };
export type RestoreOptions = GroupOptions & {
  grants(script: string, name: string): Grant<unknown> | undefined;
  libraries: readonly Library[];
  onMismatch: 'reject' | 'variables only' | 'reload changed';
  resolve(kind: string, id: string): { native: unknown } | undefined;
  /** Native TS external-source snapshots only. Different code requires a variables-only or Partial Restore. */
  scriptSources?(request: ScriptCodeRequest): ScriptSources | undefined;
};
export type PendingCall = {
  args: Value[];
  grant: string;
  id: string;
  operation: { capability: string; operation: string };
  script: string;
};
export type RestoreResult = {
  abandonedCalls: string[];
  discardedRuns: string[];
  disposed: [string, string][];
  droppedMessages: string[];
  pending: PendingCall[];
  /** The Scripts a Partial Restore rebuilt from their new code, in load order. */
  reloaded: string[];
  reports: Report[];
  variablesOnly: boolean;
};
export type Settlement =
  | { answer: Value }
  | { fail: HostScriptError }
  | { reissue: true }
  | { adopt: true };
export type CarryOver = 'reset variables' | 'carry variables';
export type CancellationOptions = { signal?: AbortSignal };
export type PumpOptions = { fuelCap?: number; fuelSlice?: number };
export type RunOutcome =
  | 'completed'
  | 'errored'
  | 'limit fault'
  | 'cancelled'
  | 'unhandled'
  | 'dropped'
  | 'effect failed';
/** The Trace's name for a limit a Limit Fault or failed cleanup passed. */
export type LimitWord =
  'fuel' | 'alloc' | 'persistent' | 'depth' | 'pattern' | 'join' | 'cleanup';
/** Where a Run ended: a code position and its source position. */
export type Location = {
  col: number;
  handler: string;
  line: number;
  pc: number;
  unit: string;
};
export type EffectFailure = {
  detail?: string;
  grant: string;
  phase: 'abandon' | 'begin' | 'commit' | 'rollback';
  run: string;
  scope?: string;
  script: string;
  segment: string;
  status: 'failed' | 'unknown';
};
export type Report =
  | AccountingReport
  | ChargeResult
  | {
      code: HostErrorCode;
      detail?: string;
      kind: 'host error';
    }
  | ({ kind: 'effect failure' } & EffectFailure)
  | {
      alloc: number;
      /** `errored`: the raise no Unwind Table entry caught; `limit fault`: the faulting instruction. */
      at?: Location;
      broadcast?: string;
      cleanupFailed?: { code: string } | { limit: Exclude<LimitWord, 'fuel'> };
      delivery?: string;
      effect?: EffectFailure;
      error?: ScriptError;
      /** Set when a Fallback Handler clause ran it; `handler` is then the Selector. */
      fallback?: boolean;
      fuel: number;
      handler?: string;
      kind: 'run end';
      limit?: LimitWord;
      outcome: RunOutcome;
      result?: Value;
      run?: string;
      script: string;
    }
  | {
      delivery: string;
      kind: 'unhandled';
      message: Message;
      /** The object it was delivered to; absent when addressed to a Script. */
      target?: HostObject;
    }
  | {
      call: string;
      /** What the Host did wrong; the Script saw only `host error`. */
      detail: string;
      kind: 'call failed';
      operation: OperationRef;
      script: string;
    }
  | {
      discardedRuns: string[];
      droppedMessages: string[];
      kind: 'stop';
      pendingCalls: string[];
      reason: string;
      script: string;
    }
  | ({ kind: 'decided' } & Decided);
export type PumpResult = {
  fuelUsed: number;
  /** The earliest deadline the next Pump could fire, if there is one. */
  nextDeadline?: bigint;
  reports: Report[];
  state: 'idle' | 'sliced' | 'stopped' | 'rewound';
};
/** A snapshot of lifetime work and current retained state. */
export type Counters = {
  allocTotal: number;
  faults: number;
  fuelTotal: number;
  mailboxLen: number;
  persistentState: number;
  runs: number;
};
export type RunView = {
  /** Suspended: the calls, replies or Join Members it still waits for. */
  calls?: string[];
  handler: string;
  id: string;
  status: 'preempted' | 'ready' | 'suspended' | 'parked';
  /** Suspended: its deadline, as its `seg` record's `until` gives it. */
  until?: bigint;
  /** Suspended: the `seg` end reason it suspended at. */
  wait?: string;
};
export type MessageView = {
  /** Absent for a message a Script sent. */
  delivery?: string;
  /** For a message a Script sent, the call or Run that sent it. */
  from?: string;
  message: Message;
};
export type Inspection = {
  scripts: {
    disabledGrants?: string[];
    mailbox: MessageView[];
    name: string;
    runs: RunView[];
    vars: [string, Value][];
  }[];
};

// The Trace's names for the limits a Limit Fault can pass (chapter 11).
const faultNames: Partial<Record<LimitName, LimitWord>> = {
  cleanupBudget: 'cleanup',
  fuelPerRun: 'fuel',
  allocPerRun: 'alloc',
  persistentState: 'persistent',
  callDepth: 'depth',
  patternSize: 'pattern',
  maxJoin: 'join',
};
const limitWord = (limit: LimitName): LimitWord => {
  const word = faultNames[limit];
  if (!word) {
    throw new Error(`no Limit Fault passes ${limit}`);
  }
  return word;
};
const overridable = new Set([
  'fuelPerRun',
  'allocPerRun',
  'maxWaitMs',
  'maxJoin',
]);

export type Decision = {
  ballots: Ballot[];
  broadcast: boolean;
  discarded?: boolean;
  id: string;
  resolve: (v: Decided) => void;
  settled?: boolean;
  unsubscribe?: () => void;
};
type Ballot = {
  decision: Decision;
  /** Its recipient Delivery's id. */
  delivery?: string;
  result?: {
    undecided?: Decided['undecided'][number];
    verdict: Verdict;
    veto?: Decided['vetoes'][number];
  };
};
export type Delivery = {
  ancestry?: RunAncestry;
  args: Value[];
  /** The object whose Owning Script holds it, which it climbs on from. */
  at: ObjectState | null;
  ballot?: Ballot;
  broadcast?: string;
  /** The failed message, for an internal `error` Delivery. */
  during?: Value;
  fn?: Value;
  /** For a message a Script sent, the sending Run. */
  from: string | null;
  /** The delivery id; a message a Script sent has none. */
  id: string | null;
  limits: LimitOverride;
  message: string;
  /** The current path starts here; a climb excludes the last owner that handled it. */
  path?: { after: boolean; from: ObjectState };
  /** For a `send … and wait`, the sender's call id, which the Run's end settles. */
  reply: string | null;
  request: { reject: (e: Error) => void; resolve: (v: Value) => void } | null;
  /** The object it was addressed to: `the target` all the way up. */
  target: ObjectState | null;
  unsubscribe?: () => void;
};
export type Running = {
  cleanupReady?: boolean;
  delivery: Delivery;
  id: string;
  parked?: boolean;
  recordsWritten?: number;
  /** Ready to resume from a Suspension Point, not a preemption. */
  resuming: boolean;
  /** Rewound while it ran: its turn ends and its message goes back (ADR 0068). */
  rewound?: boolean;
  run: Run;
  selected?: boolean;
};
// Whether two Runs took the same clause, for its Queueing Policy. A Fallback
// Handler clause is one clause whatever the message (ADR 0064).
const sameClause = (a: Running, b: Running): boolean =>
  a.run.fallback === b.run.fallback &&
  (a.run.fallback || a.delivery.message === b.delivery.message) &&
  a.run.clauseNumber === b.run.clauseNumber;
export type Timer = WaitTimer<Running, ScriptState>;
type TimerAction = WaitTimerAction<Running, ScriptState>;
type JoinWait = WaitJoin<Running, ScriptState>;
export type Pending = WaitPending<Running, ScriptState>;
export type Waiter = WaitWaiter<Running, ScriptState>;
type SourceUnit = {
  identity: string;
  imports: readonly Library[];
  source: string;
  tree: SemanticTree;
};
export type ScriptState = {
  /** Work charged to Runs that have ended or been discarded. */
  allocTotal: number;
  debt: number;
  disabled: Set<string>;
  faults: number;
  fuelTotal: number;
  grants: ReadonlyMap<string, Grant<unknown>>;
  handle: TsScript;
  identity: string;
  /** Deliveries queued to it that the next Pump drains. */
  incoming: number;
  limits: Limits;
  loaded: Loaded;
  name: string;
  /** The well-known Host Objects the Host bound at load, by name. */
  objects: Readonly<Record<string, HostObject>>;
  /** The object it owns, if any. */
  owner: ObjectState | null;
  parked: Running[];
  /** Messages waiting for dispatch, and a preempted Run at its head. */
  queue: (Delivery | Running)[];
  revoked: Set<string>;
  runs: number;
  stopped: boolean;
  stopReason?: string;
  /** Its suspended Runs, which Persistent State counts. */
  suspended: Set<Running>;
  /** Grant names without a Host implementation in this restored Group. */
  unbound: Set<string>;
  units: SourceUnit[];
};
export type InputAction =
  | { code: string; k: 'refusal' }
  | { id: string; k: 'cancel-delivery' }
  | { id: string; k: 'cancel-run'; name: string }
  | { id: string; k: 'rewind-run'; name: string }
  | { k: 'stop'; name: string; reason: string }
  | { grant: string; k: 'revoke'; name: string }
  | { fuel: number; id: string; k: 'answer'; value: Value }
  | { detail?: string; error: HostScriptError | null; id: string; k: 'fail' }
  | {
      delivery: Delivery;
      k: 'delivery';
      state: ScriptState | null;
      to: string | ObjectState;
    }
  | {
      decision?: Decision;
      id: string;
      k: 'broadcast';
      m: Message;
      recipients?: { delivery: Delivery; s: ScriptState }[];
    }
  | { child: ObjectState; k: 'set-parent'; up: ObjectState | null }
  | { k: 'dispose'; state: ObjectState }
  | { id: string; k: 'settle'; settlement: Settlement }
  | { k: 'charge'; q: QueuedCharge };
// An admitted charge request, until the Pump that processes it ends.
type QueuedCharge = {
  call: string;
  fuel: number;
  id: string;
  result?: ChargeResult;
  settle: (result: ChargeResult) => void;
};
type QueuedInput = {
  action: InputAction;
  line: string | (() => string);
  urgent?: boolean;
};

// Each granted Operation's mode, argument Shapes, labels and `command` flag, for the
// load checks and Host Command resolution.
const declarationsOf = (
  grants: ReadonlyMap<string, Grant<unknown>>,
): GrantDecls =>
  Object.fromEntries(
    [...grants].map(([name, grant]) => [
      name,
      Object.fromEntries(
        [...grant.ops].map(op => {
          const decl = grant.capability.operations.get(op)!;
          return [
            op,
            {
              mode: decl.mode,
              args: decl.args ?? [],
              ...(decl.labels?.length ? { labels: decl.labels } : {}),
              ...(decl.command ? { command: true } : {}),
            },
          ];
        }),
      ),
    ]),
  );

const keepOperations = (
  grant: Grant<unknown>,
  names: ReadonlySet<string>,
): Grant<unknown> => {
  const kept = new Set([...grant.ops].filter(name => names.has(name)));
  for (const name of kept) {
    const op = grant.capability.operations.get(name)!;
    if (op.mode === 'immediate' && op.scope && 'opens' in op.scope) {
      if (!grant.ops.has(op.scope.abandon)) {
        throw new HostError(
          'invalid value',
          'An opener requires granted abandonment',
        );
      }
      kept.add(op.scope.abandon);
    }
  }
  return { ...grant, ops: kept };
};

const usedOperations = (tree: SemanticTree, imports: readonly Library[]) => {
  const used = new Map<string, Set<string>>();
  for (const { capability, operation } of [
    ...operationUses(tree.root),
    ...imports.flatMap(library => library.needs),
  ]) {
    const operations = used.get(capability) ?? new Set<string>();
    operations.add(operation);
    used.set(capability, operations);
  }
  return used;
};

const availableGrants = (s: ScriptState) =>
  new Map([...s.grants].filter(([name]) => !s.revoked.has(name)));

/**
 * What a Script handle reaches its Group through: the Group's Script-only
 * operations, which aren't on the Group itself.
 */
type ScriptChannel = {
  combine: TsGroup['combine'];
  counters: TsGroup['scriptCounters'];
  extend: TsGroup['extend'];
  grants: TsGroup['scriptGrants'];
  queueCancelRun: TsGroup['queueCancelRun'];
  queueDecision: TsGroup['queueDecision'];
  queueDelivery: TsGroup['queueDelivery'];
  queueRevoke: TsGroup['queueRevoke'];
  queueRewindRun: TsGroup['queueRewindRun'];
  queueStop: TsGroup['queueStop'];
  reload: TsGroup['reload'];
  watchCancellation: TsGroup['watchCancellation'];
};

/** A handle for calls addressed to one Script. */
export class TsScript implements Script {
  constructor(
    private readonly group: ScriptChannel,
    readonly name: string,
  ) {}
  /** Worker. A snapshot of kept Operations, including revoked Grants. */
  grants(): Record<string, string[]> {
    return this.group.grants(this.name);
  }
  /** Worker. Lifetime totals and current state, without draining inputs. */
  counters(): Counters {
    return this.group.counters(this.name);
  }
  /** Queued. Returns the delivery id. */
  deliver(m: Message): string {
    return this.group.queueDelivery('deliver', this.name, m, null).id!;
  }
  /** Queued. Asks for a Verdict sealed in a Pump. */
  decide(m: Message, o?: CancellationOptions): Deciding {
    return this.group.queueDecision(this.name, m, o);
  }
  /** Queued. Settles when a Pump ends the Run, or rejects with `send failed`. */
  request(m: Message, o?: CancellationOptions): Requested {
    let settle!: Delivery['request'];
    const result = new Promise<Value>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // The Host may never read a failed result.
    result.catch(() => {});
    const delivery = this.group.queueDelivery('request', this.name, m, settle);
    this.group.watchCancellation(delivery, o?.signal);
    return { id: delivery.id!, result };
  }
  /** Queued. A Request for the answer only; use `request` for its id or a signal. */
  invoke(name: string, ...args: Value[]): Promise<Value> {
    return invoke(this, name, args);
  }
  /** Worker. Request this Script and perform exactly one Pump. */
  requestPump(
    m: Message,
    now: bigint,
    o?: PumpOptions & CancellationOptions,
  ): PumpedRequest {
    return this.group.combine(() => this.request(m, o), now, o);
  }
  reload(
    source: string,
    carry: CarryOver,
    o?: { keepMailbox?: boolean },
  ): Report[] {
    return this.group.reload(this.name, source, carry, o?.keepMailbox);
  }
  extend(source: string): void {
    this.group.extend(this.name, source);
  }
  stop(reason: string): void {
    this.group.queueStop(this.name, reason);
  }
  cancelRun(runId: string): void {
    this.group.queueCancelRun(this.name, runId);
  }
  /** Queued, landing as cancelRun does (ADR 0068). */
  rewindRun(runId: string): void {
    this.group.queueRewindRun(this.name, runId);
  }
  /** Queued. In-flight calls are left to the Host. */
  revoke(grantName: string): void {
    this.group.queueRevoke(this.name, grantName);
  }
}

export class TsGroup implements Group {
  private session: SessionPort | null = null;
  private readonly channel: ScriptChannel = {
    combine: (admit, now, o) => this.combine(admit, now, o),
    counters: name => this.scriptCounters(name),
    extend: (name, source) => this.extend(name, source),
    grants: name => this.scriptGrants(name),
    queueCancelRun: (name, id) => this.queueCancelRun(name, id),
    queueDecision: (name, m, o) => this.queueDecision(name, m, o),
    queueDelivery: (...a) => this.queueDelivery(...a),
    queueRevoke: (name, grant) => this.queueRevoke(name, grant),
    queueRewindRun: (name, id) => this.queueRewindRun(name, id),
    queueStop: (name, reason) => this.queueStop(name, reason),
    reload: (...a) => this.reload(...a),
    watchCancellation: (delivery, signal) =>
      this.watchCancellation(delivery, signal),
  };
  readonly name: string;
  private readonly trace: ((line: string) => void) | undefined;
  private readonly onReady: (() => void) | undefined;
  private readonly scripts: ScriptState[] = [];
  private readonly libraries = new Map<string, Library>();
  private readonly waits = new Waits<Running, ScriptState>();
  private readonly functionGroup = {};
  private readonly objects = new Map<string, ObjectState>();
  // The reports of the Pump draining the input queue.
  private drainReports: Report[] = [];
  private accounting = emptyAccounting();
  private discardReason = 'stop';
  private inputs: QueuedInput[] = [];
  private deliveries = 0;
  private broadcasts = 0;
  /**
   * Each Run's issued call ids' ranges, for the Group's lifetime, with
   * whether their calls may request charges (Metered Operations).
   */
  private issued = new Map<string, [number, number, boolean][]>();
  /** The last charge request id issued. */
  private chargeCounter = 0;
  /** Admitted charge requests whose futures haven't settled, in order. */
  private charges: QueuedCharge[] = [];
  /** How many waits have been set: the next wait's order. */
  private waitOrder = 0;
  /** Each root's discarded messages, for the Group's lifetime. */
  private rootDiscards = new Map<number, number>();
  /** The name a restored Group's save gave it, which its saves keep. */
  private savedName: string | undefined;
  private saves = 0;
  private lastClock: bigint | null = null;
  private randomState = seedState(0n);
  private pumping = false;
  private combining = false;
  private combinedAdmission = false;
  private cleaning = false;
  private effectStateUnknown = false;
  private terminalReports: (() => void)[] | null = null;
  private active: { records: number; running: Running; s: ScriptState } | null =
    null;
  private activeStop: (() => void) | null = null;
  /** A Rewind landed in this Pump, which returns at once (ADR 0068). */
  private rewound = false;
  private drainingTrace: string[] | null = null;
  private debugController: DebugController | null = null;
  private debugPump: Generator<DebugPause, PumpResult> | null = null;

  /**
   * The next `random(n)` draw from the Group's generator; `commit` advances
   * the generator past it (chapter 7, Random numbers).
   */
  private drawRandom(n: bigint): { commit(): void; value: bigint } {
    const next = nextRandom(this.randomState, n);
    return {
      value: next.value,
      commit: () => {
        this.randomState = next.state;
      },
    };
  }

  private ancestry(d: Delivery): RunAncestry {
    if (!d.ancestry) {
      if (d.id) {
        d.ancestry = { rootDelivery: d.id };
      } else {
        const parentRun = d.from!.replace(/\.c\d+$/, '');
        const parent = this.accounting.runs.get(parentRun);
        if (!parent) {
          throw new Error(`missing accounting parent ${parentRun}`);
        }
        d.ancestry = {
          rootDelivery: parent.report.rootDelivery,
          parentRun,
          ...(d.reply ? { parentCall: d.reply } : {}),
        };
      }
    }
    accountRoot(this.accounting, d.ancestry.rootDelivery);
    return d.ancestry;
  }

  private accountStart(s: ScriptState, r: Running) {
    const ancestry = this.ancestry(r.delivery);
    this.accounting.runs.set(r.id, {
      order: ++this.accounting.next,
      report: {
        kind: 'run accounting',
        ...ancestry,
        script: s.name,
        run: r.id,
        fuel: r.run.fuel,
        state: 'live',
      },
    });
    this.drainReports.push({
      kind: 'run started',
      ...ancestry,
      script: s.name,
      run: r.id,
      ...(r.delivery.id ? { delivery: r.delivery.id } : {}),
      ...(r.delivery.fn
        ? { fn: r.delivery.fn }
        : { selector: r.delivery.message }),
      args: [...r.delivery.args],
    });
  }

  private accountEnd(
    r: Running,
    state: 'terminal' | 'discarded',
    reason?: string,
  ) {
    const row = this.accounting.runs.get(r.id)!;
    if (row.report.state !== 'live') {
      return;
    }
    row.report.fuel = r.run.fuel;
    row.report.state = state;
    if (state === 'discarded') {
      this.drainReports.push({
        kind: 'run discarded',
        ...this.ancestry(r.delivery),
        script: row.report.script,
        run: r.id,
        reason: reason!,
      });
    }
  }

  private accountDrop(d: Delivery) {
    const a = this.ancestry(d);
    this.accounting.roots.get(a.rootDelivery)!.discarded++;
    const root = Number(a.rootDelivery.slice(1));
    this.rootDiscards.set(root, (this.rootDiscards.get(root) ?? 0) + 1);
  }

  /**
   * The roots whose work changed since the last accounting tail, which its
   * next tail reports: as a save holds them, without reporting them.
   */
  private changedRoots(): number[] {
    const queued = new Map<string, number>();
    const live = new Map<string, number>();
    const changed = new Set<string>();
    const count = (d: Delivery) => {
      const a = this.ancestry(d);
      queued.set(a.rootDelivery, (queued.get(a.rootDelivery) ?? 0) + 1);
    };
    for (const s of this.scripts) {
      for (const r of this.runsOf(s)) {
        const row = this.accounting.runs.get(r.id);
        if (row) {
          const root = row.report.rootDelivery;
          live.set(root, (live.get(root) ?? 0) + 1);
          if (row.reportedFuel !== r.run.fuel) {
            changed.add(root);
          }
        }
      }
      for (const item of s.queue) {
        if (!('run' in item)) {
          count(item);
        }
      }
    }
    for (const input of this.inputs) {
      if (input.action.k === 'delivery') {
        count(input.action.delivery);
      }
    }
    for (const [id, row] of this.accounting.runs) {
      if (row.report.state !== 'live' && !live.has(id)) {
        changed.add(row.report.rootDelivery);
      }
    }
    return [...this.accounting.roots]
      .filter(
        ([root, row]) =>
          changed.has(root) ||
          row.reported !==
            `${live.get(root) ?? 0}/${queued.get(root) ?? 0}/${row.discarded}`,
      )
      .map(([root]) => Number(root.slice(1)))
      .sort((a, b) => a - b);
  }

  private flushAccounting(reports: Report[]) {
    const queued = new Map<string, number>();
    const count = (d: Delivery) => {
      const a = this.ancestry(d);
      queued.set(a.rootDelivery, (queued.get(a.rootDelivery) ?? 0) + 1);
    };
    for (const s of this.scripts) {
      for (const r of this.runsOf(s)) {
        const row = this.accounting.runs.get(r.id);
        if (row?.report.state === 'live') {
          row.report.fuel = r.run.fuel;
        }
      }
      for (const item of s.queue) {
        if (!('run' in item)) {
          count(item);
        }
      }
    }
    for (const input of this.inputs) {
      if (input.action.k === 'delivery') {
        count(input.action.delivery);
      }
      if (input.action.k === 'broadcast') {
        for (const r of input.action.recipients ?? []) {
          count(r.delivery);
        }
      }
    }
    reports.push(...accountingTail(this.accounting, queued));
  }

  /** TS tooling only, outside the embedding interface and Trace parity. */
  debug(): DebugController {
    return (this.debugController ??= new DebugController(
      () => this.debugSnapshot(),
      () => this.advanceDebugPump(),
      () => {
        const sources: DebugSource[] = [];
        const seen = new Set<Code>();
        const visit = (code: Code, script?: string) => {
          if (seen.has(code)) {
            return;
          }
          seen.add(code);
          sources.push({
            unit: structuredClone(code.unit),
            ...(script ? { script } : {}),
            statements: code.unit.code.flatMap((instruction, pc) =>
              statementStarts.has(instruction) ? [pc] : [],
            ),
          });
          for (const library of code.libraries.values()) {
            visit(library);
          }
        };
        for (const s of this.scripts) {
          for (const code of s.loaded.units) {
            visit(code, s.name);
          }
        }
        for (const library of this.libraries.values()) {
          visit(codeOf(library));
        }
        return sources;
      },
      (body, frame) => this.debugEvaluate(body, frame),
    ));
  }

  /** Fuel an evaluation may spend before it fails. */
  private static readonly EVALUATION_FUEL = 1_000_000;

  // The Debug Controller's `evaluate`: a body run as an unapplied extension
  // of the paused Run's Script, its frame's named locals passed as
  // parameters, with nothing written to the Trace or the queues.
  private debugEvaluate(
    body: string,
    frameIndex: number | undefined,
  ): DebugEvaluation {
    const pause = this.debugController!.current!;
    const s = this.scripts.find(x => x.name === pause.script)!;
    const paused = this.runsOf(s).find(r => r.id === pause.run)!.run;
    const frames = paused.debugFrames();
    const view = frames[frameIndex ?? frames.length - 1];
    if (!view) {
      return { error: `There is no frame ${frameIndex}` };
    }
    const valueOf = (name: string) => {
      const j = view.frame.body.locals.indexOf(name);
      return j < 0 ? nothing : (view.frame.locals[j] ?? nothing);
    };
    // Named locals only: lowering's own slots aren't names a body can write.
    const locals = view.frame.body.locals.flatMap(name =>
      /^[A-Z_a-z]\w*$/.test(name) && name !== 'it'
        ? [[name, valueOf(name)] as const]
        : [],
    );
    let n = 1;
    while (body.includes(`debugEvaluation${n}`)) {
      n++;
    }
    const handler = `debugEvaluation${n}`;
    const names = locals.map(([name]) => name);
    // `it` can't be a parameter, so the body has its own.
    const source = `on ${[handler, names.join(', ')].filter(Boolean).join(' ')}\n${body}\nend ${handler}`;
    let loaded: Loaded;
    try {
      const prepared = this.extension(s, source);
      // Its diagnostics are the caller's, never the Trace's.
      loaded = this.loadPrepared(
        prepared.name,
        prepared.p,
        s.limits,
        {
          home: s.loaded,
          links: prepared.links,
          identity: prepared.extendedIdentity,
        },
        false,
      );
    } catch (error) {
      if (error instanceof LoadError) {
        const d = error.diagnostics[0];
        return d
          ? { error: d.message, line: Math.max(1, d.line - 1) }
          : { error: error.message };
      }
      throw error;
    }
    const run = dispatch(
      loaded,
      handler,
      locals.map(([, value]) => value),
      { fuelPerRun: TsGroup.EVALUATION_FUEL },
    );
    run.id = `${pause.run}/evaluation`;
    run.host = this.evaluationHost(s, run);
    const given = locals.map(([, value]) => value);
    while (!run.done) {
      if (run.suspended) {
        return { error: "A Run stopped at a Breakpoint can't wait" };
      }
      run.step();
      // The evaluation's own frame holds the locals as it was given them.
      const own = run.debugFrames()[0]?.frame;
      const changed =
        own?.handler === handler
          ? names.findIndex(
              (name, j) =>
                own.locals[own.body.locals.indexOf(name)] !== given[j],
            )
          : -1;
      if (changed >= 0) {
        return {
          error: `${names[changed]} is a local of the stopped Run, which can't be changed`,
        };
      }
    }
    // The extension has its own copy of the Script Variables, as one does
    // until attached; what the body wrote becomes the Script's.
    s.loaded.variables = loaded.variables.slice(0, s.loaded.variables.length);
    const outcome = run.ended!;
    switch (outcome.kind) {
      case 'completed':
        return { value: outcome.result };
      case 'errored':
        return { error: outcome.error.toString() };
      case 'limit fault':
        return { error: `${outcome.limit} limit reached` };
      default:
        return { error: `The evaluation ended: ${outcome.kind}` };
    }
  }

  // What an evaluation's Host does instead of what would leave a trace.
  private static refuse(what: string): never {
    throw new OpScriptError('not while stopped', [['what', text(what)]]);
  }

  // A Host for an evaluation: it reads the Script's world, but refuses
  // anything that would reach the Trace, a queue or the random stream.
  private evaluationHost(s: ScriptState, run: Run): RunHost {
    const host = this.hostFor(s, run, null);
    return {
      ...host,
      grants: new Map(),
      answer: () => TsGroup.refuse('an Operation call'),
      fail: () => TsGroup.refuse('an Operation call'),
      callValue: () => TsGroup.refuse('a call to another Script'),
      send: () => TsGroup.refuse('a send'),
      sendUp: () => TsGroup.refuse('a send'),
      drawRandom: () => TsGroup.refuse('a random draw'),
      disableGrant: () => TsGroup.refuse('an Operation call'),
      crossing: () => false,
      expose: () => {},
      issue: () => {},
    };
  }

  private advanceDebugPump(): PumpResult {
    const pump = this.debugPump!;
    let next: IteratorResult<DebugPause, PumpResult>;
    try {
      next = pump.next();
    } catch (error) {
      this.debugPump = null;
      this.active = null;
      this.activeStop = null;
      this.pumping = false;
      throw error;
    }
    if (next.done) {
      this.debugPump = null;
      this.active = null;
      this.activeStop = null;
      this.pumping = false;
      return next.value;
    }
    this.debugController!.enter(next.value);
    // A provisional result only. The retained Pump has not written `pumped`.
    return { state: 'sliced', fuelUsed: 0, reports: [] };
  }

  private attachSession(port: SessionPort) {
    this.session = port;
    port.connect({
      queuedInputs: () => this.inputs.length > 0,
      reply: (id, reply) => this.settleReply(id, reply),
    });
  }

  /** Worker. A Fingerprint covers code, declarations and limits, never state. */
  fingerprint(): Uint8Array {
    this.worker();
    const scripts = [...this.scripts].sort(byName).map(s => ({
      name: s.name,
      identity: s.identity,
      grants: Object.fromEntries(
        [...s.grants]
          .sort(([a], [b]) => compareNames(a, b))
          .map(([name, grant]) => [name, grantData(grant)]),
      ),
      limits: Object.fromEntries(
        Object.keys(defaultLimits).map(name => [
          name,
          s.limits[name as LimitName],
        ]),
      ),
    }));
    return hexBytes(
      sha256(
        canonicalJSON({
          language: languageVersion,
          costModel: costModel.version,
          libraries: [...this.libraries.values()]
            .sort(byName)
            .map(l => [l.name, identityOf(l)]),
          scripts,
        }),
      ),
    );
  }

  save(o: SaveOptions = {}): Uint8Array {
    this.worker();
    if (
      o.sources !== undefined &&
      o.sources !== 'embedded' &&
      o.sources !== 'external'
    ) {
      throw new HostError('invalid value', 'Unknown snapshot source mode');
    }
    const id = `s${++this.saves}`;
    if (this.effectsPending()) {
      this.trace?.(recordLine('save', [id], [], true));
      this.trace?.(
        recordLine(
          'refused',
          [],
          [['code', JSON.stringify('effects pending')]],
        ),
      );
      throw new HostError('effects pending');
    }
    const bytes = encodeGroup({
      ...this.snapshot(),
      sources: o.sources ?? 'embedded',
    });
    this.trace?.(recordLine('save', [id], [], true));
    return bytes;
  }

  /** Worker. Refused as a save would be, but writes no Trace record. */
  stateFingerprint(): Uint8Array {
    this.worker();
    if (this.effectsPending()) {
      throw new HostError('effects pending');
    }
    return stateFingerprint(this.snapshot());
  }

  private effectsPending(): boolean {
    return (
      this.effectStateUnknown ||
      this.charges.length > 0 ||
      this.waits
        .awaitedCalls(() => this.holders(), compareCallIds)
        .some(([id]) => this.issuedEligibility(id) === true) ||
      this.scripts.some(s =>
        this.runsOf(s).some(r => r.run.hasOpenScopes || r.run.hasParticipant),
      )
    );
  }

  private snapshot(): Omit<GroupSnapshot, 'sources'> {
    return {
      accounting: this.accounting,
      broadcasts: this.broadcasts,
      changedRoots: this.changedRoots(),
      rootDiscards: this.rootDiscards,
      deliveries: this.deliveries,
      discardedDecisions: this.discardedDecisions,
      fingerprint: this.fingerprint(),
      inputs: this.inputs,
      issued: this.issued,
      chargeCounter: this.chargeCounter,
      lastClock: this.lastClock,
      libraries: this.libraries,
      name: this.savedName ?? this.name,
      objects: this.objects,
      randomState: this.randomState,
      saves: this.saves,
      scripts: this.scripts,
      waitOrder: this.waitOrder,
      waits: this.waits,
    };
  }

  /** Build and check the complete replacement before publishing the Group. */
  static restore(
    bytes: Uint8Array,
    o: TsRestoreOptions,
  ): { group: TsGroup; result: RestoreResult } {
    const save = decodeSave(bytes);
    let emitting = false;
    const group = new TsGroup({
      name: o.name,
      onReady: o.onReady,
      trace: o.trace
        ? line => {
            if (emitting) {
              o.trace?.(line);
            }
          }
        : undefined,
    });
    const saveId = `s${save.saveIdCounter}`;
    const disposed: [string, string][] = [];
    const unbound: string[] = [];
    const objects: ObjectState[] = [];
    for (const object of save.objects) {
      const kind = objectKind(object.kind);
      if (!kind) {
        throw new HostError(
          'save mismatch',
          `Unknown Object Kind ${object.kind}`,
        );
      }
      const key = `${object.kind}\u0000${object.id}`;
      if (group.objects.has(key)) {
        invalidSave();
      }
      const state = makeObject(kind, object.id, undefined);
      state.disposed = object.disposed;
      group.objects.set(key, state);
      objects.push(state);
    }
    save.objects.forEach((object, i) => {
      objects[i]!.parent =
        object.parent === undefined ? null : objects[object.parent]!;
    });
    for (const library of o.libraries) {
      group.libraries.set(library.name, library);
    }
    let mismatch = save.libraries.some(
      l =>
        !group.libraries.has(l.name) ||
        identityOf(group.libraries.get(l.name)!) !== hexOf(l.identity),
    );
    // A mismatch in anything but Script code is never partial (ADR 0143).
    let wholeGroup =
      save.language !== languageVersion || save.costModel !== costModel.version;
    const changed = new Set<string>();
    let loadFailure: LoadError | undefined;
    const names = new Set<string>();
    for (const [i, script] of save.scripts.entries()) {
      if (names.has(script.name)) {
        invalidSave();
      }
      names.add(script.name);
      const identities = [script.identity, ...script.extensions].map(hexOf);
      const embedded = save.sources?.[i];
      if (
        save.sources &&
        (!embedded || embedded.extensions.length !== script.extensions.length)
      ) {
        invalidSave();
      }
      const supplied = save.sources
        ? undefined
        : o.scriptSources?.({ name: script.name, identities: [...identities] });
      if (!save.sources && !supplied) {
        throw new HostError(
          'save mismatch',
          `Missing sources for Script ${script.name}`,
        );
      }
      const sources = supplied
        ? [supplied.source, ...(supplied.extensions ?? [])]
        : [embedded!.source, ...embedded!.extensions];
      if (sources.some(source => typeof source !== 'string')) {
        throw new HostError('invalid value', 'Script sources must be text');
      }
      const grants: Record<string, Grant<unknown>> = Object.create(null);
      const revoked = new Set<string>();
      const grantNames = new Set<string>();
      for (const grant of script.grants) {
        if (grantNames.has(grant.name)) {
          invalidSave();
        }
        grantNames.add(grant.name);
        const declared = operationsOf(grant.declarations);
        if (
          declared.capability !== grant.capability ||
          grant.operations.some(op => !declared.operations.has(op.name))
        ) {
          invalidSave();
        }
        const offered = o.grants(script.name, grant.name);
        const rebound = offered
          ? keepOperations(
              offered,
              new Set(grant.operations.map(op => op.name)),
            )
          : undefined;
        // A pruned Grant can retain a closer without its opener. These are
        // saved declarations, not a new Host Capability definition.
        const placeholder: Grant<unknown> = {
          binding: undefined,
          ops: new Set(grant.operations.map(op => op.name)),
          capability: {
            name: grant.capability,
            operations: declared.operations,
            grant: () => {
              throw new HostError(
                'invalid value',
                'A saved declaration has no Host implementation',
              );
            },
          },
        };
        if (!rebound) {
          revoked.add(grant.name);
          unbound.push(`${script.name}.${grant.name}`);
        } else if (canonicalJSON(grantData(rebound)) !== grant.declarations) {
          wholeGroup = true;
        }
        grants[grant.name] = rebound ?? placeholder;
      }
      if (loadFailure) {
        continue;
      }
      try {
        group.load({
          name: script.name,
          source: sources[0]!,
          limits: limitsOf(script.limits),
          grants,
          owner:
            script.owner === undefined
              ? undefined
              : objects[script.owner]!.handle,
          objects: Object.fromEntries(
            script.objects.map(x => [
              x.name,
              (x.object === undefined ? invalidSave() : objects[x.object]!)
                .handle,
            ]),
          ),
        });
        const state = group.scripts.at(-1)!;
        for (const source of sources.slice(1)) {
          group.applyExtension(state, source, undefined, false);
        }
        if (
          state.units.length !== identities.length ||
          state.units.some((unit, i) => unit.identity !== identities[i])
        ) {
          changed.add(script.name);
        }
        state.revoked = revoked;
        state.unbound = new Set(revoked);
      } catch (error) {
        if (!(error instanceof LoadError)) {
          throw error;
        }
        loadFailure = error;
      }
    }
    save.objects.forEach((object, i) => {
      objects[i]!.owner = object.ownerOf ?? null;
    });
    const savedFingerprint = hexOf(save.groupFingerprint);
    mismatch ||=
      wholeGroup ||
      changed.size > 0 ||
      hexOf(group.fingerprint()) !== savedFingerprint;
    const partial =
      mismatch && !wholeGroup && o.onMismatch === 'reload changed';
    const variablesOnly = mismatch && !partial;
    const withheld = save.libraries
      .filter(l => !group.libraries.has(l.name))
      .map(l => l.name);
    const restoreLine = (result?: RestoreResult) =>
      recordLine(
        'restore',
        [],
        [
          ['from', saveId],
          [
            'mismatch',
            o.onMismatch === 'variables only'
              ? 'variables-only'
              : o.onMismatch === 'reload changed'
                ? 'reload-changed'
                : null,
          ],
          ['unbound', unbound.length ? idList(unbound) : null],
          ['withheld', withheld.length ? idList(withheld) : null],
          ['fingerprint', savedFingerprint],
          [
            'mode',
            result
              ? result.variablesOnly
                ? 'variables-only'
                : partial
                  ? 'partial'
                  : 'full'
              : null,
          ],
          [
            'reloaded',
            result?.reloaded.length ? idList(result.reloaded) : null,
          ],
          [
            'pending',
            result?.pending.length
              ? idList(result.pending.map(p => p.id))
              : null,
          ],
          [
            'disposed',
            disposed.length
              ? traceValue(
                  listValues(
                    disposed.map(
                      ([kind, id]) =>
                        group.objects.get(`${kind}\u0000${id}`)!.handle.value,
                    ),
                  ),
                )
              : null,
          ],
          [
            'discarded',
            result?.discardedRuns.length ? idList(result.discardedRuns) : null,
          ],
          [
            'dropped',
            result?.droppedMessages.length
              ? idList(result.droppedMessages)
              : null,
          ],
          [
            'abandoned',
            result?.abandonedCalls.length
              ? idList(result.abandonedCalls)
              : null,
          ],
        ],
        true,
      );
    if (mismatch && o.onMismatch === 'reject') {
      o.trace?.(restoreLine());
      o.trace?.(recordLine('refused', [], [['code', '"save mismatch"']]));
      throw new HostError('save mismatch');
    }
    if (loadFailure) {
      throw loadFailure;
    }
    for (const [i, object] of save.objects.entries()) {
      const resolved = o.resolve(object.kind, object.id);
      const state = objects[i]!;
      rebindObject(state, resolved?.native);
      state.disposed = object.disposed || !resolved;
      if (!resolved) {
        disposed.push([object.kind, object.id]);
      }
    }
    for (const [i, script] of save.scripts.entries()) {
      group.scripts[i]!.objects = Object.fromEntries(
        script.objects.map(x => [x.name, objects[x.object!]!.handle]),
      );
    }
    const state = group.readState(
      save,
      objects,
      partial ? changed : variablesOnly,
    );
    const result: RestoreResult = {
      reports: [],
      variablesOnly,
      reloaded: partial
        ? save.scripts.flatMap(s => (changed.has(s.name) ? [s.name] : []))
        : [],
      pending: [],
      disposed,
      discardedRuns: [],
      droppedMessages: [],
      abandonedCalls: [],
    };
    group.drainReports = result.reports;
    group.saves = save.saveIdCounter;
    group.savedName = save.group.name;
    group.applyState(state, { partial, changed, variablesOnly, result });
    group.flushAccounting(result.reports);
    emitting = true;
    o.trace?.(restoreLine(result));
    if (o.session) {
      group.attachSession(o.session);
    }
    return { group, result };
  }

  /**
   * A save's second pass: its values, read against the restored Scripts'
   * code, and every section that holds them.
   */
  private readState(
    save: DecodedSave,
    objects: readonly ObjectState[],
    changed: boolean | ReadonlySet<string>,
  ) {
    const stale = (home: string) =>
      changed === true || (changed !== false && changed.has(home));
    const byName = new Map(this.scripts.map(s => [s.name, s]));
    const codes = save.functions.map((f): unknown => {
      const s = byName.get(f.home);
      if (f.body && s && !stale(f.home)) {
        const code = this.unitCode(s, f.body.unit, save);
        const body = code.unit.bodies[f.body.body] ?? invalidSave();
        const head = functionHead({ body })!;
        if (
          head.min !== f.required ||
          head.max !== f.total ||
          (head.name ?? '') !== f.name ||
          code.identity !== hexOf(f.unit)
        ) {
          invalidSave();
        }
        return { code, body, home: s.loaded };
      }
      if (f.total < f.required) {
        invalidSave();
      }
      // A stale named function still answers its documentation, from its
      // unit if the Script still holds it.
      const unit = s?.loaded.units.find(u => u.identity === hexOf(f.unit));
      const body = f.name
        ? unit?.unit.bodies.find(
            b => b.kind === 'function' && b.name === f.name,
          )
        : undefined;
      return {
        home: { live: false },
        ...(body?.doc ? { doc: body.doc } : {}),
        head: { min: f.required, max: f.total, name: f.name || null },
        unit: hexOf(f.unit),
      };
    });
    const values = new ValueReader(
      objects,
      save.functions.map(f => f.home),
      (i, display, home, captures) => {
        const { home: displayHome, place } = placeOf(display);
        const c = (
          i === undefined
            ? {
                home: { live: false },
                head: { min: 0, max: 0, name: null },
                unit: '',
              }
            : codes[i]
        ) as {
          body?: Body;
          code?: Code;
          home: { live?: boolean; name?: string };
          unit?: string;
        };
        const live = !!c.body && !!c.code;
        if (live && c.home.name !== home) {
          invalidSave();
        }
        const v = functionValue({
          group: this.functionGroup,
          home,
          displayHome,
          place,
          identity: live
            ? `${home}#${c.code!.identity || c.code!.name}#${c.body!.index}`
            : `${home}#${c.unit}#${place}`,
          maySuspend: live ? c.body!.maySuspend : false,
          captures,
          code: c,
        });
        return v.toString() === display ? v : invalidSave();
      },
    );
    const tables = {
      calls: 0,
      libraries: save.libraries.length,
      objects: objects.length,
      runs: 0,
    };
    const section = <T>(
      tag: number,
      read: (r: RecordReader<Value>) => T,
    ): T => {
      const r = new RecordReader(save.reader(tag), values, tables);
      const out = read(r);
      r.r.end();
      return out;
    };
    const calls = section(saveSections.calls, r => r.calls());
    tables.calls = calls.length;
    const scripts = section(saveSections.scripts, r => r.scripts());
    const { perScript, runs } = section(saveSections.runs, r => r.runs());
    tables.runs = runs.length;
    const work = section(saveSections.work, r => r.work());
    const waits = section(saveSections.waits, r => r.waits());
    const inputs = section(saveSections.inputs, r => r.inputs());
    const decisions = section(saveSections.decisions, r => r.decisions());
    const accounting = section(saveSections.accounting, r => r.accounting());
    if (
      perScript.length !== scripts.length ||
      work.length !== scripts.length ||
      perScript.reduce((a, b) => a + b, 0) !== runs.length
    ) {
      invalidSave();
    }
    return {
      calls,
      scripts,
      perScript,
      runs,
      work,
      waits,
      inputs,
      decisions,
      accounting,
      group: save.group,
      save,
    };
  }

  /** A unit's code, relative to a Script, as a save names it. */
  private unitCode(s: ScriptState, unit: Unit, save: DecodedSave): Code {
    switch (unit.k) {
      case 'own':
        return s.loaded.units[0]!;
      case 'extension':
        return s.loaded.units[unit.extension + 1] ?? invalidSave();
      case 'library':
      case 'stdlib': {
        const name =
          unit.k === 'stdlib'
            ? unit.name
            : (save.libraries[unit.library] ?? invalidSave()).name;
        const seen = new Set<Code>();
        const work = [...s.loaded.units];
        while (work.length) {
          const code = work.pop()!;
          for (const [n, imported] of code.libraries) {
            if (n === name && imported.stdlib === (unit.k === 'stdlib')) {
              return imported;
            }
            if (!seen.has(imported)) {
              seen.add(imported);
              work.push(imported);
            }
          }
        }
        return invalidSave();
      }
    }
  }

  /** Publishes a save's state in the restored Group. */
  private applyState(
    state: ReturnType<TsGroup['readState']>,
    o: {
      changed: ReadonlySet<string>;
      partial: boolean;
      result: RestoreResult;
      variablesOnly: boolean;
    },
  ) {
    const { result, variablesOnly, partial, changed } = o;
    const objects = [...this.objects.values()];
    const g = state.group;
    this.deliveries = g.deliveries;
    this.broadcasts = g.broadcasts;
    this.lastClock = g.clock.seconds * 1_000_000n + BigInt(g.clock.micros);
    this.randomState = g.randomState;
    this.waitOrder = g.timers;
    this.chargeCounter = g.chargeCounter;
    for (const x of g.issued) {
      if (!x.ranges.length) {
        invalidSave();
      }
      this.issued.set(
        x.run,
        x.ranges.map(r => [r.first, r.last, r.eligible]),
      );
    }
    for (const d of state.accounting.discards) {
      this.rootDiscards.set(d.root, d.discarded);
    }
    const object = (i: number | undefined) =>
      i === undefined ? null : (objects[i] ?? invalidSave());
    // Every Decision a save holds, by its id, so its ballots are shared.
    const decisions = new Map<string, Decision>();
    const decisionOf = (id: string, broadcast: boolean) => {
      let d = decisions.get(id);
      if (!d) {
        d = { id, broadcast, ballots: [], resolve: () => {} };
        decisions.set(id, d);
      }
      return d;
    };
    const markOf = (m: Mark<Value>) => m;
    const resultOf = (part: Part<Value>): Ballot['result'] =>
      part.k === 'allowed'
        ? { verdict: 'allowed' }
        : part.k === 'vetoed'
          ? {
              verdict: 'vetoed',
              veto: {
                script: markOf(part.mark).script,
                run: part.mark.run,
                reason: part.mark.reason ?? nothing,
              },
            }
          : part.k === 'undecided'
            ? {
                verdict: 'undecided',
                undecided: {
                  script: part.mark.script,
                  ...(part.mark.run ? { run: part.mark.run } : {}),
                  outcome: part.mark.outcome as RunOutcome,
                },
              }
            : undefined;
    const openParts = new Map<number, Part<Value>>();
    for (const b of state.decisions.open) {
      const d = decisionOf(`b${b.id}`, true);
      for (const p of b.parts) {
        const ballot: Ballot = { decision: d, delivery: `d${p.delivery}` };
        const r = resultOf(p.part);
        if (r) {
          ballot.result = r;
        }
        d.ballots.push(ballot);
        openParts.set(p.delivery, p.part);
      }
    }
    const deliveryOf = (
      rec: DeliveryRecord<Value>,
      s: ScriptState | null,
      verdict = false,
    ): Delivery => {
      const id = rec.id ? `d${rec.id}` : null;
      const reply = rec.waits ? (rec.from ?? invalidSave()) : null;
      const target = object(rec.target);
      const at = object(rec.at);
      const passedBy = object(rec.passedBy);
      const owner = s?.owner ?? null;
      const d: Delivery = {
        id,
        from: rec.from ?? null,
        message: rec.message,
        args: rec.args,
        limits: Object.fromEntries(
          Object.entries(rec.limits ?? {}).filter(([, v]) => v !== undefined),
        ) as LimitOverride,
        reply,
        // The Host's future belongs to the old Group; a restored Delivery
        // keeps only that its sender waits.
        request: rec.request ? detachedRequest : null,
        ...(rec.during ? { during: rec.during } : {}),
        ...(rec.function ? { fn: rec.function } : {}),
        ...(rec.broadcast ? { broadcast: `b${rec.broadcast}` } : {}),
        // A message on an object's path reads it from the object it is
        // at, or after a climb from the parent of the one that passed it.
        ...(passedBy
          ? { path: { after: true, from: passedBy } }
          : at
            ? { path: { after: false, from: at } }
            : {}),
        target: passedBy || at ? target : rec.broadcast ? null : owner,
        at: passedBy ? at : at ? (this.route(at)?.at ?? null) : owner,
      };
      if (rec.function && rec.function.kind !== 'function') {
        invalidSave();
      }
      d.ancestry = {
        rootDelivery: rec.root ? `d${rec.root}` : (id ?? invalidSave()),
        ...(rec.from
          ? {
              parentRun: rec.from.replace(/\.c\d+$/, ''),
              ...(reply ? { parentCall: reply } : {}),
            }
          : {}),
      };
      if (rec.decides) {
        const d0 = rec.broadcast
          ? decisionOf(`b${rec.broadcast}`, true)
          : decisionOf(id ?? invalidSave(), false);
        let ballot = d0.ballots.find(b => b.delivery === id);
        if (!ballot) {
          ballot = { decision: d0, delivery: id! };
          d0.ballots.push(ballot);
          if (!rec.decision && !verdict) {
            ballot.result = { verdict: 'allowed' };
          }
        }
        d.ballot = ballot;
      }
      this.ancestry(d);
      return d;
    };

    // Accounting: each live Run's row, and each root's work.
    this.accounting.next = g.runOrder;
    // Calls, as their Runs' contexts: the Operation comes from their waits.
    const operations = new Map<number, string>();
    for (const r of state.runs) {
      for (const w of [
        r.waiting,
        r.waited,
        ...(r.join?.members.flatMap(m => [m.pending, m.waited]) ?? []),
      ]) {
        if (w?.call !== undefined) {
          operations.set(w.call, w.operation);
        }
      }
    }
    const contexts = new Map<number, CallContext>();
    const runIndex = new Map<string, number>();
    state.runs.forEach((r, i) => runIndex.set(r.id, i));
    const callOf = (i: number, s: ScriptState): CallContext => {
      let ctx = contexts.get(i);
      if (ctx) {
        return ctx;
      }
      const c = state.calls[i] ?? invalidSave();
      const operation = operations.get(i) ?? invalidSave();
      if (c.script !== s.name) {
        invalidSave();
      }
      const grant = s.grants.get(c.grant) ?? invalidSave();
      const op = grant.capability.operations.get(operation) ?? invalidSave();
      const unit =
        [...s.loaded.units].find(u => u.name === c.atUnit) ??
        this.libraryCode(s, c.atUnit);
      const ins = unit?.unit.code[c.atPc];
      ctx = {
        id: c.id,
        op,
        rate: ins?.rate ?? -1,
        named: [
          ['capability', text(c.grant)],
          ['operation', text(operation)],
        ],
        declared: op.cost.fuel,
        opName: `${c.grant}.${operation}`,
        adoptable: c.start,
        ...(op.mode === 'suspending' && standardChecks(op)?.result
          ? { args: [...c.args] }
          : {}),
      };
      callSites.set(ctx, {
        args: c.args,
        charged: c.charged,
        at: { unit: c.atUnit, pc: c.atPc, line: c.atLine, col: c.atColumn },
        now: c.now.seconds * 1_000_000n + BigInt(c.now.micros),
        // Before any call this Group makes, in the order they were made.
        order: Number.MIN_SAFE_INTEGER + i,
        segment: c.segment,
      });
      contexts.set(i, ctx);
      return ctx;
    };

    // Each Script's counters, variables and Runs.
    let at = 0;
    const restored: {
      pendingId?: string;
      rec: (typeof state.runs)[number];
      running: Running;
      s: ScriptState;
    }[] = [];
    const carried = new Map<ScriptState, Value[]>();
    for (const [i, sr] of state.scripts.entries()) {
      const script = this.scripts[i]!;
      if (sr.name !== script.name) {
        invalidSave();
      }
      script.runs = sr.runs;
      script.fuelTotal = sr.fuelTotal;
      script.allocTotal = sr.allocTotal;
      script.faults = sr.faults;
      script.disabled = new Set(
        sr.grants.filter(x => x.disabled).map(x => x.name),
      );
      for (const x of sr.grants) {
        if (x.revoked) {
          script.revoked.add(x.name);
        }
      }
      if (sr.variableNames.length !== sr.variables.length) {
        invalidSave();
      }
      const reloading = partial && changed.has(script.name);
      const skim = variablesOnly || reloading;
      const records = state.runs.slice(at, at + state.perScript[i]!);
      at += state.perScript[i]!;
      for (const rec of records) {
        if (!rec.id.startsWith(`${script.name}/r`)) {
          invalidSave();
        }
        const verdictHeld = rec.verdict;
        const running = skim
          ? skimRun(
              rec,
              script,
              deliveryOf(rec.delivery, script, verdictHeld),
              c => (state.calls[c] ?? invalidSave()).id,
            )
          : (() => {
              const out = runFromRecord(rec, {
                script,
                now: this.lastClock!,
                invalid: invalidSave,
                code: unit => this.unitCode(script, unit, state.save),
                call: c => callOf(c, script),
                delivery: d => deliveryOf(d, script, verdictHeld),
                make: () => {
                  const run = new Run(
                    script.loaded,
                    script.loaded.unit.bodies[0]!,
                    [],
                    limitsOf(rec.limits),
                  );
                  return run;
                },
              });
              return out;
            })();
        const r = 'running' in running ? running.running : running;
        if (skim) {
          skimmed.add(r);
        }
        restored.push({
          running: r,
          rec,
          s: script,
          ...('pendingId' in running && running.pendingId
            ? { pendingId: running.pendingId }
            : {}),
        });
        this.accounting.runs.set(rec.id, {
          order: rec.order,
          report: {
            kind: 'run accounting',
            ...this.ancestry(r.delivery),
            script: script.name,
            run: rec.id,
            fuel: rec.fuel,
            state: 'live',
          },
        });
        markRest(r, { fuel: rec.segmentFuel, alloc: rec.segmentAlloc });
      }
      let variables = sr.variables;
      if (skim) {
        for (const x of restored.filter(x => x.s === script)) {
          if (x.rec.continuing && x.rec.segmentBase) {
            variables = x.rec.segmentBase;
          }
        }
      }
      const kept = script.loaded.variableNames.map((name, j) => {
        const old = sr.variableNames.indexOf(name);
        return old >= 0 ? variables[old]! : script.loaded.variables[j]!;
      });
      if (reloading) {
        carried.set(script, kept);
      } else if (!variablesOnly) {
        // Only a full restore's Runs see the extensions' first values, as
        // their segment bases do.
        script.loaded.variables = kept;
      } else {
        script.loaded.variables = kept;
      }
      if (!skim) {
        script.loaded.live = sr.stopped === undefined;
        const definitions = script.loaded.units.flatMap(u => u.definitions);
        if (sr.definitions.length !== definitions.length) {
          invalidSave();
        }
        let d = 0;
        for (const unit of script.loaded.units) {
          for (let k = 0; k < unit.definitions.length; k++) {
            unit.definitions[k] = sr.definitions[d++]!;
          }
        }
      }
    }
    // Each Script's work, suspended and parked Runs.
    const runningAt = (i: number) => restored[i]?.running ?? invalidSave();
    for (const [i, script] of this.scripts.entries()) {
      const mine = restored.filter(x => x.s === script);
      const queue = state.work[i]!.map(item =>
        item.k === 'run'
          ? restored[item.run]?.s === script
            ? runningAt(item.run)
            : invalidSave()
          : deliveryOf(item.delivery, script),
      );
      const queued = new Set(queue.filter((q): q is Running => 'run' in q));
      const suspended = new Set<Running>();
      const parked: Running[] = [];
      for (const x of mine) {
        if (x.rec.parked) {
          parked.push(x.running);
        } else if (!queued.has(x.running)) {
          suspended.add(x.running);
        }
        if (x.rec.parked && queued.has(x.running)) {
          invalidSave();
        }
      }
      const sr = state.scripts[i]!;
      Object.assign(script, {
        debt: sr.debt,
        incoming: 0,
        parked,
        queue,
        stopped: sr.stopped !== undefined,
        ...(sr.stopped !== undefined ? { stopReason: sr.stopped } : {}),
        suspended,
      });
    }
    // Discarded Decisions a variables-only restore left for the first Pump.
    for (const x of state.decisions.deferred) {
      const d = decisionOf(
        x.broadcast ? `b${x.broadcast}` : `d${x.id}`,
        !!x.broadcast,
      );
      d.discarded = true;
      const ballot: Ballot = {
        decision: d,
        delivery: `d${x.id}`,
        ...(x.mark
          ? {
              result: resultOf({
                k: x.mark.outcome === 'vetoed' ? 'vetoed' : 'undecided',
                mark: x.mark,
              } as Part<Value>)!,
            }
          : {}),
      };
      d.ballots.push(ballot);
      if (!this.discardedDecisions.includes(d)) {
        this.discardedDecisions.push(d);
      }
    }
    // The Host inputs queued for the next Pump.
    const inputs = state.inputs.map(x =>
      this.inputOf(x, deliveryOf, object, decisionOf),
    );
    for (const input of inputs) {
      if (input.action.k === 'delivery' && input.action.state) {
        input.action.state.incoming++;
      }
    }

    if (variablesOnly) {
      for (const [i, script] of this.scripts.entries()) {
        const mine = restored.filter(x => x.s === script);
        result.discardedRuns.push(...mine.map(x => x.running.id));
        result.droppedMessages.push(
          ...script.queue
            .filter((q): q is Delivery => !('run' in q))
            .flatMap(d => (d.id ? [d.id] : [])),
        );
        for (const x of mine) {
          this.accountEnd(x.running, 'discarded', 'variables-only restore');
          this.accumulateRunCosts(script, x.running.run);
          this.discardDecision(x.running.delivery, script.name, x.running.id);
        }
        for (const item of script.queue) {
          if (!('run' in item)) {
            this.accountDrop(item);
            this.discardDecision(item, script.name);
          }
        }
        Object.assign(script, {
          queue: [],
          suspended: new Set(),
          parked: [],
          debt: 0,
        });
        script.stopped = false;
        delete script.stopReason;
        void i;
        if (script.loaded.variablesSize() > script.limits.persistentState) {
          throw new HostError('state too large');
        }
      }
      const pending = new Set<string>();
      for (const x of restored) {
        for (const id of awaitedCallIds(x.rec, state.calls)) {
          pending.add(id);
        }
      }
      result.abandonedCalls = [...pending].sort(compareCallIds);
      for (const input of inputs) {
        if (input.action.k === 'delivery') {
          const delivery = input.action.delivery;
          if (delivery.id) {
            result.droppedMessages.push(delivery.id);
          }
          const action = input.action;
          const name =
            action.state?.name ??
            (typeof action.to === 'string' ? action.to : action.to.owner) ??
            '';
          this.accountDrop(delivery);
          this.discardDecision(delivery, name);
        } else if (input.action.k === 'broadcast' && input.action.decision) {
          input.action.decision.discarded = true;
          this.discardedDecisions.push(input.action.decision);
        }
      }
      for (const s of this.scripts) {
        s.incoming = 0;
      }
    } else {
      this.importWaits(state, restored);
      this.inputs = inputs;
      for (const x of restored) {
        if (partial && changed.has(x.s.name)) {
          continue;
        }
        x.running.run.validateSnapshot(this.knownCode());
        x.running.run.host = this.hostFor(
          x.s,
          x.running.run,
          x.running.delivery.id,
        );
        x.running.run.persistentState = () => this.persistentState(x.s, 1);
      }
      const abandoned: string[] = [];
      for (const [script, variables] of carried) {
        const ended = this.reloadRestored(script);
        result.discardedRuns.push(...ended.runs);
        result.droppedMessages.push(...ended.messages);
        abandoned.push(...ended.pendingCalls);
        script.loaded.variables = variables;
        if (script.loaded.variablesSize() > script.limits.persistentState) {
          throw new HostError('state too large');
        }
      }
      result.abandonedCalls = abandoned.sort(compareCallIds);
      result.pending = this.pendingOperations();
      const settled = new Set(
        inputs.flatMap(input =>
          input.action.k === 'settle' ? [input.action.id] : [],
        ),
      );
      this.unsettled = new Set(
        result.pending.map(p => p.id).filter(id => !settled.has(id)),
      );
      this.restored = true;
    }
    // A restore reports every live Run and root afresh.
    for (const [root, row] of this.accounting.roots) {
      row.discarded = this.rootDiscards.get(Number(root.slice(1))) ?? 0;
    }
    for (const row of this.accounting.runs.values()) {
      delete row.reportedFuel;
    }
    for (const row of this.accounting.roots.values()) {
      delete row.reported;
    }
  }

  /** Restores the wait table: each wait's timers, in the order waits began. */
  private importWaits(
    state: ReturnType<TsGroup['readState']>,
    restored: {
      pendingId?: string;
      rec: RunRecord<Value>;
      running: Running;
      s: ScriptState;
    }[],
  ) {
    const joins = new Map<Running, JoinWait>();
    const joinOf = (x: (typeof restored)[number]) => {
      let join = joins.get(x.running);
      if (!join) {
        const r = runInternals(x.running.run);
        const sus = r.suspended;
        if (sus?.k !== 'join') {
          return invalidSave();
        }
        join = { members: sus.members, answers: new Map() };
        x.rec.join?.members.forEach((m, i) => {
          const member = sus.members[i]!;
          if (!m.pending && member.answer !== undefined) {
            join!.answers.set(member.id, {
              k: m.with.k === 'reply' ? 'reply' : 'answer',
              value: member.answer,
              fuel: m.with.k === 'answer' ? m.with.fuel : 0,
            } as Resumption);
          }
        });
        if (sus.deadline && x.rec.waiting) {
          join.deadline = this.waits.timer(
            x.rec.waiting.deadline ?? invalidSave(),
            {
              k: 'deadline',
              s: x.s,
              running: x.running,
              after: sus.deadline.after,
              join,
            },
            x.running,
          );
        }
        joins.set(x.running, join);
      }
      return join;
    };
    const seen = new Set<string>();
    for (const w of state.waits) {
      const x = restored[w.run] ?? invalidSave();
      const key = `${w.run}:${w.member}`;
      if (seen.has(key)) {
        invalidSave();
      }
      seen.add(key);
      // A Partial Restore discards a changed Script's Runs, waits and all.
      if (skimmed.has(x.running)) {
        continue;
      }
      const r = runInternals(x.running.run);
      const { s, running, rec } = x;
      if (w.member !== undefined) {
        const m = rec.join?.members[w.member];
        if (!m?.pending) {
          invalidSave();
        }
        if (r.suspended?.k !== 'join') {
          // A preempted Join sets its members' timers at its end, each in
          // the place its wait has here.
          const open = r.join?.members[w.member];
          if (open) {
            open.order = this.waits.reserve();
          }
          continue;
        }
        const join = joinOf(x);
        const member = join.members[w.member]!;
        const timer = this.waits.timer(
          member.at,
          {
            k: 'call',
            id: member.id,
            ms: member.ms,
            ...(member.abort ? { abort: member.abort } : {}),
          },
          running,
        );
        this.waits.add(member.id, s, running, timer, join);
        continue;
      }
      const p = rec.waiting ?? invalidSave();
      const sus = r.suspended ?? invalidSave();
      // eslint-disable-next-line unicorn/consistent-function-scoping -- Each wait closes over its own Run and Script.
      const deadline = (extra: Partial<TimerAction> = {}) =>
        ({
          k: 'deadline',
          s,
          running,
          after: sus.deadline?.after ?? msOf(p.after),
          ...extra,
        }) as TimerAction;
      if (sus.k === 'wait') {
        this.waits.timer(
          p.deadline ?? invalidSave(),
          p.block ? deadline() : { k: 'wake', s, running },
          running,
        );
      } else if (sus.k === 'wait-for') {
        const waiter: Waiter = { running, timers: [] };
        if (p.block) {
          waiter.timers.push(
            this.waits.timer(
              p.deadline ?? invalidSave(),
              deadline({ waiter }),
              running,
            ),
          );
        } else {
          const fire = (branch: number): TimerAction => ({
            k: 'event',
            s,
            waiter,
            branch,
          });
          if (
            sus.timeout !== null &&
            p.branch === 0 &&
            p.deadline !== undefined
          ) {
            waiter.timers.push(this.waits.timer(p.deadline, fire(0), running));
          }
          const branches = p.event?.branches ?? [];
          branches.forEach((b, n) => {
            if (b.k === 'after') {
              waiter.timers.push(this.waits.timer(b.at, fire(n + 1), running));
            }
          });
        }
        this.waits.addWaiter(s, waiter);
      } else if (sus.k === 'join') {
        joinOf(x);
      } else {
        const id = x.pendingId ?? invalidSave();
        const ms = sus.k === 'ask' ? sus.ms : running.run.limits.maxWaitMs;
        const timer = this.waits.timer(
          p.deadline ?? invalidSave(),
          {
            k: 'call',
            id,
            ms,
            ...(sus.k === 'ask' ? { abort: sus.abort } : {}),
            ...(p.block
              ? { deadline: sus.deadline?.after ?? msOf(p.after) }
              : {}),
          },
          running,
        );
        this.waits.add(id, s, running, timer);
      }
    }
    // A suspended Join always waits on its members, so each must have a wait.
    for (const x of restored) {
      if (
        !skimmed.has(x.running) &&
        runInternals(x.running.run).suspended?.k === 'join'
      ) {
        joinOf(x);
      }
    }
    this.waits.importTimerSeq(this.waits.exportState().timerSeq);
  }

  /** A queued Host input from its record, with the Trace line it was given. */
  private inputOf(
    x: Input<Value>,
    deliveryOf: (d: DeliveryRecord<Value>, s: ScriptState | null) => Delivery,
    object: (i: number | undefined) => ObjectState | null,
    decisionOf: (id: string, broadcast: boolean) => Decision,
  ): QueuedInput {
    // eslint-disable-next-line unicorn/consistent-function-scoping -- It reads this Group's Scripts.
    const scriptOfRun = (id: string) =>
      this.scripts.find(s => id.startsWith(`${s.name}/r`))?.name ??
      invalidSave();
    const failOf = (w: ResumeRecord<Value>): HostScriptError | null =>
      w.k === 'failed'
        ? new HostScriptError(
            w.failure.code,
            w.failure.message ?? '',
            w.failure.data ?? nothing,
          )
        : w.k === 'broken'
          ? null
          : invalidSave();
    switch (x.k) {
      case 'deliver': {
        const to: string | ObjectState = x.script
          ? x.script
          : (object(x.delivery.target) ?? invalidSave());
        const s =
          typeof to === 'string'
            ? (this.scripts.find(s => s.name === to) ?? invalidSave())
            : (this.route(to)?.s ?? null);
        const delivery = deliveryOf(x.delivery, s);
        if (typeof to !== 'string') {
          delivery.target = to;
          delivery.path = { after: false, from: to };
          delivery.at = null;
        }
        const record = delivery.fn
          ? 'call-value'
          : delivery.ballot
            ? 'decide'
            : x.delivery.request
              ? 'request'
              : 'deliver';
        const toText =
          typeof to === 'string' ? to : traceValue(to.handle.value);
        return {
          line: this.deliveryLine(
            record,
            delivery.id,
            toText,
            {
              name: delivery.message,
              args: delivery.args,
              ...(Object.keys(delivery.limits).length
                ? { limits: delivery.limits }
                : {}),
            },
            delivery.fn,
          ),
          action: { k: 'delivery', to, state: s, delivery },
        };
      }
      case 'settle': {
        if (x.with.k === 'answer') {
          const { value, fuel } = x.with;
          return {
            line: recordLine(
              'answer',
              [x.id],
              [
                ['value', traceValue(value)],
                ['fuel', fuel ? String(fuel) : null],
              ],
              true,
            ),
            action: { k: 'answer', id: x.id, value, fuel },
          };
        }
        const error = failOf(x.with);
        const detail = x.with.k === 'broken' ? x.with.detail : undefined;
        return {
          line: recordLine(
            'fail',
            [x.id],
            [['error', traceValue(failMap(error))]],
            true,
          ),
          action: {
            k: 'fail',
            id: x.id,
            error,
            ...(detail === undefined ? {} : { detail }),
          },
        };
      }
      case 'settlement': {
        const settlement: Settlement =
          x.how === 0
            ? { answer: x.with.k === 'answer' ? x.with.value : invalidSave() }
            : x.how === 1
              ? { fail: failOf(x.with) ?? invalidSave() }
              : x.how === 2
                ? { reissue: true }
                : { adopt: true };
        return {
          line: settleLine(x.id, settlement),
          action: { k: 'settle', id: x.id, settlement },
        };
      }
      case 'set parent': {
        const child = object(x.object) ?? invalidSave();
        const up = object(x.parent);
        return {
          line: recordLine(
            'set-parent',
            [],
            [
              ['object', traceValue(child.handle.value)],
              ['parent', up ? traceValue(up.handle.value) : 'nothing'],
            ],
            true,
          ),
          action: { k: 'set-parent', child, up },
        };
      }
      case 'dispose': {
        const state = object(x.object) ?? invalidSave();
        return {
          line: recordLine(
            'dispose',
            [],
            [['object', traceValue(state.handle.value)]],
            true,
          ),
          action: { k: 'dispose', state },
        };
      }
      case 'broadcast': {
        const action: Extract<InputAction, { k: 'broadcast' }> = {
          k: 'broadcast',
          id: `b${x.id}`,
          m: {
            name: x.message,
            args: x.args,
            ...(x.limits
              ? {
                  limits: Object.fromEntries(
                    Object.entries(x.limits).filter(([, v]) => v !== undefined),
                  ) as LimitOverride,
                }
              : {}),
          },
          ...(x.decision ? { decision: decisionOf(`b${x.id}`, true) } : {}),
        };
        return { action, line: () => this.broadcastLine(action) };
      }
      case 'revoke':
        return {
          line: recordLine('revoke', [x.script], [['grant', x.grant]], true),
          action: { k: 'revoke', name: x.script, grant: x.grant },
        };
      case 'cancel run':
        return {
          urgent: true,
          line: recordLine('cancel-run', [x.run], [], true),
          action: { k: 'cancel-run', name: scriptOfRun(x.run), id: x.run },
        };
      case 'rewind run':
        return {
          urgent: true,
          line: recordLine('rewind-run', [x.run], [], true),
          action: { k: 'rewind-run', name: scriptOfRun(x.run), id: x.run },
        };
      case 'stop':
        return {
          urgent: true,
          line: recordLine(
            'stop',
            [x.script],
            [['reason', JSON.stringify(x.reason)]],
            true,
          ),
          action: { k: 'stop', name: x.script, reason: x.reason },
        };
      case 'cancel delivery':
      case 'cancel broadcast': {
        const id =
          x.k === 'cancel delivery' ? `d${x.delivery}` : `b${x.broadcast}`;
        return {
          line: recordLine('cancel-delivery', [id], [], true),
          action: { k: 'cancel-delivery', id },
        };
      }
    }
  }

  /**
   * Tooling: each of a Script's code units by identity, with its named
   * functions' Declaration Documentation, so a Session Host can keep it
   * for Function Values that go stale (chapter 9, `script-units`).
   */
  scriptUnitDocs(name: string): [string, Map<string, string>][] {
    const s = this.scripts.find(x => x.name === name);
    return (s?.loaded.units ?? []).map(u => [
      u.identity,
      new Map(
        u.unit.bodies.flatMap(b =>
          b.kind === 'function' && b.doc
            ? [[b.name, b.doc] as [string, string]]
            : [],
        ),
      ),
    ]);
  }

  /** The code units restored Runs may name. */
  private knownCode(): Set<object> {
    const known = new Set<object>();
    const work: Code[] = this.scripts.flatMap(s => s.loaded.units);
    while (work.length) {
      const code = work.pop()!;
      if (!known.has(code)) {
        known.add(code);
        work.push(...code.libraries.values());
      }
    }
    return known;
  }

  /** A Library's code a Script imports, by its unit name. */
  private libraryCode(s: ScriptState, name: string): Code | undefined {
    for (const code of this.knownCode()) {
      if ((code as Code).name === name && s.loaded.units.length >= 0) {
        return code as Code;
      }
    }
    return undefined;
  }

  private discardedDecisions: Decision[] = [];
  private unsettled = new Set<string>();
  private restored = false;

  private discardDecision(delivery: Delivery, script: string, run?: string) {
    const ballot = delivery.ballot;
    if (!ballot || ballot.result) {
      return;
    }
    ballot.result = {
      verdict: 'undecided',
      undecided: { script, ...(run ? { run } : {}), outcome: 'cancelled' },
    };
    ballot.decision.discarded = true;
    if (!this.discardedDecisions.includes(ballot.decision)) {
      this.discardedDecisions.push(ballot.decision);
    }
  }

  private drainCharges = new Map<ScriptState, number>();

  /** Queued, and accepted only before the restored Group's first Pump. */
  settle(id: string, settlement: Settlement): Call<unknown> | undefined {
    const line = settleLine(id, settlement);
    const pending = this.pendingCall(id);
    if (!this.restored || !this.unsettled.has(id) || !pending) {
      this.recordRefusal(line, 'unknown call');
      throw new HostError('unknown call');
    }
    const operation = this.pendingOperations().find(p => p.id === id)!;
    if ('adopt' in settlement && !pending.running.run.callAdoptable(id)) {
      this.recordRefusal(line, 'not adoptable');
      throw new HostError('not adoptable');
    }
    this.checkFunctionGroups(
      'answer' in settlement
        ? [settlement.answer]
        : 'fail' in settlement
          ? [failMap(settlement.fail)]
          : [],
      line,
    );
    this.unsettled.delete(id);
    this.queueInput({ line, action: { k: 'settle', id, settlement } });
    return 'adopt' in settlement
      ? pending.running.run.restoredCall(
          id,
          operation.grant,
          operation.args,
          false,
        ).call
      : undefined;
  }

  private applySettlement(id: string, settlement: Settlement) {
    if ('answer' in settlement) {
      this.settleReply(id, { k: 'answer', value: settlement.answer, fuel: 0 });
      return;
    }
    if ('fail' in settlement) {
      this.settleReply(id, { k: 'fail', error: settlement.fail });
      return;
    }
    if ('adopt' in settlement) {
      return;
    }
    const pending = this.pendingCall(id);
    if (!pending) {
      return;
    }
    const operation = this.pendingOperations().find(p => p.id === id)!;
    const records = pending.running.run.records.length;
    const before = pending.running.run.fuel;
    const failure = pending.running.run.restoredCall(
      id,
      operation.grant,
      operation.args,
      true,
    ).failure;
    this.drainCharges.set(
      pending.s,
      (this.drainCharges.get(pending.s) ?? 0) +
        pending.running.run.fuel -
        before,
    );
    this.writeRecords(pending.running, records);
    this.landUrgentInputs();
    // A preempted Join body's fault is a Stretch resumed for it, as a
    // suspended Run's is (#1413).
    if (failure?.k === 'wake' && !pending.running.run.suspended) {
      pending.running.resuming = true;
    }
    if (failure) {
      this.settleReply(id, failure);
    }
  }

  // Whether an issued call may request charges; undefined if never issued.
  private issuedEligibility(id: string): boolean | undefined {
    const dot = id.lastIndexOf('.c');
    const digits = id.slice(dot + 2);
    if (dot <= 0 || !/^[1-9]\d*$/.test(digits)) {
      return undefined;
    }
    const n = Number(digits);
    return this.issued
      .get(id.slice(0, dot))
      ?.find(([first, last]) => first <= n && n <= last)?.[2];
  }

  /**
   * Queues a charge request for an issued call (Metered Operations). A call
   * the Group never issued is `unknown call`; an ineligible one, an invalid
   * amount or a second unresolved request is `invalid value`, with no id.
   */
  private requestCharge(call: string, fuel: number): ChargeRequest {
    const valid = Number.isSafeInteger(fuel) && fuel >= 0;
    const eligible = this.issuedEligibility(call);
    const code =
      eligible === undefined
        ? 'unknown call'
        : !valid || !eligible || this.charges.some(q => q.call === call)
          ? 'invalid value'
          : null;
    if (code) {
      this.recordRefusal(
        recordLine(
          'charge-request',
          [call],
          [['fuel', valid ? String(fuel) : '"invalid"']],
          true,
        ),
        code,
      );
      throw new HostError(code);
    }
    const id = `q${++this.chargeCounter}`;
    let settle!: (result: ChargeResult) => void;
    const result = new Promise<ChargeResult>(resolve => {
      settle = resolve;
    });
    const q: QueuedCharge = { id, call, fuel, settle };
    this.charges.push(q);
    this.queueInput({
      line: recordLine(
        'charge-request',
        [call, id],
        [['fuel', String(fuel)]],
        true,
      ),
      action: { k: 'charge', q },
    });
    return { id, result };
  }

  // A charge request's outcome, as the Pump drains it: spent, a Fuel Limit
  // Fault ending the call's Run at once, or inactive.
  private drainCharge(q: QueuedCharge) {
    const pending = this.pendingCall(q.call);
    const status = pending
      ? pending.running.run.requestedCharge(q.call, q.fuel)
      : 'inactive';
    q.result = {
      kind: 'charge result',
      request: q.id,
      call: q.call,
      fuel: q.fuel,
      status,
    };
    this.trace?.(
      recordLine(
        'charge-result',
        [q.call, q.id],
        [
          ['fuel', String(q.fuel)],
          ['status', status],
        ],
      ),
    );
    this.drainReports.push(q.result);
    if (status === 'accepted') {
      const s = pending!.s;
      this.drainCharges.set(s, (this.drainCharges.get(s) ?? 0) + q.fuel);
    } else if (status === 'limit') {
      this.endFaulted(pending!.s, pending!.running);
    }
  }

  // Each processed request's future, once its Pump has ended.
  private settleCharges() {
    const done = this.charges.filter(q => q.result);
    this.charges = this.charges.filter(q => !q.result);
    for (const q of done) {
      q.settle(q.result!);
    }
  }

  // A waiting Run a charge request faulted ends with no Stretch: its fault,
  // abandonments, cleanup and terminal records only.
  private endFaulted(s: ScriptState, running: Running) {
    const run = running.run;
    const outcome = run.ended!;
    this.debugController?.ended(run);
    this.forgetWait(s, running);
    s.queue = s.queue.filter(item => item !== running);
    this.writeEnding(running, outcome);
    this.finalizeEffects(running);
    if (run.effectStateUnknown) {
      this.stopUnknownEffects();
    }
    this.writeCancellationAbandons(run);
    const { handler, fallback } = this.handlerOf(s, running, outcome);
    this.endRun(s, running, run.ended!, this.drainReports, handler, fallback);
  }

  private pendingCall(
    id: string,
  ): { running: Running; s: ScriptState } | undefined {
    return this.waits.awaited(id, () => this.holders());
  }

  // Every Run of every Script, with its Script.
  private *holders(): Generator<{ running: Running; s: ScriptState }> {
    for (const s of this.scripts) {
      for (const running of this.runsOf(s)) {
        yield { running, s };
      }
    }
  }

  private pendingOperations(): PendingCall[] {
    return this.waits
      .awaitedCalls(() => this.holders(), compareCallIds)
      .flatMap(([id, pending]) => {
        const context = pending.running.run.pendingCall(id)?.call;
        if (!context) {
          return [];
        }
        const [grant, operation] = context.opName.split('.');
        const args = pending.running.run.records.find(
          r => r.kind === 'call' && r.id === id,
        );
        return [
          {
            id,
            script: pending.s.name,
            grant: grant!,
            operation: {
              capability: pending.s.grants.get(grant!)!.capability.name,
              operation: operation!,
            },
            args: args?.kind === 'call' ? args.args : [],
          },
        ];
      });
  }

  /** A Request's signal lives until its Run ends; a Decision's until its seal. */
  private watchCancellation(delivery: Delivery, signal?: AbortSignal) {
    if (!signal) {
      return;
    }
    const cancel = () => {
      if (!delivery.ballot?.result) {
        this.cancelDelivery(delivery.id!);
      }
    };
    delivery.unsubscribe = () => signal.removeEventListener('abort', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) {
      cancel();
    }
  }

  /** Queue the Host Input produced by aborting a Request, Decision or Host call. */
  cancelDelivery(id: string): void {
    this.queueInput({
      line: recordLine('cancel-delivery', [id], [], true),
      action: { k: 'cancel-delivery', id },
    });
  }

  private cancelDeliveryNow(id: string) {
    for (const s of this.scripts) {
      for (const item of [...s.queue, ...s.suspended, ...s.parked]) {
        const d = 'run' in item ? item.delivery : item;
        if ((d.id !== id && d.broadcast !== id) || d.ballot?.result) {
          continue;
        }
        if ('run' in item) {
          this.cancelRunning(s, item);
        } else {
          s.queue = s.queue.filter(q => q !== item);
          d.unsubscribe?.();
          this.trace?.(
            recordLine(
              'run',
              [],
              [
                ['outcome', 'cancelled'],
                ['delivery', d.id],
                ['broadcast', d.broadcast ?? null],
                ['fn', d.fn ? traceValue(d.fn) : null],
                ['fuel', '0'],
                ['alloc', '0'],
              ],
            ),
          );
          this.drainReports.push({
            kind: 'run end',
            script: s.name,
            ...(d.id ? { delivery: d.id } : {}),
            ...(d.broadcast ? { broadcast: d.broadcast } : {}),
            outcome: 'cancelled',
            fuel: 0,
            alloc: 0,
          });
          this.seal(d, {
            verdict: 'undecided',
            undecided: { script: s.name, outcome: 'cancelled' },
          });
          this.answer(d, { kind: 'cancelled' });
        }
      }
    }
  }

  private queueCancelRun(name: string, id: string): void {
    this.queueInput({
      urgent: true,
      line: recordLine('cancel-run', [id], [], true),
      action: { k: 'cancel-run', name, id },
    });
  }

  private queueRewindRun(name: string, id: string): void {
    this.queueInput({
      urgent: true,
      line: recordLine('rewind-run', [id], [], true),
      action: { k: 'rewind-run', name, id },
    });
  }

  private queueStop(name: string, reason: string): void {
    reason = text(reason).asText()!;
    this.queueInput({
      urgent: true,
      line: recordLine(
        'stop',
        [name],
        [['reason', JSON.stringify(reason)]],
        true,
      ),
      action: { k: 'stop', name, reason },
    });
  }

  private queueRevoke(name: string, grant: string): void {
    this.queueInput({
      line: recordLine('revoke', [name], [['grant', grant]], true),
      action: { k: 'revoke', name, grant },
    });
  }

  private applyInput(action: InputAction) {
    switch (action.k) {
      case 'refusal':
        this.trace?.(
          recordLine('refused', [], [['code', JSON.stringify(action.code)]]),
        );
        break;
      case 'revoke': {
        const s = this.scripts.find(s => s.name === action.name)!;
        if (s.grants.has(action.grant) && !s.revoked.has(action.grant)) {
          s.revoked.add(action.grant);
          this.releaseGrant(s, action.grant, 'revoke');
        }
        break;
      }
      case 'settle':
        this.applySettlement(action.id, action.settlement);
        break;
      case 'charge':
        this.drainCharge(action.q);
        break;
      case 'cancel-delivery':
        this.cancelDeliveryNow(action.id);
        break;
      case 'cancel-run': {
        const s = this.scripts.find(s => s.name === action.name)!;
        const running = this.runsOf(s).find(r => r.id === action.id);
        if (running) {
          this.cancelRunning(s, running);
        }
        break;
      }
      case 'rewind-run': {
        const s = this.scripts.find(s => s.name === action.name)!;
        const running = this.runsOf(s).find(r => r.id === action.id);
        if (running?.run.rewindable && !s.stopped) {
          this.rewindRunning(s, running);
        } else {
          this.trace?.(
            recordLine('note', [action.id], [['kind', 'not-rewindable']]),
          );
        }
        break;
      }
      case 'stop':
        this.stopState(
          this.scripts.find(s => s.name === action.name)!,
          action.reason,
        );
        break;
      case 'answer':
        this.settleReply(action.id, {
          k: 'answer',
          value: action.value,
          fuel: action.fuel,
        });
        break;
      case 'fail':
        this.settleReply(action.id, {
          k: 'fail',
          error: action.error,
          detail: action.detail,
        });
        break;
      case 'delivery': {
        const { state, to, delivery } = action;
        if (state) {
          state.incoming--;
        }
        if (
          delivery.fn &&
          !(delivery.fn.asFunction()!.code as { home: Loaded }).home.live
        ) {
          this.trace?.(
            recordLine('note', [delivery.id], [['kind', 'function-gone']]),
          );
          this.answer(delivery, { kind: 'function gone' });
          break;
        }
        if (typeof to === 'string') {
          this.acceptDelivery(state!, delivery);
          break;
        }
        const r = this.route(to);
        if (!r) {
          this.unhandled(delivery, this.drainReports);
        } else {
          this.acceptDelivery(r.s, { ...delivery, at: r.at });
        }
        break;
      }
      case 'broadcast':
        for (const { s, delivery } of action.recipients!) {
          s.queue.push(delivery);
        }
        if (action.decision && !action.recipients!.length) {
          this.reportDecision(action.decision);
        }
        break;
      case 'set-parent': {
        const code = this.parentError(action.child, action.up);
        if (code) {
          this.drainReports.push({
            kind: 'host error',
            code,
            detail: 'invalid queued parent relationship',
          });
          this.trace?.(
            recordLine('refused', [], [['code', JSON.stringify(code)]]),
          );
        } else {
          action.child.parent = action.up;
        }
        break;
      }
      case 'dispose':
        action.state.disposed = true;
        if (action.state.owner) {
          this.stopState(
            this.scripts.find(s => s.name === action.state.owner)!,
            'owner disposed',
          );
        }
        break;
    }
  }

  private runsOf(s: ScriptState): Running[] {
    return [
      ...s.queue.filter((item): item is Running => 'run' in item),
      ...s.suspended,
      ...s.parked,
    ].sort((a, b) => Number(a.id.split('/r')[1]) - Number(b.id.split('/r')[1]));
  }

  private forgetWait(s: ScriptState, running: Running) {
    s.suspended.delete(running);
    s.parked = s.parked.filter(r => r !== running);
    this.waits.forget(s, running);
  }

  private cancelRunning(s: ScriptState, running: Running) {
    if (running.run.cancelling || running.run.done) {
      return;
    }
    const records = running.run.records.length;
    this.cleaning = true;
    try {
      running.run.cancel(running.parked || running.resuming);
    } finally {
      this.cleaning = false;
    }
    this.writeRecords(running, records);
    if (this.active?.running === running) {
      this.active.records = running.run.records.length;
    }
    if (running.run.effectStateUnknown) {
      this.stopUnknownEffects();
      return;
    }
    this.forgetWait(s, running);
    running.parked = false;
    running.cleanupReady = this.active?.running !== running;
    if (!s.queue.includes(running)) {
      running.resuming = true;
      s.queue.push(running);
    }
  }

  /**
   * Roll back a Run's first Segment, end it and put its message back at the
   * head of the mailbox. The running Pump returns at once (ADR 0068).
   */
  private rewindRunning(s: ScriptState, running: Running) {
    this.rewound = true;
    // Before a parked or just-unparked Run resumes, other Runs may have
    // committed since its base was taken. It has no changes to undo.
    const pending = running.run.discard(
      'rewound',
      running.parked || running.resuming,
    );
    this.finalizeEffects(running, true);
    this.forgetWait(s, running);
    this.accumulateRunCosts(s, running.run);
    this.accountEnd(running, 'discarded', 'rewind');
    this.debugController?.ended(running.run);
    for (const id of pending) {
      this.trace?.(recordLine('abandon', [id], []));
    }
    s.parked = s.parked.filter(r => r !== running);
    s.queue = s.queue.filter(q => q !== running);
    s.queue.unshift(running.delivery);
    if (this.active?.running === running) {
      running.rewound = true;
    }
  }

  private stoppedDelivery(s: ScriptState, delivery: Delivery, run?: string) {
    delivery.unsubscribe?.();
    this.seal(delivery, {
      verdict: 'undecided',
      undecided: {
        script: s.name,
        ...(run ? { run } : {}),
        outcome: 'cancelled',
      },
    });
    this.answer(delivery, { kind: 'stopped' });
  }

  private stopState(
    s: ScriptState,
    reason: string,
    keepMailbox = false,
    releaseReason: ReleaseReason = 'stop',
  ) {
    if (s.stopped) {
      return;
    }
    s.stopped = true;
    s.loaded.live = false;
    s.stopReason = reason;
    const runs = this.runsOf(s);
    const mailbox = s.queue.filter((q): q is Delivery => !('run' in q));
    // A Reload that keeps the mailbox drops none of it (ADR 0068).
    const messages = keepMailbox ? [] : mailbox;
    const pendingCalls: string[] = [];
    for (const r of runs) {
      this.accumulateRunCosts(s, r.run);
      pendingCalls.push(
        ...r.run.discard('stopped', r.parked || r.resuming || r.cleanupReady),
      );
      this.finalizeEffects(r, true);
      this.forgetWait(s, r);
    }
    s.queue = keepMailbox ? mailbox : [];
    if (!this.effectStateUnknown && runs.some(r => r.run.effectStateUnknown)) {
      s.stopReason = 'effect state unknown';
      this.stopUnknownEffects(s, () =>
        this.reportStop(
          s,
          'effect state unknown',
          runs,
          messages,
          pendingCalls,
        ),
      );
      return;
    }
    const report = () =>
      this.reportStop(s, reason, runs, messages, pendingCalls, releaseReason);
    if (this.terminalReports) {
      this.terminalReports.push(report);
    } else if (this.active?.s === s) {
      this.activeStop = report;
    } else {
      report();
    }
  }

  private stopUnknownEffects(
    failedScript?: ScriptState,
    failedReport?: () => void,
  ) {
    if (this.effectStateUnknown) {
      return;
    }
    this.effectStateUnknown = true;
    const reports: (() => void)[] = [];
    this.terminalReports = reports;
    try {
      for (const s of this.scripts) {
        if (s === failedScript) {
          reports.push(failedReport!);
        } else {
          this.stopState(s, 'effect state unknown');
        }
      }
    } finally {
      this.terminalReports = null;
    }
    const publish = () => {
      for (const report of reports) {
        report();
      }
    };
    if (this.active) {
      this.activeStop = publish;
    } else {
      publish();
    }
  }

  private requireKnownEffects() {
    if (this.effectStateUnknown) {
      throw new HostError('effect state unknown');
    }
  }

  private releaseGrant(s: ScriptState, name: string, reason: ReleaseReason) {
    const grant = s.grants.get(name);
    if (!grant?.capability.release) {
      return;
    }
    const cleaning = this.cleaning;
    this.cleaning = true;
    try {
      grant.capability.release({
        group: this,
        scriptName: s.name,
        grantName: name,
        binding: grant.binding,
        now: this.lastClock ?? 0n,
        reason,
      });
    } catch {
      // Host cleanup is infallible from the Core's perspective.
    } finally {
      this.cleaning = cleaning;
    }
  }

  private releaseGrants(s: ScriptState, reason: ReleaseReason) {
    for (const name of [...s.grants.keys()].sort(compareText)) {
      this.releaseGrant(s, name, reason);
    }
  }

  private reportStop(
    s: ScriptState,
    reason: string,
    runs: Running[],
    messages: Delivery[],
    pendingCalls: string[],
    /** Null for a Partial Restore's Reload, whose `restore` record stands for it. */
    releaseReason: ReleaseReason | null = 'stop',
  ) {
    if (releaseReason) {
      this.releaseGrants(s, releaseReason);
      this.trace?.(
        recordLine(
          'stopped',
          [s.name],
          [
            ['reason', JSON.stringify(reason)],
            ['discarded', idList(runs.map(r => r.id))],
            ['dropped', idList(messages.flatMap(d => (d.id ? [d.id] : [])))],
            ['abandoned', idList(pendingCalls)],
          ],
        ),
      );
    }
    for (const r of runs) {
      this.accountEnd(
        r,
        'discarded',
        reason === 'reload'
          ? this.discardReason === 'library replacement'
            ? 'library replacement'
            : 'reload'
          : 'stop',
      );
    }
    for (const d of messages) {
      this.accountDrop(d);
    }
    this.drainReports.push({
      kind: 'stop',
      script: s.name,
      reason,
      discardedRuns: runs.map(r => r.id),
      droppedMessages: messages.flatMap(d => (d.id ? [d.id] : [])),
      pendingCalls,
    });
    for (const r of runs) {
      this.stoppedDelivery(s, r.delivery, r.id);
    }
    for (const d of messages) {
      this.stoppedDelivery(s, d);
    }
  }

  /**
   * A Partial Restore's Reload of a changed Script (ADR 0143). The rest of
   * the Group sees what a live Reload would give it, but no Host function
   * runs: this Script's Grants, Segments and scopes were never live here.
   * Its open Decision recipients are discarded, reported at the first Pump.
   */
  private reloadRestored(s: ScriptState) {
    const runs = this.runsOf(s);
    const messages = s.queue.filter((q): q is Delivery => !('run' in q));
    const pendingCalls: string[] = [];
    for (const r of runs) {
      this.accumulateRunCosts(s, r.run);
      pendingCalls.push(
        ...r.run.discard('stopped', r.parked || r.resuming || r.cleanupReady),
      );
      this.forgetWait(s, r);
      this.discardDecision(r.delivery, s.name, r.id);
    }
    for (const d of messages) {
      this.discardDecision(d, s.name);
    }
    s.queue = [];
    if (!s.stopped) {
      this.reportStop(s, 'reload', runs, messages, pendingCalls, null);
    }
    s.stopped = false;
    delete s.stopReason;
    return {
      runs: runs.map(r => r.id),
      messages: messages.flatMap(d => (d.id ? [d.id] : [])),
      pendingCalls,
    };
  }

  private dropStoppedMailbox(s: ScriptState) {
    const messages = s.queue.filter((q): q is Delivery => !('run' in q));
    s.queue = [];
    if (messages.length) {
      this.reportStop(s, s.stopReason!, [], messages, []);
    }
  }

  private acceptDelivery(s: ScriptState, delivery: Delivery) {
    this.ancestry(delivery);
    s.queue.push(delivery);
    if (s.stopped) {
      this.dropStoppedMailbox(s);
    }
  }

  // Refusal is immediate at the API; inside a Pump its records land at the
  // crossing alongside urgent controls, in the order the Host made them.
  private recordRefusal(line: string, code: string) {
    this.combinedAdmission = false;
    if (this.pumping) {
      this.inputs.push({ line, urgent: true, action: { k: 'refusal', code } });
    } else {
      this.trace?.(line);
      this.trace?.(recordLine('refused', [], [['code', JSON.stringify(code)]]));
    }
  }

  private landUrgentInputs() {
    while (this.inputs.some(i => i.urgent)) {
      const urgent = this.inputs.filter(i => i.urgent);
      this.inputs = this.inputs.filter(i => !i.urgent);
      for (const input of urgent) {
        const line = typeof input.line === 'string' ? input.line : input.line();
        this.trace?.(line);
        this.applyInput(input.action);
      }
    }
  }

  constructor(options: TsGroupOptions) {
    this.name = options.name;
    this.onReady = options.onReady;
    if (options.seed !== undefined) {
      if (options.seed < 0n || options.seed > 0xff_ff_ff_ff_ff_ff_ff_ffn) {
        throw new HostError(
          'invalid value',
          'A seed is a whole number 0 to 2^64 - 1',
        );
      }
      this.randomState = seedState(options.seed);
    }
    // Optional calls also skip formatting and Trace-only state traversal.
    this.trace = options.trace
      ? line => {
          if (this.drainingTrace) {
            this.drainingTrace.push(line);
          } else {
            options.trace!(line);
          }
        }
      : undefined;
    if (options.session) {
      this.attachSession(options.session);
    }
  }

  script(name: string): TsScript | undefined {
    return this.scripts.find(s => s.name === name)?.handle;
  }

  /** Any time, inside a Pump too. Its Scripts' names, in load order; not a Host Input. */
  scriptNames(): string[] {
    return this.scripts.map(s => s.name);
  }

  // Notify once per accepted Host Input, including urgent inputs drained in this Pump.
  private queueInput(input: QueuedInput, notify = true): void {
    const landing = this.debugController?.current;
    // An input made at any pause lands there, between instructions, so its
    // line carries the instruction for replay (chapter 11).
    if (
      landing &&
      (input.action.k === 'stop' ||
        input.action.k === 'cancel-run' ||
        input.action.k === 'rewind-run') &&
      typeof input.line === 'string'
    ) {
      input.line += ` pc=${landing.pc}`;
    }
    this.inputs.push(input);
    if (!notify) {
      return;
    }
    if (this.onReady) {
      if (this.pumping || this.cleaning) {
        // Host crossings may queue inputs. Notify after the Pump or replacement
        // returns, so a readiness callback cannot reenter lifecycle cleanup.
        queueMicrotask(() => this.onReady?.());
      } else {
        this.onReady();
      }
    }
  }

  private worker() {
    if (this.pumping || this.cleaning || this.combining) {
      throw new HostError('reentrant call');
    }
  }

  private finalizeEffects(running: Running, rollback = false) {
    const run = running.run;
    if (!run.hasOpenScopes && !run.hasParticipant) {
      return;
    }
    const records = run.records.length;
    this.cleaning = true;
    try {
      run.finalizeEffects(rollback);
    } finally {
      this.cleaning = false;
    }
    this.writeRecords(running, records);
    if (this.active?.running === running) {
      this.active.records = run.records.length;
    }
  }

  private accumulateRunCosts(s: ScriptState, run: Run) {
    s.fuelTotal += run.fuel;
    s.allocTotal += run.alloc;
  }

  private scriptCounters(name: string): Counters {
    this.worker();
    const s = this.scripts.find(s => s.name === name)!;
    const counters = {
      fuelTotal: s.fuelTotal,
      allocTotal: s.allocTotal,
      runs: s.runs,
      faults: s.faults,
      persistentState: this.persistentState(s),
      mailboxLen: s.queue.filter(q => !('run' in q)).length,
    };
    for (const { run } of this.runsOf(s)) {
      counters.fuelTotal += run.fuel;
      counters.allocTotal += run.alloc;
    }
    this.trace?.(recordLine('counters', [name], [], true));
    this.trace?.(
      recordLine(
        'counters',
        [name],
        [
          ['fuel', String(counters.fuelTotal)],
          ['alloc', String(counters.allocTotal)],
          ['runs', String(counters.runs)],
          ['faults', String(counters.faults)],
          ['state', String(counters.persistentState)],
          ['mailbox', String(counters.mailboxLen)],
        ],
      ),
    );
    return counters;
  }

  private scriptGrants(name: string): Record<string, string[]> {
    this.worker();
    return Object.fromEntries(
      [...this.scripts.find(s => s.name === name)!.grants]
        .sort(([a], [b]) => compareText(a, b))
        .map(([name, grant]) => [name, [...grant.ops].sort(compareText)]),
    );
  }

  /** Worker. Compiles, checks and loads a Script, or throws LoadError. */
  load(o: LoadOptions): TsScript {
    this.worker();
    this.requireKnownEffects();
    const objects = Object.keys(o.objects ?? {});
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
      undefined,
      propertyChecks(o.objects ?? {}, o.owner),
    );
    this.trace?.(
      recordLine('load', [o.name], [['identity', p.identity]], true),
    );
    const limits = { ...defaultLimits, ...o.limits };
    const loaded = this.loadPrepared(o.name, p, limits);
    const used = o.grantsAsUsed
      ? usedOperations(p.checked.tree!, p.imports)
      : undefined;
    const kept = new Map(
      [...grants].flatMap(([name, grant]) => {
        const bound = keepOperations(
          grant,
          used?.get(name) ?? (used ? new Set() : grant.ops),
        );
        return used && bound.ops.size === 0 ? [] : [[name, bound] as const];
      }),
    );
    const handle = new TsScript(this.channel, o.name);
    if (owner) {
      owner.owner = o.name;
    }
    this.scripts.push({
      name: o.name,
      suspended: new Set(),
      unbound: new Set(),
      objects: o.objects ?? {},
      owner,
      grants: kept,
      revoked: new Set(),
      disabled: new Set(),
      handle,
      loaded,
      identity: p.identity,
      limits,
      queue: [],
      runs: 0,
      fuelTotal: 0,
      allocTotal: 0,
      faults: 0,
      debt: 0,
      incoming: 0,
      parked: [],
      stopped: false,
      units: [
        {
          source: o.source,
          tree: p.checked.tree!,
          imports: p.imports,
          identity: p.identity,
        },
      ],
    });
    return handle;
  }

  private loadPrepared(
    name: string,
    p: ReturnType<typeof prepare>,
    limits: Limits,
    existing?: {
      home: Loaded;
      identity: string;
      links: ReadonlyMap<string, Code>;
    },
    traced = true,
  ): Loaded {
    try {
      if (p.diagnostics) {
        throw new LoadError(p.diagnostics);
      }
      // An extension's lowering also depends on all earlier definitions and
      // variable slots, so cache it under the complete extended Script identity.
      const identity = compileKey(
        existing?.identity ?? p.identity,
        p.checked.tree!,
      );
      let unit = compiledScripts.get(identity);
      if (!unit) {
        unit = loadOrReject(name, () =>
          lowerTree(p.checked.tree!, {
            name,
            unit: 'script',
            existingVariables: existing?.home.variableNames,
          }),
        );
        compiledScripts.set(identity, unit);
      }
      const loaded = loadOrReject(name, () =>
        loadScript(
          unit,
          limits,
          new Map([...(existing?.links ?? []), ...linksOf(p.imports)]),
          existing?.home.variables,
          existing?.home,
          p.identity,
          this.functionGroup,
        ),
      );
      return loaded;
    } catch (error) {
      if (traced) {
        this.writeDiagnostics(error);
      }
      throw error;
    }
  }

  private writeDiagnostics(error: unknown) {
    if (error instanceof LoadError) {
      for (const d of error.diagnostics) {
        this.trace?.(
          recordLine(
            'diag',
            [d.unit],
            [
              ['code', JSON.stringify(d.code)],
              ['pos', `${d.line}:${d.col}`],
            ],
          ),
        );
      }
    }
  }

  private replacement(
    s: ScriptState,
    source: string,
    carry: CarryOver,
    libraries = this.libraries,
    extensions: readonly string[] = [],
  ) {
    const grants = availableGrants(s);
    const p = prepare(
      'script',
      s.name,
      source,
      libraries,
      Object.keys(s.objects),
      declarationsOf(grants),
      undefined,
      propertyChecks(s.objects, s.owner?.handle),
    );
    const loaded = this.loadPrepared(s.name, p, s.limits);
    const staged: ScriptState = {
      ...s,
      grants,
      revoked: new Set(),
      disabled: new Set(),
      unbound: new Set(),
      loaded,
      identity: p.identity,
      queue: [],
      suspended: new Set(),
      parked: [],
      units: [
        {
          source,
          tree: p.checked.tree!,
          imports: p.imports,
          identity: p.identity,
        },
      ],
    };
    for (const entry of extensions) {
      this.applyExtension(
        staged,
        entry,
        this.extension(staged, entry, libraries),
        false,
      );
    }
    if (carry === 'carry variables') {
      let variables = s.loaded.variables;
      for (const r of this.runsOf(s)) {
        if (
          !r.parked &&
          !r.resuming &&
          !r.cleanupReady &&
          !r.run.suspended &&
          !r.run.done
        ) {
          variables = r.run.segmentBase;
        }
      }
      for (const [i, name] of loaded.variableNames.entries()) {
        const old = s.loaded.variableNames.indexOf(name);
        if (old >= 0) {
          loaded.variables[i] = variables[old]!;
        }
      }
    }
    if (
      (carry === 'carry variables' || extensions.length > 0) &&
      loaded.variablesSize() > s.limits.persistentState
    ) {
      this.trace?.(
        recordLine(
          'refused',
          [],
          [['code', JSON.stringify('state too large')]],
        ),
      );
      throw new HostError('state too large');
    }
    return { loaded, units: staged.units, identity: staged.identity, grants };
  }

  /** Worker. Check and initialise before discarding any old work. */
  reload(
    name: string,
    source: string,
    carry: CarryOver,
    keepMailbox = false,
  ): Report[] {
    this.worker();
    this.requireKnownEffects();
    const s = this.scripts.find(s => s.name === name)!;
    const p = prepare('script', name, source, this.libraries);
    this.trace?.(
      recordLine(
        'reload',
        [name],
        [
          ['carry', carry === 'carry variables' ? 'yes' : 'no'],
          ['mailbox', keepMailbox ? 'keep' : null],
          ['source', displayText(source)],
          ['identity', p.identity],
        ],
        true,
      ),
    );
    const replacement = this.replacement(s, source, carry);
    return this.replaceScripts([{ s, ...replacement }], keepMailbox);
  }

  private extension(
    s: ScriptState,
    source: string,
    libraries = this.libraries,
  ) {
    const name = `${s.name}+${s.units.length}`;
    const existing: Record<string, ExistingName> = {};
    const links = new Map<string, Code>();
    for (const [i, unit] of s.units.entries()) {
      const code = s.loaded.units[i]!;
      // Earlier units use private keys, so Host-chosen Script names cannot
      // collide with the `library:name` encoding (including its dot rule).
      const key = `@${i}`;
      links.set(key, code);
      for (const [library, linked] of code.libraries) {
        links.set(library, linked);
      }
      for (const binding of unit.tree.scopes[0]!.bindings) {
        if (binding.span === null) {
          continue;
        }
        const previous = existing[binding.name];
        const current: ExistingName = {
          kind: binding.kind,
          contract: binding.contract,
          importedFrom:
            binding.kind === 'script variable'
              ? undefined
              : (binding.importedFrom ?? { library: key, name: binding.name }),
          maySuspend:
            binding.kind === 'handler' &&
            (binding.importedFrom
              ? code
                  .library(
                    `${binding.importedFrom.library}:${binding.importedFrom.name}`,
                  )
                  .code.clauses.get(binding.importedFrom.name)
                  ?.some(b => b.maySuspend)
              : code.clauses.get(binding.name)?.some(b => b.maySuspend)),
        };
        if (
          binding.kind === 'handler' &&
          previous &&
          previous.kind !== 'handler'
        ) {
          previous.handler = current;
        } else {
          if (previous?.kind === 'handler' && binding.kind !== 'handler') {
            current.handler = previous;
          }
          existing[binding.name] = current;
        }
      }
    }
    const p = prepare(
      'script',
      name,
      source,
      libraries,
      Object.keys(s.objects),
      declarationsOf(availableGrants(s)),
      existing,
      propertyChecks(s.objects, s.owner?.handle),
    );
    const identity = codeIdentity(
      'extension',
      s.name,
      source,
      p.imports.map(identityOf),
    );
    const diagnostics = [...(p.diagnostics ?? [])];
    if (p.checked.tree) {
      const units = [
        ...s.units.map((unit, i) => ({
          root: unit.tree.root,
          name: s.loaded.units[i]!.name,
        })),
        { root: p.checked.tree.root, name },
      ];
      checkDecisionCalls(
        units.map(unit => ({
          root: unit.root,
          report: (code, leaf) => {
            if (
              !diagnostics.some(
                d =>
                  d.unit === unit.name &&
                  d.code === code &&
                  d.line === leaf.span.line &&
                  d.col === leaf.span.col,
              )
            ) {
              diagnostics.push({
                code,
                unit: unit.name,
                line: leaf.span.line,
                col: leaf.span.col,
                message: code,
              });
            }
          },
        })),
      );
    }
    const extendedIdentity = sha256(`${s.identity}\nextend\n${identity}\n`);
    return {
      p: {
        ...p,
        identity,
        diagnostics: diagnostics.length ? diagnostics : null,
      },
      extendedIdentity,
      links,
      existing,
      name,
    };
  }

  private applyExtension(
    s: ScriptState,
    source: string,
    prepared = this.extension(s, source),
    checkState = true,
  ) {
    const { p, links, existing, name, extendedIdentity } = prepared;
    for (const decl of p.checked.tree ? viewSource(p.checked.tree.root) : []) {
      const names =
        decl.k === 'use'
          ? decl.imports.map(i => i.local.text)
          : decl.k === 'handler' || decl.k === 'function'
            ? [decl.name]
            : [decl.name.text];
      if (
        names.some(
          n => Object.hasOwn(existing, n) || Object.hasOwn(s.objects, n),
        )
      ) {
        this.trace?.(
          recordLine('refused', [], [['code', JSON.stringify('name reused')]]),
        );
        throw new HostError('name reused');
      }
    }
    const extension = this.loadPrepared(name, p, s.limits, {
      home: s.loaded,
      links,
      identity: extendedIdentity,
    });
    const state =
      this.persistentState(s) -
      s.loaded.variablesSize() +
      extension.variablesSize();
    if (checkState && state > s.limits.persistentState) {
      this.trace?.(
        recordLine(
          'refused',
          [],
          [['code', JSON.stringify('state too large')]],
        ),
      );
      throw new HostError('state too large');
    }
    const added = extension.variables.slice(s.loaded.variables.length);
    for (const r of this.runsOf(s)) {
      if (!baseLengths.has(r.run.segmentBase)) {
        baseLengths.set(r.run.segmentBase, r.run.segmentBase.length);
      }
      r.run.segmentBase.push(...added);
    }
    s.loaded.attach(extension);
    s.identity = extendedIdentity;
    s.units.push({
      source,
      tree: p.checked.tree!,
      imports: p.imports,
      identity: p.identity,
    });
  }

  /** Worker. Existing code units and Runs remain untouched. */
  extend(name: string, source: string): void {
    this.worker();
    this.requireKnownEffects();
    const s = this.scripts.find(s => s.name === name)!;
    const p = this.extension(s, source);
    this.trace?.(
      recordLine(
        'extend',
        [name],
        [
          ['source', displayText(source)],
          ['identity', p.extendedIdentity],
        ],
        true,
      ),
    );
    this.applyExtension(s, source, p);
  }

  private replaceScripts(
    replacements: {
      grants: ReadonlyMap<string, Grant<unknown>>;
      identity: string;
      loaded: Loaded;
      s: ScriptState;
      units: SourceUnit[];
    }[],
    keepMailbox = false,
  ): Report[] {
    const previous = this.drainReports;
    const reports: Report[] = [];
    this.drainReports = reports;
    try {
      // A Library replacement can reload several Scripts. Finish all external
      // cleanup before releasing any Grants or publishing a Reload's Stop:
      // a later failed rollback stops the whole Group with the old code.
      for (const { s } of replacements) {
        for (const running of this.runsOf(s)) {
          this.finalizeEffects(running, true);
          if (running.run.effectStateUnknown) {
            this.stopUnknownEffects();
            return reports;
          }
        }
      }
      for (const { s } of replacements) {
        if (s.stopped) {
          this.releaseGrants(s, 'reload');
        } else {
          this.stopState(s, 'reload', keepMailbox, 'reload');
        }
      }
      // Cleanup has already happened. Return its reports even if it stopped
      // the Group; publishing replacement code would hide the failed effects.
      if (this.effectStateUnknown) {
        return reports;
      }
      for (const { s, loaded, units, identity, grants } of replacements) {
        s.loaded = loaded;
        s.identity = identity;
        s.units = units;
        s.grants = grants;
        s.revoked.clear();
        s.unbound.clear();
        s.stopped = false;
        delete s.stopReason;
      }
    } finally {
      this.flushAccounting(reports);
      this.drainReports = previous;
    }
    return reports;
  }

  /**
   * Worker, Host Input. Adds a compiled Library, whose imports the Group must
   * already hold, under a name it doesn't hold yet.
   */
  addLibrary(l: Library): void {
    this.worker();
    this.trace?.(
      recordLine('add-library', [l.name], [['identity', identityOf(l)]], true),
    );
    const refuse = (code: HostErrorCode, message: string): never => {
      this.trace?.(recordLine('refused', [], [['code', JSON.stringify(code)]]));
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

  /** Worker. Prepare every dependent before changing the Group. */
  replaceLibrary(l: Library, carry: CarryOver): Report[] {
    this.worker();
    this.requireKnownEffects();
    this.trace?.(
      recordLine(
        'replace-library',
        [l.name],
        [
          ['carry', carry === 'carry variables' ? 'yes' : 'no'],
          ['source', displayText(l.source)],
          ['identity', identityOf(l)],
        ],
        true,
      ),
    );
    const refuse = (code: HostErrorCode): never => {
      this.trace?.(recordLine('refused', [], [['code', JSON.stringify(code)]]));
      throw new HostError(code);
    };
    if (stdlibNames.has(l.name)) {
      refuse('reserved name');
    }
    if (!this.libraries.has(l.name)) {
      refuse('library mismatch');
    }
    for (const imported of l.imports.filter(i => !stdlibNames.has(i.name))) {
      const held = this.libraries.get(imported.name);
      if (!held || identityOf(held) !== identityOf(imported)) {
        refuse('library mismatch');
      }
    }
    let libraries: Map<string, Library>;
    try {
      libraries = replacementLibraries(this.libraries, l);
    } catch (error) {
      this.writeDiagnostics(error);
      throw error;
    }
    const affected = new Set(
      [...libraries]
        .filter(([name, library]) => library !== this.libraries.get(name))
        .map(([name]) => name),
    );
    affected.add(l.name);
    const replacements = this.scripts
      .filter(s => s.units.some(u => u.imports.some(i => affected.has(i.name))))
      .map(s => ({
        s,
        ...this.replacement(
          s,
          s.units[0]!.source,
          carry,
          libraries,
          s.units.slice(1).map(u => u.source),
        ),
      }));
    this.discardReason = 'library replacement';
    let reports: Report[];
    try {
      reports = this.replaceScripts(replacements);
    } finally {
      this.discardReason = 'stop';
    }
    if (this.effectStateUnknown) {
      return reports;
    }
    this.libraries.clear();
    for (const [name, library] of libraries) {
      this.libraries.set(name, library);
    }
    return reports;
  }

  // What a Run of the Script reaches outside it through (machine.ts).
  private hostFor(s: ScriptState, run: Run, delivery: string | null): RunHost {
    const group = this;
    return {
      ...(delivery ? { delivery } : {}),
      issue: (id, metered = false) => {
        const dot = id.lastIndexOf('.c');
        const runId = id.slice(0, dot);
        const n = Number(id.slice(dot + 2));
        const ranges = this.issued.get(runId) ?? [];
        const last = ranges.at(-1);
        if (last && last[1] + 1 === n && last[2] === metered) {
          last[1] = n;
        } else {
          ranges.push([n, n, metered]);
        }
        this.issued.set(runId, ranges);
      },
      requestCharge: (id, fuel) => this.requestCharge(id, fuel),
      waitOrder: () => ++this.waitOrder,
      timerOrder: () => this.waits.reserve(),
      drawRandom: n => this.drawRandom(n),
      holdsObject: v => this.holdsObject(v),
      crossing: () => {
        const active = this.active!;
        this.writeRecords(active.running, active.records);
        active.records = run.records.length;
        const cancelling = run.cancelling;
        this.landUrgentInputs();
        return (
          s.stopped ||
          (!cancelling && run.cancelling) ||
          !!this.active?.running.rewound
        );
      },
      group,
      disableGrant: name => {
        s.disabled.add(name);
        const running = this.runsOf(s).find(r => r.run === run);
        if (running) {
          this.writeRecords(running, 0);
        }
      },
      isDisabled: name => s.disabled.has(name),
      grants: s.grants,
      isUnbound: name => s.unbound.has(name),
      isRevoked: name => s.revoked.has(name),
      get now() {
        return group.lastClock ?? 0n;
      },
      get me() {
        return s.owner?.handle.value ?? nothing;
      },
      object: name =>
        Object.hasOwn(s.objects, name) ? s.objects[name]!.value : undefined,
      isScript: name => this.scripts.some(other => other.name === name),
      expose: tree => this.session?.values(tree),
      callValue: (fn, args, reply) => {
        const receiver = this.scripts.find(
          other => other.name === fn.homeScript(),
        )!;
        this.enqueue(receiver, receiver.name, {
          fn,
          args,
          reply,
          from: reply,
          id: null,
          at: null,
          target: null,
          message: '',
          limits: {},
          request: null,
        });
        return receiver.name;
      },
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
          target: typeof to === 'string' ? r.at : to,
          ...(typeof to === 'string'
            ? {}
            : { path: { after: false, from: to } }),
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
          path: { after: true, from: s.owner! },
          message,
          args,
          limits: {},
          reply,
          request: null,
        });
        return r.s.name;
      },
      answer: (id, value, fuel) => {
        const line = recordLine(
          'answer',
          [id],
          [
            ['value', traceValue(value)],
            ['fuel', fuel ? String(fuel) : null],
          ],
          true,
        );
        this.checkFunctionGroups([value], line);
        this.queueInput({ line, action: { k: 'answer', id, value, fuel } });
      },
      fail: (id, error, detail) => {
        const value = failMap(error);
        const line = recordLine(
          'fail',
          [id],
          [['error', traceValue(value)]],
          true,
        );
        this.checkFunctionGroups([value], line);
        this.queueInput({ line, action: { k: 'fail', id, error, detail } });
      },
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
    this.ancestry(delivery);
    receiver.queue.push(delivery);
  }

  private fireTimer(timer: Timer) {
    const action = timer.action;
    switch (action.k) {
      case 'wake':
        this.ready(action.s, action.running, { k: 'wake' });
        break;
      case 'event':
        this.waits.endWaiter(action.s, action.waiter);
        this.ready(action.s, action.waiter.running, {
          k: 'event-timeout',
          branch: action.branch,
        });
        break;
      case 'call':
        abandon(action.abort, 'timeout');
        this.settleReply(action.id, {
          k: 'timeout',
          after: action.ms,
          ...(action.deadline ? { deadline: action.deadline } : {}),
        });
        break;
      case 'deadline': {
        // What the Run waits on is abandoned, a Join's pending members in
        // start order (ADR 0073).
        if (action.waiter) {
          this.waits.endWaiter(action.s, action.waiter);
        }
        const cut = this.waits.cut(action.join?.members ?? [], 'timeout');
        this.ready(action.s, action.running, {
          k: 'deadline',
          after: action.after,
          abandon: cut.map(m => m.id),
        });
        break;
      }
    }
  }

  // A suspended Run made ready: it joins the back of its Script's queue.
  private ready(s: ScriptState, running: Running, r: Resumption) {
    s.suspended.delete(running);
    const last = lastWaits.get(running);
    if (last?.waiting) {
      lastWaits.set(running, {
        ...last,
        waited: last.waiting,
        waiting: undefined,
      });
    }
    running.run.wake(r);
    running.resuming = true;
    s.queue.push(running);
  }

  // A call's answer or failure, or a reply; one no longer pending is noted.
  private settleReply(id: string, r: Resumption) {
    const settled = this.waits.settle(id, r, () => this.holders());
    if (settled.k === 'ready') {
      this.ready(settled.s, settled.running, settled.r);
    } else if (settled.k === 'late' && (r.k === 'answer' || r.k === 'fail')) {
      this.trace?.(recordLine('note', [id], [['kind', 'late-answer']]));
    }
  }

  // A message being dispatched resumes every pending `wait for` of its
  // Script that it matches, in the order the waits began (chapter 5).
  private observe(s: ScriptState, delivery: Delivery) {
    const from = delivery.from?.split('/')[0] ?? null;
    let fuel = 0;
    for (const waiter of this.waits.waitersOf(s)) {
      const before = waiter.running.run.fuel;
      const records = waiter.running.run.records.length;
      const fired = waiter.running.run.matchEvent(
        delivery.message,
        delivery.args,
        from,
        (delivery.target ?? s.owner)?.handle.value ?? nothing,
      );
      fuel += waiter.running.run.fuel - before;
      this.writeRecords(waiter.running, records);
      if (fired) {
        this.waits.endWaiter(s, waiter);
        this.seal(delivery, { verdict: 'allowed' });
        this.ready(s, waiter.running, fired);
      }
    }
    return fuel;
  }

  // A Run that suspended: wait on its timer, its answer or its reply.
  private suspended(s: ScriptState, running: Running, sus: Suspension) {
    s.suspended.add(running);
    markRest(running, running.run);
    const now = this.lastClock!;
    const deadline = this.suspendedWait(s, running, sus, now);
    this.markWait(running, sus, now);
    return deadline;
  }

  /**
   * What a save keeps of a Run's wait: its order among waits, its Suspension
   * Point and, once the wait settles, what it waited on.
   */
  private markWait(running: Running, sus: Suspension, now: bigint) {
    const last = lastWaits.get(running);
    const suspendedAt =
      sus.k === 'wait-for' && sus.any ? 'wait-for-any' : suspendReasons[sus.k];
    const block = sus.deadline;
    if (sus.k === 'join') {
      // Only a Timeout Block's deadline makes a Join's own wait.
      if (block) {
        waitOrders.set(running, ++this.waitOrder);
      }
      lastWaits.set(running, {
        ...last,
        suspendedAt,
        waiting: block
          ? {
              id: '',
              block: true,
              grant: '',
              operation: '',
              declared: false,
              after: microsOf(block.after),
            }
          : undefined,
      });
      return;
    }
    waitOrders.set(running, ++this.waitOrder);
    const own =
      sus.k === 'ask'
        ? BigInt(sus.ms) * 1000n
        : sus.k === 'send' || sus.k === 'call-value'
          ? BigInt(running.run.limits.maxWaitMs) * 1000n
          : null;
    const bounded =
      !!block &&
      (sus.k === 'wait'
        ? block.at <= now + sus.us
        : sus.k === 'wait-for'
          ? true
          : own !== null && block.at <= now + own);
    const [grant, operation] =
      sus.k === 'ask' ? sus.call.opName.split('.') : ['', ''];
    lastWaits.set(running, {
      ...last,
      suspendedAt,
      waiting: {
        id:
          sus.k === 'ask'
            ? sus.call.id
            : sus.k === 'send' || sus.k === 'call-value'
              ? sus.id
              : '',
        block: bounded,
        ...(sus.k === 'ask' ? { call: sus.call } : {}),
        grant: grant!,
        operation: operation!,
        declared: sus.k === 'ask',
        after: bounded ? microsOf(block!.after) : (own ?? 0n),
      },
    });
  }

  private suspendedWait(
    s: ScriptState,
    running: Running,
    sus: Suspension,
    now: bigint,
  ) {
    // A Timeout Block's deadline wins over the wait's own when it is no
    // later, and then is the wait's only timer (ADR 0073).
    const block = sus.deadline;
    const ends = (own: bigint | null) =>
      !!block && (own === null || block.at <= own);
    const deadline = (extra: Partial<TimerAction> = {}) =>
      ({
        k: 'deadline',
        s,
        running,
        after: block!.after,
        ...extra,
      }) as TimerAction;
    if (sus.k === 'wait') {
      if (ends(now + sus.us)) {
        return this.waits.timer(block!.at, deadline(), running).deadline;
      }
      return this.waits.timer(now + sus.us, { k: 'wake', s, running }, running)
        .deadline;
    }
    if (sus.k === 'wait-for') {
      // A timeout, and each `after` branch, is a timer; the first to fire
      // ends the wait, as a matching message does.
      const waiter: Waiter = { running, timers: [] };
      const own = [
        ...(sus.timeout === null ? [] : [sus.timeout]),
        ...sus.afters.map(after => after.us),
      ].reduce<bigint | null>(
        (min, ns) => (min === null || now + ns < min ? now + ns : min),
        null,
      );
      if (ends(own)) {
        waiter.timers.push(
          this.waits.timer(block!.at, deadline({ waiter }), running),
        );
        this.waits.addWaiter(s, waiter);
        return block!.at;
      }
      const fire = (branch: number): TimerAction => ({
        k: 'event',
        s,
        waiter,
        branch,
      });
      if (sus.timeout !== null) {
        waiter.timers.push(
          this.waits.timer(now + sus.timeout, fire(0), running),
        );
      }
      for (const after of sus.afters) {
        waiter.timers.push(
          this.waits.timer(now + after.us, fire(after.branch), running),
        );
      }
      this.waits.addWaiter(s, waiter);
      return waiter.timers.reduce<bigint | null>(
        (min, t) => (min === null || t.deadline < min ? t.deadline : min),
        null,
      );
    }
    if (sus.k === 'join') {
      // Each member waits on its own `maxPending` or `MaxWait`.
      const join: JoinWait = {
        members: sus.members,
        answers: new Map<string, Resumption>(),
      };
      // A member's wait took its place when the member started, perhaps in
      // an earlier Pump that preempted the Join (#1752). Of equal deadlines,
      // the block's wins over its members' (chapter 5, Timeout Blocks).
      const orders = sus.members.map(m => m.order ?? this.waits.reserve());
      if (block) {
        join.deadline = this.waits.timer(
          block.at,
          deadline({ join }),
          running,
          Math.min(this.waits.reserve(), ...orders) - 0.5,
        );
      }
      sus.members.forEach((m, i) => {
        const timer = this.waits.timer(
          m.at,
          { k: 'call', id: m.id, ms: m.ms },
          running,
          orders[i],
        );
        this.waits.add(m.id, s, running, timer, join);
      });
      // A sibling's failure may already have cut a retained reply's member.
      for (const { id, reply } of running.run.takeJoinReplies()) {
        if (this.waits.has(id)) {
          this.settleReply(id, reply);
        }
      }
      return block ? block.at : null;
    }
    const id = sus.k === 'ask' ? sus.call.id : sus.id;
    const ms = sus.k === 'ask' ? sus.ms : running.run.limits.maxWaitMs;
    const own = now + BigInt(ms) * 1000n;
    const bounded = ends(own);
    const timer = this.waits.timer(
      bounded ? block!.at : own,
      {
        k: 'call',
        id,
        ms,
        ...(sus.k === 'ask' ? { abort: sus.abort } : {}),
        ...(bounded ? { deadline: block!.after } : {}),
      },
      running,
    );
    this.waits.add(id, s, running, timer);
    // A call's own deadline is shown only inside a Timeout Block.
    return block ? timer.deadline : null;
  }

  private checkFunctionGroups(values: readonly Value[], line?: string) {
    if (!functionsBelongTo(values, this.functionGroup)) {
      if (line) {
        this.recordRefusal(line, 'wrong group');
      }
      throw new HostError('wrong group');
    }
  }

  /** A queued Delivery: its id now, its line and its mailbox entry at the next Pump. */
  private queueDelivery(
    record: 'deliver' | 'request' | 'decide' | 'call-value',
    to: string | ObjectState,
    m: Message,
    request: Delivery['request'],
    ballot?: Ballot,
    fn?: Value,
  ): Delivery {
    const notify = !this.combinedAdmission;
    this.combinedAdmission = false;
    requireArgs(
      m.args ?? [],
      fn ? 'call' : `${record}('${m.name}')`,
      fn ? undefined : m.name,
    );
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
      this.recordRefusal(this.deliveryLine(record, null, toText, m, fn), code);
      throw error;
    };
    if (!fn && !validMessageSelector(m.name, m.args?.length ?? 0)) {
      refuse(
        'invalid value',
        new HostError(
          'invalid value',
          'Malformed message Selector or argument count',
        ),
      );
    }
    try {
      this.checkFunctionGroups(m.args ?? []);
    } catch (error) {
      if (!(error instanceof HostError)) {
        throw error;
      }
      refuse(error.code, error);
    }
    for (const [name, value] of Object.entries(m.limits ?? {})) {
      const limit = (state?.limits ?? defaultLimits)[name as LimitName];
      if (!validOverride(name, value, limit)) {
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
      ...(fn ? { fn } : {}),
      id: `d${++this.deliveries}`,
      from: null,
      at: named ? state!.owner : null,
      target: named ? state!.owner : to,
      ...(named ? {} : { path: { after: false, from: to } }),
      reply: null,
      message: m.name,
      args: m.args ?? [],
      limits: m.limits ?? {},
      request,
    };
    if (state) {
      state.incoming++;
    }
    this.ancestry(delivery);
    this.queueInput(
      {
        line: this.deliveryLine(record, delivery.id, toText, m, fn),
        action: { k: 'delivery', to, state: state ?? null, delivery },
      },
      notify,
    );
    return delivery;
  }

  /** Queued. Asks the object's Message Path for a Verdict. */
  decide(to: HostObject, m: Message, o?: CancellationOptions): Deciding {
    return this.queueDecision(this.held(to), m, o);
  }

  private queueDecision(
    to: string | ObjectState,
    m: Message,
    o?: CancellationOptions,
  ): Deciding {
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
    const delivery = this.queueDelivery('decide', to, m, null, ballot);
    decision.id = delivery.id!;
    ballot.delivery = delivery.id!;
    this.watchCancellation(delivery, o?.signal);
    return { id: decision.id, decided };
  }

  /** Queued. Takes recipients at drain, then waits for every Verdict. */
  decideBroadcast(m: Message, o?: CancellationOptions): Deciding {
    let resolve!: Decision['resolve'];
    const decided = new Promise<Decided>(settle => {
      resolve = settle;
    });
    const decision: Decision = {
      id: `b${this.broadcasts + 1}`,
      broadcast: true,
      ballots: [],
      resolve,
    };
    this.queueBroadcast(m, decision.id, decision);
    this.broadcasts++;
    if (o?.signal) {
      const cancel = () => {
        if (!decision.settled) {
          this.cancelDelivery(decision.id);
        }
      };
      o.signal.addEventListener('abort', cancel, { once: true });
      decision.unsubscribe = () =>
        o.signal!.removeEventListener('abort', cancel);
      if (o.signal.aborted) {
        cancel();
      }
    }
    return { id: decision.id, decided };
  }

  /** Queued. Delivers to recipients taken in load order at drain. */
  broadcast(m: Message): string {
    const id = `b${this.broadcasts + 1}`;
    this.queueBroadcast(m, id);
    this.broadcasts++;
    return id;
  }

  private queueBroadcast(m: Message, id: string, decision?: Decision) {
    const record = decision ? 'decide-broadcast' : 'broadcast';
    requireArgs(m.args ?? [], `broadcast('${m.name}')`, m.name);
    if (!validMessageSelector(m.name, m.args?.length ?? 0)) {
      this.recordRefusal(
        recordLine(record, [], messageFields(m), true),
        'invalid value',
      );
      throw new HostError(
        'invalid value',
        'Malformed message Selector or argument count',
      );
    }
    this.checkFunctionGroups(
      m.args ?? [],
      recordLine(record, [], messageFields(m), true),
    );
    for (const [name, value] of Object.entries(m.limits ?? {})) {
      if (!validOverride(name, value, defaultLimits[name as LimitName])) {
        this.recordRefusal(
          recordLine(record, [], messageFields(m), true),
          'invalid value',
        );
        throw new HostError(
          'invalid value',
          `A Broadcast override may only tighten ${name}`,
        );
      }
    }
    const action: Extract<InputAction, { k: 'broadcast' }> = {
      k: 'broadcast',
      m,
      id,
      decision,
    };
    this.queueInput({ action, line: () => this.broadcastLine(action) });
  }

  private broadcastLine(
    action: Extract<InputAction, { k: 'broadcast' }>,
  ): string {
    const { m, id, decision } = action;
    const record = decision ? 'decide-broadcast' : 'broadcast';
    requireArgs(m.args ?? [], `broadcast('${m.name}')`, m.name);
    action.recipients = this.scripts
      .filter(
        s =>
          !s.stopped &&
          (s.loaded.clauses.has(m.name) ||
            this.waits
              .waitersOf(s)
              .some(
                w =>
                  w.running.run.suspended?.k === 'wait-for' &&
                  w.running.run.suspended.whens.some(b => b.message === m.name),
              )),
      )
      .map(s => {
        const ballot: Ballot | undefined = decision ? { decision } : undefined;
        if (ballot) {
          decision!.ballots.push(ballot);
        }
        const deliveryId = `d${++this.deliveries}`;
        if (ballot) {
          ballot.delivery = deliveryId;
        }
        return {
          s,
          delivery: {
            ballot,
            broadcast: id,
            id: deliveryId,
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
    for (const recipient of action.recipients) {
      this.ancestry(recipient.delivery);
    }
    return recordLine(
      record,
      [id],
      [
        ...messageFields(m),
        [
          'recipients',
          idList(action.recipients.map(r => `${r.s.name}:${r.delivery.id}`)),
        ],
      ],
      true,
    );
  }

  private seal(delivery: Delivery, result: NonNullable<Ballot['result']>) {
    const ballot = delivery.ballot;
    if (!ballot || ballot.result) {
      return;
    }
    ballot.result = result;
    delivery.unsubscribe?.();
    if (ballot.decision.ballots.every(b => b.result)) {
      this.reportDecision(ballot.decision);
    }
  }

  private reportDecision(decision: Decision) {
    decision.settled = true;
    decision.unsubscribe?.();
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
          : decision.discarded
            ? 'undecided'
            : 'allowed',
      vetoes,
      undecided,
    };
    this.trace?.(
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
    decision.resolve?.(result);
  }

  /** Queued. Routes to the object's nearest Owning Script; returns the delivery id. */
  deliver(to: HostObject, m: Message): string {
    return this.queueDelivery('deliver', this.held(to), m, null).id!;
  }
  /** Queued. As `deliver`, and settles when a Pump ends the Run. */
  request(to: HostObject, m: Message, o?: CancellationOptions): Requested {
    let settle!: Delivery['request'];
    const result = new Promise<Value>((resolve, reject) => {
      settle = { resolve, reject };
    });
    result.catch(() => {});
    const delivery = this.queueDelivery('request', this.held(to), m, settle);
    this.watchCancellation(delivery, o?.signal);
    return { id: delivery.id!, result };
  }

  /** Worker. Admit once, then Pump once; a Pump refusal retains the Request. */
  requestPump(
    to: HostObject,
    m: Message,
    now: bigint,
    o?: PumpOptions & CancellationOptions,
  ): PumpedRequest {
    return this.combine(() => this.request(to, m, o), now, o);
  }

  /** Worker. A Function Call and one Pump, with ordinary Call options. */
  callPump(
    fn: Value,
    args: Value[],
    now: bigint,
    o?: PumpOptions & CancellationOptions & { limits?: LimitOverride },
  ): PumpedRequest {
    return this.combine(() => this.call(fn, args, o), now, o);
  }

  private combine(
    admit: () => Requested,
    now: bigint,
    o?: PumpOptions,
  ): PumpedRequest {
    let requested: Requested;
    try {
      this.worker();
    } catch (error) {
      return { admitted: false, error };
    }
    this.combining = true;
    this.combinedAdmission = true;
    let refused = false;
    try {
      try {
        requested = admit();
      } catch (error) {
        return { admitted: false, error };
      }
      this.combinedAdmission = false;
      try {
        return {
          admitted: true,
          requested,
          pump: { ok: true, result: this.pumpWorker(now, o ?? {}) },
        };
      } catch (error) {
        refused = true;
        return { admitted: true, requested, pump: { ok: false, error } };
      }
    } finally {
      this.combining = false;
      this.combinedAdmission = false;
      if (refused && this.onReady) {
        queueMicrotask(this.onReady);
      }
    }
  }

  /** Queued. Calls a Function Value as a Request to its Home Script. */
  call(
    fn: Value,
    args: Value[],
    o?: CancellationOptions & { limits?: LimitOverride },
  ): Requested {
    requireValue(fn);
    requireArgs(args, 'call');
    const ref = fn.asFunction();
    if (!ref || ref.group !== this.functionGroup) {
      const code = ref ? 'wrong group' : 'invalid value';
      this.recordRefusal(
        recordLine(
          'call-value',
          [],
          [
            ['fn', traceValue(fn)],
            ['args', traceValue(listValues(args))],
          ],
          true,
        ),
        code,
      );
      throw new HostError(code);
    }
    let settle!: Delivery['request'];
    const result = new Promise<Value>((resolve, reject) => {
      settle = { resolve, reject };
    });
    result.catch(() => {});
    const delivery = this.queueDelivery(
      'call-value',
      ref.home,
      { name: '', args, limits: o?.limits },
      settle,
      undefined,
      fn,
    );
    this.watchCancellation(delivery, o?.signal);
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

  /** The handle with this Object Kind name and id, disposed or not, such as one Restore made. */
  objectById(kind: string, id: string): HostObject | undefined {
    return this.objects.get(`${kind}\u0000${id}`)?.handle;
  }

  /** Whether an object value is one of this Group's handles. */
  private holdsObject(v: Value): boolean {
    const state = stateOf(v);
    return (
      !!state &&
      this.objects.get(`${state.handle.kind.name}\u0000${state.handle.id}`) ===
        state
    );
  }

  // The Group's state of a handle, which must be one of its own.
  private held(o: HostObject): ObjectState {
    const state = stateOf(o.value);
    if (!state || this.objects.get(`${o.kind.name}\u0000${o.id}`) !== state) {
      throw new HostError('wrong group', `${o.value} isn't this Group's`);
    }
    return state;
  }

  private parentError(
    child: ObjectState,
    up: ObjectState | null,
  ): HostErrorCode | undefined {
    if (child.disposed) {
      return 'invalid value';
    }
    for (let x = up; x; x = x.parent) {
      if (x === child) {
        return 'parent cycle';
      }
    }
    return undefined;
  }

  /** Queued. Refuses cycles and disposed children at admission and again at drain. */
  setParent(o: HostObject, parent: HostObject | undefined): void {
    const child = this.held(o);
    const up = parent ? this.held(parent) : null;
    const line = recordLine(
      'set-parent',
      [],
      [
        ['object', traceValue(child.handle.value)],
        ['parent', up ? traceValue(up.handle.value) : 'nothing'],
      ],
      true,
    );
    const code = this.parentError(child, up);
    if (code) {
      this.recordRefusal(line, code);
      throw new HostError(code, 'invalid parent relationship');
    }
    this.queueInput({
      line,
      action: { k: 'set-parent', child, up },
    });
  }

  /** Queued. Disposes an object: it stays a value, and sends to it raise `object gone`. */
  dispose(o: HostObject): void {
    const state = this.held(o);
    this.queueInput({
      line: recordLine(
        'dispose',
        [],
        [['object', traceValue(state.handle.value)]],
        true,
      ),
      action: { k: 'dispose', state },
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
  private unhandled(delivery: Delivery, reports: Report[], run?: string) {
    this.trace?.(
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
    this.session?.runs({
      k: 'unhandled',
      ...(run ? { run } : {}),
      message: delivery.message,
      args: delivery.args,
    });
    if (delivery.id) {
      reports.push({
        kind: 'unhandled',
        delivery: delivery.id,
        message: { name: delivery.message, args: delivery.args },
        ...(delivery.target ? { target: delivery.target.handle } : {}),
      });
    }
    this.seal(delivery, { verdict: 'allowed' });
    this.answer(delivery, { kind: 'unhandled' });
  }

  // Settle what waits on a message's Run: a sender's reply, or a Request.
  private answer(
    delivery: Delivery,
    outcome: Outcome | { kind: 'stopped' | 'function gone' },
  ) {
    delivery.unsubscribe?.();
    if (delivery.reply) {
      this.settleReply(
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
        delivery.request.reject(sendFailed(outcome.kind));
      }
    }
  }

  private deliveryLine(
    record: string,
    id: string | null,
    to: string,
    m: Message,
    fn?: Value,
  ) {
    if (fn) {
      return recordLine(
        record,
        [id],
        [
          ['fn', traceValue(fn)],
          ...messageFields(m).filter(([key]) => key !== 'message'),
        ],
        true,
      );
    }
    return recordLine(record, [id], [['to', to], ...messageFields(m)], true);
  }

  /** Worker. One Clock reading, the queue drained, then turns until done (chapter 5). */
  pump(now: bigint, o: PumpOptions = {}): PumpResult {
    this.worker();
    return this.pumpWorker(now, o);
  }

  private pumpWorker(now: bigint, o: PumpOptions): PumpResult {
    if (this.lastClock !== null && now < this.lastClock) {
      this.trace?.(
        recordLine(
          'pump',
          [],
          [
            ['clock', formatInstant(now)],
            ['fuel-slice', o.fuelSlice ? String(o.fuelSlice) : null],
            ['fuel-cap', o.fuelCap ? String(o.fuelCap) : null],
          ],
          true,
        ),
      );
      this.trace?.(recordLine('refused', [], [['code', '"clock backwards"']]));
      throw new HostError('clock backwards');
    }
    this.pumping = true;
    this.debugPump = this.pumpAtClock(now, o);
    return this.advanceDebugPump();
  }

  private *pumpAtClock(
    now: bigint,
    o: PumpOptions,
  ): Generator<DebugPause, PumpResult> {
    this.lastClock = now;
    this.rewound = false;
    this.drainCharges.clear();
    const firstRestorePump = this.restored;
    this.restored = false;
    const slice = o.fuelSlice ?? 0;
    const cap = o.fuelCap ?? 0;
    const drained = this.inputs;
    this.inputs = [];
    const reports: Report[] = [];
    this.drainReports = reports;
    const inputLines: string[] = [];
    const outputLines: string[] = [];
    this.drainingTrace = outputLines;
    try {
      for (const input of drained) {
        // A deferred line also selects Broadcast recipients at drain time.
        inputLines.push(
          typeof input.line === 'string' ? input.line : input.line(),
        );
        this.applyInput(input.action);
      }
    } finally {
      this.drainingTrace = null;
    }
    for (const line of inputLines) {
      this.trace?.(line);
    }
    this.trace?.(
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
    for (const line of outputLines) {
      this.trace?.(line);
    }
    if (firstRestorePump) {
      for (const id of [...this.unsettled].sort(compareCallIds)) {
        this.settleReply(id, { k: 'restore-fail', code: 'call lost' });
      }
      this.unsettled.clear();
    }
    for (const decision of this.discardedDecisions.sort(
      (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)),
    )) {
      for (const ballot of decision.ballots) {
        if (!ballot.result) {
          ballot.result = {
            verdict: 'undecided',
            undecided: { script: '', outcome: 'cancelled' },
          };
        }
      }
      this.reportDecision(decision);
    }
    this.discardedDecisions = [];
    // Due timers fire in deadline order, then in the order they were set.
    for (const t of this.waits.takeDue(now)) {
      this.fireTimer(t);
    }
    let fuel = [...this.drainCharges.values()].reduce(
      (sum, cost) => sum + cost,
      0,
    );
    // Each Script's Fuel this Pump, against its slice less any debt.
    const spent = new Map<ScriptState, number>();
    const allowance = new Map<ScriptState, number>();
    for (const s of this.scripts) {
      spent.set(s, this.drainCharges.get(s) ?? 0);
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
    // The Fuel a Script may spend before `preempt` would stop it.
    const room = (s: ScriptState) =>
      Math.min(
        slice > 0 ? allowance.get(s)! - spent.get(s)! : Infinity,
        cap > 0 ? cap - fuel : Infinity,
      );
    let progress = true;
    while (progress && !capped() && !this.rewound) {
      progress = false;
      for (const s of this.scripts) {
        if (!s.queue.length || sliced(s) || capped() || this.rewound) {
          continue;
        }
        progress = true;
        yield* this.turn(
          s,
          reports,
          () => preempt(s),
          () => room(s),
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
    this.landUrgentInputs();
    for (const s of this.scripts) {
      if (s.stopped) {
        this.dropStoppedMailbox(s);
      }
    }
    const state = this.rewound
      ? 'rewound'
      : this.scripts.length && this.scripts.every(s => s.stopped)
        ? 'stopped'
        : this.scripts.some(s => s.queue.length)
          ? 'sliced'
          : 'idle';
    this.rewound = false;
    const mathematicalNext = this.waits.next();
    const next =
      mathematicalNext === null || isInstant(mathematicalNext)
        ? mathematicalNext
        : mathematicalNext < now
          ? now
          : null;
    this.trace?.(
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
    this.flushAccounting(reports);
    this.settleCharges();
    return {
      state,
      ...(next === null ? {} : { nextDeadline: next }),
      fuelUsed: fuel,
      reports,
    };
  }

  // An admitted message follows its live path before any dispatch or observation.
  // Moving is no new admission: it joins the destination tail even past its depth.
  private moveDelivery(
    s: ScriptState,
    delivery: Delivery,
    reports: Report[],
  ): boolean {
    const path = delivery.path;
    if (!path) {
      return false;
    }
    const next = this.route(path.after ? path.from.parent : path.from);
    if (next?.s === s) {
      delivery.at = next.at;
      return false;
    }
    s.queue.shift();
    if (next) {
      this.acceptDelivery(next.s, { ...delivery, at: next.at });
    } else {
      this.unhandled(delivery, reports);
    }
    return true;
  }

  // A Script's turn: its queue's head runs until it ends or is preempted.
  private *turn(
    s: ScriptState,
    reports: Report[],
    preempt: () => 'slice' | 'cap' | null,
    room: () => number,
    charge: (fuel: number) => void,
  ): Generator<DebugPause, void> {
    if (s.stopped) {
      this.dropStoppedMailbox(s);
      return;
    }
    let head = s.queue[0]!;
    let how: 'start' | 'continue' | 'resume' = 'continue';
    if (!('run' in head)) {
      const delivery = head;
      if (this.moveDelivery(s, delivery, reports)) {
        return;
      }
      if (!delivery.fn) {
        // Observation belongs to the waiting Runs, but spends this Script's
        // slice and the Group cap before the incoming Run's first instruction.
        charge(this.observe(s, delivery));
      }
      if (delivery.during && !s.loaded.clauses.has('error')) {
        s.queue.shift();
        return;
      }
      const limits = Object.fromEntries(
        Object.entries(delivery.limits).map(([name, value]) => [
          name,
          Math.min(value!, s.limits[name as LimitName]),
        ]),
      );
      const run = delivery.fn
        ? Run.fromFunction(s.loaded, delivery.fn, delivery.args, {
            ...s.limits,
            ...limits,
          })
        : dispatch(
            s.loaded,
            delivery.message,
            delivery.args,
            limits,
            // A Broadcast, a Decision and an `error` message never reach a
            // Fallback Handler, anywhere on their path (ADR 0064).
            !delivery.broadcast && !delivery.ballot && !delivery.during,
          );
      // At this Run's end, the rest of the queue is what the Script keeps.
      run.persistentState = () => this.persistentState(s, 1);
      head = {
        id: `${s.name}/r${++s.runs}`,
        delivery,
        run,
        resuming: false,
      };
      this.accountStart(s, head);
      run.id = head.id;
      run.host = this.hostFor(s, run, delivery.id);
      if (delivery.during) {
        run.setDuring(delivery.during);
      }
      // The object it was delivered to, or for a message to a Script, the
      // Script's owner (chapter 5, `the target`).
      run.target = delivery.fn
        ? nothing
        : ((delivery.target ?? s.owner)?.handle.value ?? nothing);
      s.queue[0] = head;
      how = 'start';
    }
    const running = head;
    if (running.resuming) {
      running.resuming = false;
      how = 'resume';
    }
    const { run } = running;
    this.debugController?.attach(run, running.delivery.reply);
    const fuel0 = run.fuel;
    const alloc0 = run.alloc;

    const earlierRuns = () =>
      this.runsOf(s).filter(
        r => r !== running && r.selected && sameClause(r, running),
      );
    const replaceEarlier = () => {
      for (const r of earlierRuns()) {
        if (!r.run.openVerdict) {
          this.cancelRunning(s, r);
        }
      }
    };
    const dispatchPaid = () => {
      const clause = run.selectedClause;
      if (clause?.policy === 'replacing') {
        replaceEarlier();
      }
      if (clause && !clause.deciding && !run.done) {
        this.seal(running.delivery, { verdict: 'allowed' });
      }
    };
    const selected = () => {
      const clause = run.selectedClause;
      if (!running.selected && clause) {
        const earlier = earlierRuns();
        if (
          !run.acceptClause(
            earlier.length > 0 &&
              (clause.policy === 'queued' || clause.policy === 'dropping'),
          )
        ) {
          return;
        }
        running.selected = true;
        if (clause.policy === 'dropping' && earlier.length) {
          run.drop();
          return;
        }
        if (clause.policy === 'queued' && earlier.length) {
          running.parked = run.park();
        }
        if (clause.policy === 'replacing' && !run.clauseChargePending) {
          replaceEarlier();
        }
        if (!clause.deciding && !run.done && !run.clauseChargePending) {
          this.seal(running.delivery, { verdict: 'allowed' });
        }
        run.openVerdict =
          clause.deciding === true &&
          !!running.delivery.ballot &&
          !running.delivery.ballot.result;
      }
    };
    this.active = { s, running, records: run.records.length };
    if (running.cleanupReady) {
      running.cleanupReady = false;
      run.beginCleanupSegment();
    } else if (how === 'resume' && !run.suspended && !run.cancelling) {
      run.beginReadySegment();
    }
    selected();
    charge(run.fuel - fuel0);
    let last = run.fuel;
    let by: 'slice' | 'cap' | null = null;
    // Write a step's records and settle what it changed.
    const stepped = () => {
      run.finishInstruction();
      this.writeRecords(running, this.active!.records);
      this.active!.records = run.records.length;
      if (run.effectStateUnknown) {
        this.stopUnknownEffects();
      }
      selected();
      charge(run.fuel - last);
      last = run.fuel;
    };
    while (
      !run.done &&
      !run.suspended &&
      !running.parked &&
      !s.stopped &&
      !running.rewound
    ) {
      // Instructions that write no record need none of this loop's per-step
      // work once the clause is selected (a function Run has none), while no
      // debugger watches them.
      if (
        (running.selected || running.delivery.fn) &&
        !this.debugController &&
        !machineDebug.get(run)
      ) {
        if (run.stepMany(room())) {
          stepped();
          continue;
        }
        charge(run.fuel - last);
        last = run.fuel;
      }
      // Selection/parking can fault without stepping an instruction. Finish
      // that deferred fault before a cap or slice may end this stretch.
      by = machineDebug.get(run)?.pending || run.holding ? null : preempt();
      if (by) {
        break;
      }
      const pause = this.debugController?.boundary(run, s.name);
      if (pause) {
        yield pause;
        this.landUrgentInputs();
        if (run.done || run.suspended || s.stopped || running.rewound) {
          break;
        }
      }
      const debug = machineDebug.get(run);
      if (debug?.pending) {
        const pending = debug.pending;
        debug.pending = null;
        debug.fault = null;
        pending();
      } else {
        run.step(
          running.selected && run.clauseChargePending
            ? dispatchPaid
            : undefined,
        );
      }
      while (debug?.pending) {
        const faultPause = this.debugController!.boundary(run, s.name)!;
        const cancelling = run.cancelling;
        yield faultPause;
        this.landUrgentInputs();
        if (
          s.stopped ||
          run.done ||
          running.rewound ||
          run.cancelling !== cancelling
        ) {
          debug.pending = null;
          debug.fault = null;
          break;
        }
        const pending = debug.pending;
        debug.pending = null;
        debug.fault = null;
        pending();
      }
      stepped();
    }
    let outcome = run.ended;
    if (outcome?.kind === 'completed' && outcome.veto && !run.openVerdict) {
      this.trace?.(recordLine('note', [running.id], [['kind', 'no-verdict']]));
    }
    if (outcome) {
      this.debugController?.ended(run);
      s.suspended.delete(running);
    }
    if (outcome) {
      this.writeEnding(running, outcome);
    }
    if ((run.done || run.suspended) && !s.stopped) {
      this.finalizeEffects(running);
    }
    if (run.effectStateUnknown) {
      this.stopUnknownEffects();
    }
    outcome = run.ended;
    this.active = null;
    if (run.suspended) {
      this.releaseRecords(running);
    }
    const { handler, fallback } = this.handlerOf(s, running, outcome);
    const observe = (end: string, until?: bigint) =>
      this.session?.runs({
        k: 'seg',
        run: running.id,
        how,
        ...(how === 'start' && running.delivery.id
          ? { delivery: running.delivery.id }
          : {}),
        end,
        ...(until === undefined || !isInstant(until) ? {} : { until }),
        calls: end === 'stop' ? [] : (this.waitView(running).calls ?? []),
      });
    const start: [string, string | null][] =
      this.trace && how === 'start'
        ? [
            ['delivery', running.delivery.id],
            ['broadcast', running.delivery.broadcast ?? null],
            ['from', running.delivery.from],
            ['handler', handler],
            ['fallback', fallback ? 'yes' : null],
            // No clause matched an unhandled Run.
            [
              'clause',
              run.clauseNumber && outcome?.kind !== 'unhandled'
                ? String(run.clauseNumber)
                : null,
            ],
            [
              'fn',
              running.delivery.fn ? traceValue(running.delivery.fn) : null,
            ],
          ]
        : [];
    const stretch: [string, string][] = this.trace
      ? [
          ['fuel', String(run.fuel - fuel0)],
          ['alloc', String(run.alloc - alloc0)],
        ]
      : [];
    if (running.rewound) {
      this.trace?.(
        recordLine(
          'seg',
          [running.id, how],
          [
            ...start,
            ...stretch,
            ['state', String(this.persistentState(s))],
            ['end', 'rewind'],
          ],
        ),
      );
      observe('rewind');
      return;
    }
    if (s.stopped) {
      this.trace?.(
        recordLine(
          'seg',
          [running.id, how],
          [
            ...start,
            ...stretch,
            ['state', String(this.persistentState(s))],
            ['end', 'stop'],
          ],
        ),
      );
      observe('stop');
      this.activeStop?.();
      this.activeStop = null;
      return;
    }
    if (running.parked && !outcome) {
      s.queue.shift();
      s.parked.push(running);
      markRest(running, running.run);
      lastWaits.set(running, {
        ...lastWaits.get(running),
        suspendedAt: 'park',
      });
      this.trace?.(
        recordLine(
          'seg',
          [running.id, how],
          [
            ...start,
            ...stretch,
            ['state', String(this.persistentState(s))],
            ['end', 'park'],
          ],
        ),
      );
      observe('park');
      return;
    }
    if (!outcome && run.suspended) {
      const suspension = run.suspended;
      s.queue.shift();
      const deadline = this.suspended(s, running, suspension);
      this.trace?.(
        recordLine(
          'seg',
          [running.id, how],
          [
            ...start,
            ...stretch,
            ['state', String(this.persistentState(s))],
            [
              'end',
              suspension.k === 'wait-for' && suspension.any
                ? 'wait-for-any'
                : suspendReasons[suspension.k],
            ],
            [
              'until',
              deadline === null || !isInstant(deadline)
                ? null
                : formatInstant(deadline),
            ],
          ],
        ),
      );
      observe(
        suspension.k === 'wait-for' && suspension.any
          ? 'wait-for-any'
          : suspendReasons[suspension.k],
        deadline ?? undefined,
      );
      this.seal(running.delivery, { verdict: 'allowed' });
      run.openVerdict = false;
      return;
    }
    if (!outcome) {
      markRest(running, running.run);
      this.trace?.(
        recordLine(
          'preempt',
          [running.id, how],
          [...start, ['by', by], ...stretch],
        ),
      );
      this.writeCancellationAbandons(run);
      return;
    }
    s.queue.shift();
    this.trace?.(
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
    observe(endReason(outcome));
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
    this.writeCancellationAbandons(run);
    run.openVerdict = false;
    this.endRun(s, running, outcome, reports, handler, fallback);
  }

  // A Run a Fallback Handler clause took names the message's Selector as
  // its Handler; one that ended unhandled took no clause (ADR 0064).
  private handlerOf(
    s: ScriptState,
    running: Running,
    outcome: Outcome | null,
  ): { fallback: boolean; handler: string | null } {
    const fallback = running.run.fallback && outcome?.kind !== 'unhandled';
    const handler =
      !running.delivery.fn &&
      (fallback || s.loaded.clauses.has(running.delivery.message))
        ? running.delivery.message
        : null;
    return { fallback, handler };
  }

  // A fault's records and its abandonments, or a failed cleanup's record.
  private writeEnding(running: Running, outcome: Outcome) {
    if (outcome.kind === 'limit fault') {
      this.trace?.(
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
      for (const id of running.run.faultAbandons) {
        this.trace?.(recordLine('abandon', [id], []));
      }
    }
    if (outcome.kind === 'cancelled' && outcome.cleanupFailed) {
      const failed = outcome.cleanupFailed;
      this.trace?.(
        recordLine(
          'cleanup-failed',
          [running.id],
          [
            ['code', 'code' in failed ? JSON.stringify(failed.code) : null],
            [
              'limit',
              'limit' in failed
                ? (faultNames[failed.limit] ?? failed.limit)
                : null,
            ],
          ],
        ),
      );
    }
  }

  private writeCancellationAbandons(run: Run) {
    for (const id of run.cancellationAbandons) {
      this.trace?.(recordLine('abandon', [id], []));
    }
    run.cancellationAbandons = [];
  }

  // The Host-side report of a `host error`, beside its `call-failed` record.
  private callFailed(
    script: string,
    rec: Extract<MachineRunRecord, { kind: 'call-failed' }>,
  ): Report {
    const dot = rec.op.indexOf('.');
    const grant = rec.op.slice(0, dot);
    return {
      kind: 'call failed',
      script,
      call: rec.id,
      operation: {
        capability:
          this.scripts.find(s => s.name === script)?.grants.get(grant)
            ?.capability.name ?? grant,
        operation: rec.op.slice(dot + 1),
      },
      detail: rec.detail,
    };
  }

  // A suspended Run has committed its Segment, so it can't be rewound and the
  // Trace has its records. It keeps only its pending calls, for their
  // arguments, and its latest Recovery Offer choice, which restore checks
  // against its attempt count. A long-lived Run's save then doesn't grow
  // with every call it has made (#1119).
  private releaseRecords(running: Running) {
    const { run } = running;
    const written = running.recordsWritten ?? 0;
    let lastOffer = -1;
    run.records.forEach((r, i) => {
      if (r.kind === 'offer-chosen') {
        lastOffer = i;
      }
    });
    const kept = run.records.filter(
      (r, i) =>
        i >= written ||
        i === lastOffer ||
        (r.kind === 'call' && run.pendingCall(r.id) !== undefined),
    );
    if (kept.length !== run.records.length) {
      running.recordsWritten = written - (run.records.length - kept.length);
      run.records = kept;
    }
  }

  private writeRecords(running: Running, records0: number) {
    const { run } = running;
    for (
      let i = Math.max(records0, running.recordsWritten ?? 0);
      i < run.records.length;
      i++
    ) {
      running.recordsWritten = i + 1;
      const rec = run.records[i]!;
      if (rec.kind === 'scope') {
        this.trace?.(
          recordLine(
            'scope',
            [rec.id],
            [
              ['grant', rec.grant],
              ['name', rec.name],
              ['action', rec.action],
            ],
          ),
        );
        continue;
      }
      if (rec.kind === 'effect') {
        this.trace?.(
          recordLine(
            'effect',
            [rec.segment],
            [
              ['grant', rec.grant],
              ['phase', rec.phase],
              ['status', rec.status],
            ],
          ),
        );
        continue;
      }
      if (rec.kind === 'effect-failure') {
        this.trace?.(
          recordLine(
            'effect-failure',
            [running.id],
            [
              ['grant', rec.grant],
              ['segment', rec.segment],
              ['phase', rec.phase],
              ['status', rec.status],
              ['scope', rec.scope ?? null],
            ],
          ),
        );
        this.drainReports.push({
          kind: 'effect failure',
          script: run.script.name,
          run: running.id,
          grant: rec.grant,
          segment: rec.segment,
          phase: rec.phase,
          status: rec.status,
          ...(rec.scope ? { scope: rec.scope } : {}),
          detail: rec.detail,
        });
        if (rec.phase === 'abandon') {
          this.releaseGrant(
            this.scripts.find(s => s.name === run.script.name)!,
            rec.grant,
            'disable',
          );
        }
        continue;
      }
      if (rec.kind === 'abandon') {
        this.trace?.(recordLine('abandon', [rec.id], []));
        continue;
      }
      if (rec.kind === 'unhandled') {
        this.trace?.(
          recordLine(
            'unhandled',
            [],
            [
              ['message', rec.message ?? null],
              [
                'args',
                rec.args.length ? traceValue(listValues(rec.args)) : null,
              ],
              ['target', rec.target ? traceValue(rec.target) : null],
            ],
          ),
        );
        this.session?.runs({
          k: 'unhandled',
          run: running.id,
          message: rec.message ?? '',
          args: rec.args,
        });
        continue;
      }
      if (rec.kind === 'prop') {
        this.trace?.(
          recordLine(
            'prop',
            [running.id],
            [
              ['object', traceValue(rec.object)],
              ['name', rec.name],
              ['op', rec.op],
              ['selector', rec.selector ? traceValue(rec.selector) : null],
              ['value', rec.value ? traceValue(rec.value) : null],
              ['error', rec.error ? traceValue(rec.error) : null],
            ],
          ),
        );
        continue;
      }
      if (rec.kind === 'call') {
        this.trace?.(
          recordLine(
            'call',
            [rec.id],
            [
              ['op', rec.op],
              ['args', traceValue(listValues(rec.args))],
              ['result', rec.result ? traceValue(rec.result) : null],
              ['error', rec.error ? traceValue(rec.error) : null],
              ['charged', rec.charged ? String(rec.charged) : null],
              ['automatic', rec.automatic ? 'yes' : null],
            ],
          ),
        );
        this.session?.runs({ k: 'call', call: rec.id, run: running.id });
        continue;
      }
      if (rec.kind === 'call-failed') {
        if (rec.id) {
          this.trace?.(recordLine('call-failed', [rec.id], [['op', rec.op]]));
          this.session?.runs({ k: 'call', call: rec.id, run: running.id });
        }
        this.drainReports.push(this.callFailed(run.script.name, rec));
        continue;
      }
      if (rec.kind === 'send') {
        this.trace?.(
          recordLine(
            'send',
            [rec.id ?? running.id],
            [
              ['to', rec.to],
              ['message', rec.message ?? null],
              ['fn', rec.fn ? traceValue(rec.fn) : null],
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
      if (rec.kind === 'offer-chosen' || rec.kind === 'offer-entered') {
        this.trace?.(
          recordLine(
            rec.kind,
            [running.id],
            [
              ['attempt', String(rec.attempt)],
              ...(rec.kind === 'offer-chosen'
                ? ([
                    ['name', traceValue(text(rec.name))],
                    ['at', `${rec.at.unit}:${rec.at.pc}`],
                  ] as [string, string][])
                : []),
              ['target', `${rec.target.unit}:${rec.target.pc}`],
              ...(rec.kind === 'offer-chosen' && rec.args.length
                ? ([['args', traceValue(listValues(rec.args))]] as [
                    string,
                    string,
                  ][])
                : []),
            ],
          ),
        );
        continue;
      }
      const at = `${rec.unit}:${rec.pc}`;
      const pos = `${rec.line}:${rec.col}`;
      this.trace?.(
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
  }

  private endRun(
    s: ScriptState,
    running: Running,
    outcome: Outcome,
    reports: Report[],
    handler: string | null,
    fallback: boolean,
  ) {
    const { run, delivery } = running;
    this.accumulateRunCosts(s, run);
    if (outcome.kind === 'limit fault') {
      s.faults++;
    }
    const word =
      outcome.kind === 'limit fault'
        ? 'limit-fault'
        : outcome.kind === 'effect failed'
          ? 'effect-failed'
          : outcome.kind;
    const result = outcome.kind === 'completed' ? outcome.result : null;
    const error = outcome.kind === 'errored' ? outcome.error : null;
    const limit =
      outcome.kind === 'limit fault' ? limitWord(outcome.limit) : null;
    this.trace?.(
      recordLine(
        'run',
        [running.id],
        [
          ['outcome', word],
          ['delivery', delivery.id],
          ['broadcast', delivery.broadcast ?? null],
          ['handler', handler],
          ['fallback', fallback ? 'yes' : null],
          ['fn', delivery.fn ? traceValue(delivery.fn) : null],
          [
            'value',
            result && result.kind !== 'nothing' ? traceValue(result) : null,
          ],
          ['error', error ? traceValue(error) : null],
          ['limit', limit],
          [
            'effect',
            outcome.kind === 'effect failed'
              ? traceValue(
                  map([
                    ['grant', text(outcome.effect.grant)],
                    ['segment', text(outcome.effect.segment)],
                    ['phase', text(outcome.effect.phase)],
                    ['status', text(outcome.effect.status)],
                    ...(outcome.effect.scope
                      ? [
                          ['scope', text(outcome.effect.scope)] as [
                            string,
                            Value,
                          ],
                        ]
                      : []),
                  ]),
                )
              : null,
          ],
          ['fuel', String(run.fuel)],
          ['alloc', String(run.alloc)],
        ],
      ),
    );
    this.session?.runs({
      k: 'run',
      run: running.id,
      outcome: word,
      ...(delivery.id ? { delivery: delivery.id } : {}),
      ...(error ? { error } : {}),
    });
    this.accountEnd(running, 'terminal');
    reports.push({
      kind: 'run end',
      script: s.name,
      run: running.id,
      ...(delivery.id ? { delivery: delivery.id } : {}),
      ...(delivery.broadcast ? { broadcast: delivery.broadcast } : {}),
      ...(handler ? { handler } : {}),
      ...(fallback ? { fallback } : {}),
      ...(outcome.kind === 'cancelled' && outcome.cleanupFailed
        ? {
            cleanupFailed:
              'code' in outcome.cleanupFailed
                ? outcome.cleanupFailed
                : {
                    limit: limitWord(outcome.cleanupFailed.limit) as Exclude<
                      LimitWord,
                      'fuel'
                    >,
                  },
          }
        : {}),
      outcome: outcome.kind,
      ...(outcome.kind === 'effect failed' ? { effect: outcome.effect } : {}),
      ...(result ? { result } : {}),
      ...(error ? { error: hostError(error) } : {}),
      ...(limit ? { limit } : {}),
      ...(outcome.kind === 'errored'
        ? { at: location(outcome.at) }
        : outcome.kind === 'limit fault'
          ? { at: location(outcome) }
          : {}),
      fuel: run.fuel,
      alloc: run.alloc,
    });
    if (
      outcome.kind === 'errored' ||
      outcome.kind === 'limit fault' ||
      outcome.kind === 'cancelled' ||
      outcome.kind === 'dropped' ||
      outcome.kind === 'effect failed'
    ) {
      this.seal(delivery, {
        verdict: 'undecided',
        undecided: { script: s.name, run: running.id, outcome: outcome.kind },
      });
    }
    if (outcome.kind === 'errored' && delivery.message !== 'error') {
      const waiting =
        s.queue.filter(item => !('run' in item)).length + s.incoming;
      if (waiting >= s.limits.mailboxDepth) {
        this.trace?.(
          recordLine('note', [running.id], [['kind', 'error-dropped']]),
        );
      } else {
        s.queue.push({
          id: null,
          from: running.id,
          ancestry: {
            rootDelivery: this.ancestry(delivery).rootDelivery,
            parentRun: running.id,
          },
          at: s.owner,
          target: s.owner,
          message: 'error',
          args: [outcome.error],
          limits: {},
          reply: null,
          request: null,
          during: map([
            delivery.fn
              ? ['fn', delivery.fn]
              : ['name', text(delivery.message)],
            ['args', listValues(delivery.args)],
          ]),
        });
      }
    }
    // The `error` message goes ahead of the clause's next parked Run (chapter 6).
    this.releaseParked(s, running);
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
        this.unhandled(delivery, reports, running.id);
        return;
      }
      const waiting =
        next.s.queue.filter(item => !('run' in item)).length + next.s.incoming;
      if (waiting >= next.s.limits.mailboxDepth) {
        this.trace?.(
          recordLine('note', [running.id], [['kind', 'climb-full']]),
        );
        this.unhandled(delivery, reports, running.id);
        return;
      }
      next.s.queue.push({
        ...delivery,
        at: next.at,
        target: delivery.target ?? s.owner,
        path: { after: true, from: delivery.at! },
      });
      return;
    }
    this.answer(delivery, outcome);
  }

  private releaseParked(s: ScriptState, ended: Running) {
    const same = (r: Running) =>
      !r.delivery.fn && !ended.delivery.fn && sameClause(r, ended);
    if (this.runsOf(s).some(r => !r.parked && same(r))) {
      return;
    }
    const next = s.parked.find(same);
    if (!next) {
      return;
    }
    s.parked = s.parked.filter(r => r !== next);
    next.parked = false;
    next.resuming = true;
    s.queue.push(next);
  }

  /** A Script's Persistent State: its Script Variables and the messages it holds. */
  private persistentState(s: ScriptState, skip = 0): number {
    let total = s.loaded.variablesSize();
    for (const r of [...s.suspended, ...s.parked]) {
      total += r.run.size();
    }
    for (const item of s.queue.slice(skip)) {
      total +=
        'run' in item
          ? item.run.size()
          : partSize(
              'message',
              0,
              item.args.reduce((sum, v) => sum + sizeOf(v), 0) +
                (item.fn ? sizeOf(item.fn) : 0),
            );
    }
    return total;
  }

  /** Worker, and the Host Input `vars`: the Group, read without changing it. */
  // What a suspended Run waits for, as its `seg` record wrote it.
  private waitView(
    running: Running,
  ): Pick<RunView, 'calls' | 'until' | 'wait'> {
    const sus = running.run.suspended;
    if (!sus) {
      return {};
    }
    // A call's own deadline shows only inside a Timeout Block.
    const until = this.waits.until(running, !!sus.deadline && sus.k !== 'join');
    const calls =
      sus.k === 'ask'
        ? [sus.call.id]
        : sus.k === 'send' || sus.k === 'call-value'
          ? [sus.id]
          : sus.k === 'join'
            ? this.waits.pendingMembers(sus.members).map(m => m.id)
            : [];
    return {
      wait:
        sus.k === 'wait-for' && sus.any
          ? 'wait-for-any'
          : suspendReasons[sus.k],
      ...(until === undefined || !isInstant(until) ? {} : { until }),
      ...(calls.length ? { calls } : {}),
    };
  }

  /** A Run's calls and sends that a Rewind leaves done (ADR 0068). */
  private repeatedEffects(s: ScriptState, run: Run): RepeatedEffect[] {
    return run.records.flatMap((r): RepeatedEffect[] => {
      if (r.kind === 'send') {
        return [
          {
            kind: 'send',
            to: r.to,
            ...(r.message ? { message: r.message } : {}),
          },
        ];
      }
      if (r.kind !== 'call' || r.automatic) {
        return [];
      }
      const [grant, op] = r.op.split('.') as [string, string];
      const declared = s.grants.get(grant)?.capability.operations.get(op);
      return declared && 'segmentBound' in declared && declared.segmentBound
        ? []
        : [{ kind: 'call', id: r.id, op: r.op }];
    });
  }

  private debugSnapshot(): DebugSnapshot {
    const view = this.inspection();
    return {
      scripts: view.scripts.map((s, i) => ({
        ...s,
        runs: s.runs.map(view => {
          const run = this.runsOf(this.scripts[i]!).find(
            r => r.id === view.id,
          )!.run;
          return {
            ...view,
            fuel: run.fuel,
            rewindable: run.rewindable,
            repeated: run.rewindable
              ? this.repeatedEffects(this.scripts[i]!, run)
              : [],
            segment: Number(run.segmentId.split('.s')[1]),
            frames: run.debugFrames().map(({ frame, ...control }) => {
              const ins = frame.code.unit.code[frame.pc]!;
              return {
                ...control,
                unit: frame.code.name,
                handler: frame.handler,
                pc: frame.pc,
                line: ins.line,
                col: ins.col,
                locals: frame.body.locals.map(
                  (name, j) =>
                    [name, frame.locals[j] ?? nothing] as [string, Value],
                ),
              };
            }),
          };
        }),
      })),
    };
  }

  inspect(): Inspection {
    this.worker();
    this.trace?.(recordLine('vars', [], [], true));
    const view = this.inspection();
    for (const s of view.scripts) {
      this.trace?.(
        recordLine(
          'vars',
          [s.name],
          s.vars.map(([n, v]) => [n, traceValue(v)]),
        ),
      );
    }
    return view;
  }

  private inspection(): Inspection {
    const scripts = this.scripts.map(s => {
      const vars = s.loaded.variableNames.map(
        (n, i) => [n, s.loaded.variables[i] ?? nothing] as [string, Value],
      );
      return {
        name: s.name,
        ...(s.disabled.size
          ? { disabledGrants: [...s.disabled].sort(compareText) }
          : {}),
        vars,
        runs: this.runsOf(s).map(item => ({
          id: item.id,
          status: item.parked
            ? ('parked' as const)
            : s.suspended.has(item)
              ? ('suspended' as const)
              : item.resuming
                ? ('ready' as const)
                : ('preempted' as const),
          handler: item.delivery.fn?.toString() ?? item.delivery.message,
          ...(s.suspended.has(item) ? this.waitView(item) : {}),
        })),
        mailbox: s.queue.flatMap((item): MessageView[] =>
          'run' in item
            ? []
            : [
                {
                  ...(item.id === null ? {} : { delivery: item.id }),
                  ...(item.from === null ? {} : { from: item.from }),
                  message: {
                    name: item.fn?.toString() ?? item.message,
                    args: item.args,
                  },
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
  'call-value': 'call-value-wait',
  join: 'join-end',
  'wait-for': 'wait-for',
};
// A Run's error map as the Host reads it: its code and text message, and
// every other field as its data.
const hostError = (error: Value): ScriptError => {
  const message = error.get('message');
  const textMessage = message.kind === 'text';
  return new ScriptError(
    error.get('code').asText() ?? '',
    textMessage ? message.asText()! : '',
    map(
      error
        .entries()
        .filter(([k]) => k !== 'code' && !(k === 'message' && textMessage)),
    ),
  );
};
const location = (at: CodePosition): Location => ({
  unit: at.unit,
  line: at.line,
  col: at.col,
  handler: at.handler,
  pc: at.pc,
});
// A `Fail` as the Trace's `fail` line writes it: `{}` for what isn't a Script error.
/** A restored Request's future, which the old Group's Host held. */
const detachedRequest: NonNullable<Delivery['request']> = {
  resolve: () => {},
  reject: () => {},
};

/** A `settle` Host input's Trace line. */
const settleLine = (id: string, settlement: Settlement) =>
  recordLine(
    'settle',
    [id],
    [
      [
        'how',
        'answer' in settlement
          ? 'answer'
          : 'fail' in settlement
            ? 'fail'
            : 'reissue' in settlement
              ? 'reissue'
              : 'adopt',
      ],
      ['value', 'answer' in settlement ? traceValue(settlement.answer) : null],
      [
        'error',
        'fail' in settlement ? traceValue(failMap(settlement.fail)) : null,
      ],
    ],
    true,
  );

/** A Script's or Run's limits, in `limits.toml` order. */
const limitsOf = (values: readonly number[]): Limits => {
  if (values.length !== limitNames.length) {
    invalidSave();
  }
  return Object.fromEntries(
    limitNames.map((name, i) => [name, values[i]!]),
  ) as Limits;
};

/**
 * A Run a restore only discards: its costs, its Delivery and what it waits
 * on, so its calls are abandoned, without its code positions.
 */
/** Runs a restore built only to discard. */
const skimmed = new WeakSet<Running>();

const skimRun = (
  rec: RunRecord<Value>,
  s: ScriptState,
  delivery: Delivery,
  callId: (i: number) => string,
): Running => {
  const run = new Run(
    s.loaded,
    s.loaded.unit.bodies[0]!,
    [],
    limitsOf(rec.limits),
  );
  const r = runInternals(run);
  run.id = rec.id;
  r.frames = [];
  r.fuel = rec.fuel;
  r.alloc = rec.alloc;
  r.calls = rec.calls;
  r.segmentBase = [...(rec.segmentBase ?? s.loaded.variables)];
  r.cancellationAbandons = [...rec.abandoned];
  const w = rec.waiting;
  if (w?.call !== undefined) {
    r.suspended = {
      k: 'ask',
      call: {
        id: callId(w.call),
        opName: `${w.grant}.${w.operation}`,
      } as CallContext,
      abort: new AbortController(),
      ms: 0,
    };
  } else if (w?.id) {
    r.suspended = { k: 'send', id: w.id, to: '', message: '', args: [] };
  } else if (w) {
    r.suspended = { k: 'wait', us: 0n };
  }
  if (rec.join) {
    const members = rec.join.members.map((m): Member => ({
      id: m.waited.id,
      call: null,
      abort: m.waited.call === undefined ? null : new AbortController(),
      ms: 0,
      at: 0n,
      site: { frame: undefined as unknown as Frame, pc: m.start },
      ...(m.with.k === 'answer' || m.with.k === 'reply'
        ? { answer: m.with.value }
        : {}),
    }));
    r.join = {
      frame: undefined as unknown as Frame,
      members,
      start: rec.join.start,
    };
    if (!w && rec.suspendedAt === 'join-end' && !rec.continuing) {
      r.suspended = { k: 'join', members };
    }
  }
  return {
    id: rec.id,
    delivery,
    run,
    resuming: rec.resumeWith.k !== 'none',
    ...(rec.parked ? { parked: true } : {}),
  };
};

/** The calls and replies a saved Run waits on, as a variables-only restore abandons them. */
const awaitedCallIds = (
  rec: RunRecord<Value>,
  calls: readonly { id: string }[],
): string[] => {
  const ids: string[] = [];
  const w = rec.waiting;
  if (w) {
    if (w.call !== undefined) {
      ids.push(calls[w.call]!.id);
    } else if (w.id) {
      ids.push(w.id);
    }
  }
  if (rec.join && rec.suspendedAt === 'join-end' && !rec.continuing) {
    for (const m of rec.join.members) {
      if (m.pending) {
        ids.push(m.waited.id);
      }
    }
  }
  return ids;
};

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
    case 'dropped':
      return 'dropped';
    case 'cancelled':
      return 'cancel';
    case 'effect failed':
      return 'effect-failed';
  }
};

const compareCallIds = (a: string, b: string) => {
  const left = /^(.*)\/r(\d+)\.c(\d+)$/.exec(a);
  const right = /^(.*)\/r(\d+)\.c(\d+)$/.exec(b);
  if (!left || !right) {
    return compareNames(a, b);
  }
  return (
    compareNames(left[1]!, right[1]!) ||
    Number(left[2]) - Number(right[2]) ||
    Number(left[3]) - Number(right[3])
  );
};
const byName = (a: { name: string }, b: { name: string }) =>
  compareNames(a.name, b.name);
const hexBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g)!, byte => Number.parseInt(byte, 16));
const validOverride = (name: string, value: unknown, cap: number): boolean =>
  overridable.has(name) &&
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= cap;

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

export const newGroup = (o: TsGroupOptions): TsGroup => new TsGroup(o);

export const restore = (bytes: Uint8Array, options: TsRestoreOptions) =>
  TsGroup.restore(bytes, options);
