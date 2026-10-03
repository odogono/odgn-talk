import {
  DebugController,
  machineDebug,
  statementStarts,
  type DebugPause,
  type DebugSnapshot,
  type DebugSource,
} from './debug';
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
  type CodePosition,
  type LimitName,
  type Limits,
  type Outcome,
  type Member,
  type Resumption,
  type RunRecord,
  Run,
  type RunHost,
  type Suspension,
  type Script as Loaded,
} from './machine';
import { type Grant, type Call, type Operation } from './capabilities';
import { languageVersion, costModel } from './generated/machine';
import { canonicalJSON, grantData } from './manifest';
import {
  references,
  reference,
  saveGraph,
  restoreGraph,
  saveFormatVersion,
  type Graph,
  type References,
} from './snapshot';
import {
  makeObject,
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
  functionsBelongTo,
  displayText,
  listValues,
  map,
  nothing,
  text,
  Value,
} from './values';
import { compareText } from './text';
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
export const observeRuns = Symbol('observeRuns');
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
export type RestoreOptions = GroupOptions & {
  grants(script: string, name: string): Grant<unknown> | undefined;
  libraries: readonly Library[];
  onMismatch: 'reject' | 'variables only';
  resolve(kind: string, id: string): { native: unknown } | undefined;
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
      fn?: Value;
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
  state: 'idle' | 'sliced' | 'stopped';
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

type Decision = {
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
type Running = {
  cleanupReady?: boolean;
  delivery: Delivery;
  id: string;
  parked?: boolean;
  /** Ready to resume from a Suspension Point, not a preemption. */
  resuming: boolean;
  run: Run;
  selected?: boolean;
};
// A timer (chapter 5, A Pump): fired in deadline order, then set order.
type TimerAction =
  | { k: 'wake'; running: Running; s: ScriptState }
  | {
      branch: number;
      k: 'event';
      s: ScriptState;
      waiter: ScriptState['waiters'][number];
    }
  | { abort?: AbortController; id: string; k: 'call'; ms: number };
type Timer = {
  action: TimerAction;
  deadline: bigint;
  live: boolean;
  running?: Running;
  seq: number;
};
// A suspended Run waiting on a call: an Operation's answer, or a reply.
type Pending = {
  /** For a Join Member, its Join's members and the answers in so far. */
  join?: { answers: Map<string, Resumption>; members: Member[] };
  running: Running;
  s: ScriptState;
  timer: Timer;
};
type SourceUnit = {
  identity: string;
  imports: readonly Library[];
  source: string;
  tree: SemanticTree;
};
type ScriptState = {
  /** Work charged to Runs that have ended or been discarded. */
  allocTotal: number;
  debt: number;
  disabled: Set<string>;
  faults: number;
  fuelTotal: number;
  grants: ReadonlyMap<string, Grant<unknown>>;
  handle: Script;
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
  /** Its pending `wait for`s, in the order the waits began. */
  waiters: { running: Running; timers: Timer[] }[];
};
type InputAction =
  | { id: string; k: 'cancel-delivery' }
  | { id: string; k: 'cancel-run'; name: string }
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
  | { id: string; k: 'settle'; settlement: Settlement };
type QueuedInput = {
  action: InputAction;
  line: string | (() => string);
  urgent?: boolean;
};

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

/** A handle for calls addressed to one Script. */
export class Script {
  constructor(
    private readonly group: Group,
    readonly name: string,
  ) {}
  /** Worker. A snapshot of kept Operations, including revoked Grants. */
  grants(): Record<string, string[]> {
    return this.group.scriptGrants(this.name);
  }
  /** Worker. Lifetime totals and current state, without draining inputs. */
  counters(): Counters {
    return this.group.scriptCounters(this.name);
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
  reload(source: string, carry: CarryOver): Report[] {
    return this.group.reload(this.name, source, carry);
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
  /** Queued. In-flight calls are left to the Host. */
  revoke(grantName: string): void {
    this.group.queueRevoke(this.name, grantName);
  }
}

export class Group {
  readonly name: string;
  private readonly trace: (line: string) => void;
  private readonly onReady: (() => void) | undefined;
  private readonly scripts: ScriptState[] = [];
  private readonly libraries = new Map<string, Library>();
  private readonly pending = new Map<string, Pending>();
  private readonly functionGroup = {};
  private readonly objects = new Map<string, ObjectState>();
  // The reports of the Pump draining the input queue.
  private drainReports: Report[] = [];
  private timers: Timer[] = [];
  private timerSeq = 0;
  private inputs: QueuedInput[] = [];
  private deliveries = 0;
  private broadcasts = 0;
  private saves = 0;
  private lastClock: bigint | null = null;
  private pumping = false;
  private cleaning = false;
  private effectStateUnknown = false;
  private terminalReports: (() => void)[] | null = null;
  private active: { records: number; running: Running; s: ScriptState } | null =
    null;
  private activeStop: (() => void) | null = null;
  private drainingTrace: string[] | null = null;
  private debugController: DebugController | null = null;
  private debugPump: Generator<DebugPause, PumpResult> | null = null;

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
    ));
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

  private observer: ((r: RunEvent) => void) | null = null;

  /** TS-internal: receives the records a Session Host follows (ADR 0045). */
  [observeRuns](observer: ((r: RunEvent) => void) | null): void {
    this.observer = observer;
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

  private snapshotReferences(): References {
    const refs = references();
    reference(refs, 'function-group', this.functionGroup);
    const code = (key: string, unit: Code) => {
      if (refs.byObject.has(unit)) {
        return;
      }
      reference(refs, key, unit);
      unit.unit.bodies.forEach((body, i) =>
        reference(refs, `${key}/body/${i}`, body),
      );
      unit.unit.unwind.forEach((entry, i) =>
        reference(refs, `${key}/unwind/${i}`, entry),
      );
      for (const [name, imported] of unit.libraries) {
        code(`library/${name}`, imported);
      }
    };
    for (const s of this.scripts) {
      reference(refs, `script/${s.name}`, s);
      s.loaded.units.forEach((unit, i) => code(`code/${s.name}/${i}`, unit));
      for (const [name, grant] of s.grants) {
        for (const op of grant.ops) {
          reference(
            refs,
            `operation/${s.name}/${name}/${op}`,
            grant.capability.operations.get(op)!,
          );
        }
      }
    }
    for (const [key, object] of this.objects) {
      reference(refs, `object/${key}`, object);
    }
    return refs;
  }

  /** Worker. Host callbacks, bindings and native objects aren't in the bytes. */
  save(): Uint8Array {
    this.worker();
    const id = `s${++this.saves}`;
    if (
      this.effectStateUnknown ||
      this.scripts.some(s =>
        this.runsOf(s).some(r => r.run.hasOpenScopes || r.run.hasParticipant),
      )
    ) {
      this.trace(recordLine('save', [id], [], true));
      this.trace(
        recordLine(
          'refused',
          [],
          [['code', JSON.stringify('effects pending')]],
        ),
      );
      throw new HostError('effects pending');
    }
    const state = {
      scripts: this.scripts.map(s => ({
        name: s.name,
        variables: s.loaded.variables,
        variableNames: s.loaded.variableNames,
        definitions: s.loaded.units.map(unit => unit.definitions),
        live: s.loaded.live,
        debt: s.debt,
        incoming: s.incoming,
        parked: s.parked,
        queue: s.queue,
        runs: s.runs,
        fuelTotal: s.fuelTotal,
        allocTotal: s.allocTotal,
        faults: s.faults,
        stopped: s.stopped,
        stopReason: s.stopReason,
        suspended: s.suspended,
        waiters: s.waiters,
        revoked: s.revoked,
        disabled: s.disabled,
      })),
      inputs: this.inputs.map(input => ({
        action: input.action,
        urgent: input.urgent,
        line: typeof input.line === 'string' ? input.line : undefined,
      })),
      timers: this.timers.filter(t => t.live),
      pending: this.pending,
      deliveries: this.deliveries,
      broadcasts: this.broadcasts,
      timerSeq: this.timerSeq,
      lastClock: this.lastClock,
      discardedDecisions: this.discardedDecisions,
    };
    const saved: SavedGroup = {
      family: 'odgn-talk-ts',
      format: saveFormatVersion,
      language: languageVersion,
      costModel: costModel.version,
      fingerprint: hexOf(this.fingerprint()),
      name: this.name,
      id,
      libraries: [...this.libraries.values()].map(l => [l.name, identityOf(l)]),
      objects: [...this.objects].map(([key, o]) => ({
        key,
        kind: o.handle.kind.name,
        id: o.handle.id,
        disposed: o.disposed,
        owner: o.owner,
        parent: o.parent
          ? `${o.parent.handle.kind.name}\u0000${o.parent.handle.id}`
          : null,
      })),
      scripts: this.scripts.map(s => ({
        name: s.name,
        sources: s.units.map(unit => unit.source),
        limits: s.limits,
        grants: [...s.grants].map(([name, grant]) => ({
          name,
          capability: grant.capability.name,
          operations: [...grant.ops].map(name => ({
            name,
            declaration: savedOperation(grant.capability.operations.get(name)!),
          })),
        })),
        objects: Object.entries(s.objects).map(([name, o]) => [
          name,
          `${o.kind.name}\u0000${o.id}`,
        ]),
        owner: s.owner
          ? `${s.owner.handle.kind.name}\u0000${s.owner.handle.id}`
          : null,
      })),
      graph: saveGraph(state, this.snapshotReferences()),
    };
    const payload = JSON.stringify(saved);
    this.trace(recordLine('save', [id], [], true));
    return new TextEncoder().encode(
      JSON.stringify({ hash: sha256(payload), payload }),
    );
  }

  /** Build and check the complete replacement before publishing the Group. */
  static restore(
    bytes: Uint8Array,
    o: RestoreOptions,
  ): { group: Group; result: RestoreResult } {
    const saved = readSave(bytes);
    let emitting = false;
    const group = new Group({
      name: o.name,
      onReady: o.onReady,
      trace: line => {
        if (emitting) {
          o.trace?.(line);
        }
      },
    });
    const disposed: [string, string][] = [];
    const unbound: string[] = [];
    for (const object of saved.objects) {
      const kind = objectKind(object.kind);
      if (!kind) {
        throw new HostError(
          'save mismatch',
          `Unknown Object Kind ${object.kind}`,
        );
      }
      const state = makeObject(kind, object.id, undefined);
      state.disposed = object.disposed;
      group.objects.set(object.key, state);
    }
    for (const object of saved.objects) {
      group.objects.get(object.key)!.parent = object.parent
        ? group.objects.get(object.parent)!
        : null;
    }
    for (const library of o.libraries) {
      group.libraries.set(library.name, library);
    }
    let mismatch =
      saved.format !== saveFormatVersion ||
      saved.language !== languageVersion ||
      saved.costModel !== costModel.version ||
      saved.libraries.some(
        ([name, identity]) =>
          !group.libraries.has(name) ||
          identityOf(group.libraries.get(name)!) !== identity,
      );
    let loadFailure: LoadError | undefined;
    for (const script of saved.scripts) {
      const grants: Record<string, Grant<unknown>> = Object.create(null);
      const revoked = new Set<string>();
      for (const grant of script.grants) {
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
            operations: new Map(
              grant.operations.map(op => [op.name, op.declaration]),
            ),
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
        } else if (
          canonicalJSON(grantData(rebound)) !==
          canonicalJSON(grantData(placeholder))
        ) {
          mismatch = true;
        }
        grants[grant.name] = rebound ?? placeholder;
      }
      if (loadFailure) {
        continue;
      }
      try {
        group.load({
          name: script.name,
          source: script.sources[0]!,
          limits: script.limits,
          grants,
          owner: script.owner
            ? group.objects.get(script.owner)!.handle
            : undefined,
          objects: Object.fromEntries(
            script.objects.map(([name, key]) => [
              name,
              group.objects.get(key)!.handle,
            ]),
          ),
        });
        const state = group.scripts.at(-1)!;
        for (const source of script.sources.slice(1)) {
          group.applyExtension(state, source, undefined, false);
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
    for (const object of saved.objects) {
      group.objects.get(object.key)!.owner = object.owner;
    }
    mismatch ||= hexOf(group.fingerprint()) !== saved.fingerprint;
    const restoreLine = (result?: RestoreResult) =>
      recordLine(
        'restore',
        [],
        [
          ['from', saved.id],
          [
            'mismatch',
            o.onMismatch === 'variables only' ? 'variables-only' : null,
          ],
          ['unbound', unbound.length ? idList(unbound) : null],
          [
            'withheld',
            saved.libraries.filter(([name]) => !group.libraries.has(name))
              .length
              ? idList(
                  saved.libraries
                    .filter(([name]) => !group.libraries.has(name))
                    .map(([name]) => name),
                )
              : null,
          ],
          ['fingerprint', saved.fingerprint],
          [
            'mode',
            result ? (result.variablesOnly ? 'variables-only' : 'full') : null,
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
    for (const object of saved.objects) {
      const resolved = o.resolve(object.kind, object.id);
      const state = group.objects.get(object.key)!;
      rebindObject(state, resolved?.native);
      state.disposed = object.disposed || !resolved;
      if (!resolved) {
        disposed.push([object.kind, object.id]);
      }
    }
    for (const [i, script] of saved.scripts.entries()) {
      group.scripts[i]!.objects = Object.fromEntries(
        script.objects.map(([name, key]) => [
          name,
          group.objects.get(key)!.handle,
        ]),
      );
    }
    const state = restoreGraph(
      saved.graph,
      group.snapshotReferences(),
      mismatch,
    ) as SavedState;
    const result: RestoreResult = {
      variablesOnly: mismatch,
      pending: [],
      disposed,
      discardedRuns: [],
      droppedMessages: [],
      abandonedCalls: [],
    };
    group.discardedDecisions = state.discardedDecisions;
    group.deliveries = state.deliveries;
    group.broadcasts = state.broadcasts;
    group.lastClock = state.lastClock;
    group.timerSeq = state.timerSeq;
    group.saves = Number(saved.id.slice(1));
    for (const [i, runtime] of state.scripts.entries()) {
      const script = group.scripts[i]!;
      script.runs = runtime.runs;
      script.fuelTotal = runtime.fuelTotal;
      script.allocTotal = runtime.allocTotal;
      script.faults = runtime.faults;
      script.disabled = new Set(runtime.disabled ?? []);
      for (const name of runtime.revoked) {
        script.revoked.add(name);
      }
      script.loaded.variables = script.loaded.variableNames.map((name, j) => {
        const old = runtime.variableNames.indexOf(name);
        return old >= 0 ? runtime.variables[old]! : script.loaded.variables[j]!;
      });
      if (mismatch) {
        result.discardedRuns.push(...savedRuns(runtime).map(r => r.id));
        result.droppedMessages.push(
          ...runtime.queue
            .filter((q): q is Delivery => !('run' in q))
            .flatMap(d => (d.id ? [d.id] : [])),
        );
        for (const running of savedRuns(runtime)) {
          group.accumulateRunCosts(script, running.run);
          group.discardDecision(running.delivery, script.name, running.id);
        }
        for (const item of runtime.queue) {
          if (!('run' in item)) {
            group.discardDecision(item, script.name);
          }
        }
        script.stopped = false;
        if (script.loaded.variablesSize() > script.limits.persistentState) {
          throw new HostError('state too large');
        }
      } else {
        Object.assign(script, {
          debt: runtime.debt,
          incoming: runtime.incoming,
          parked: runtime.parked,
          queue: runtime.queue,
          stopped: runtime.stopped,
          stopReason: runtime.stopReason,
          suspended: runtime.suspended,
          waiters: runtime.waiters,
        });
        script.loaded.live = runtime.live;
        runtime.definitions.forEach((values, j) => {
          script.loaded.units[j]!.definitions.splice(
            0,
            values.length,
            ...values,
          );
        });
        for (const running of group.runsOf(script)) {
          running.run.host = group.hostFor(script, running.run);
          running.run.rebindCalls();
          running.run.persistentState = () => group.persistentState(script, 1);
        }
      }
    }
    if (mismatch) {
      result.abandonedCalls = [...state.pending.keys()].sort(compareCallIds);
      for (const input of state.inputs) {
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
          group.discardDecision(delivery, name);
        } else if (input.action.k === 'broadcast' && input.action.decision) {
          input.action.decision.discarded = true;
          group.discardedDecisions.push(input.action.decision);
        }
      }
    } else {
      for (const [id, pending] of state.pending) {
        group.pending.set(id, pending);
      }
      group.timers = state.timers;
      group.inputs = state.inputs.map(input => ({
        ...input,
        line:
          input.line ??
          (() =>
            group.broadcastLine(
              input.action as Extract<InputAction, { k: 'broadcast' }>,
            )),
      }));
      result.pending = group.pendingOperations();
      const settled = new Set(
        state.inputs.flatMap(input =>
          input.action.k === 'settle' ? [input.action.id] : [],
        ),
      );
      group.unsettled = new Set(
        result.pending.map(p => p.id).filter(id => !settled.has(id)),
      );
      group.restored = true;
    }
    emitting = true;
    o.trace?.(restoreLine(result));
    return { group, result };
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
    const line = recordLine(
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
        [
          'value',
          'answer' in settlement ? traceValue(settlement.answer) : null,
        ],
        [
          'error',
          'fail' in settlement ? traceValue(failMap(settlement.fail)) : null,
        ],
      ],
      true,
    );
    const pending = this.pending.get(id);
    if (!this.restored || !this.unsettled.has(id) || !pending) {
      this.trace(line);
      this.trace(recordLine('refused', [], [['code', '"unknown call"']]));
      throw new HostError('unknown call');
    }
    const operation = this.pendingOperations().find(p => p.id === id)!;
    if ('adopt' in settlement && !pending.running.run.callAdoptable(id)) {
      this.trace(line);
      this.trace(recordLine('refused', [], [['code', '"not adoptable"']]));
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
    const pending = this.pending.get(id);
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
    if (failure) {
      this.settleReply(id, failure);
    }
  }

  private pendingOperations(): PendingCall[] {
    return [...this.pending]
      .sort(([a], [b]) => compareCallIds(a, b))
      .flatMap(([id, pending]) => {
        const suspension = pending.running.run.suspended;
        const context =
          suspension?.k === 'ask'
            ? suspension.call
            : suspension?.k === 'join'
              ? suspension.members.find(m => m.id === id)?.call
              : null;
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
  watchCancellation(delivery: Delivery, signal?: AbortSignal) {
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

  /** Replay hook for the Host Input produced by aborting a Request or Decision. */
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
          this.trace(
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
            ...(d.fn ? { fn: d.fn } : {}),
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

  queueCancelRun(name: string, id: string): void {
    this.queueInput({
      urgent: true,
      line: recordLine('cancel-run', [id], [], true),
      action: { k: 'cancel-run', name, id },
    });
  }

  queueStop(name: string, reason: string): void {
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

  queueRevoke(name: string, grant: string): void {
    this.queueInput({
      line: recordLine('revoke', [name], [['grant', grant]], true),
      action: { k: 'revoke', name, grant },
    });
  }

  private applyInput(action: InputAction) {
    switch (action.k) {
      case 'revoke': {
        const s = this.scripts.find(s => s.name === action.name)!;
        if (s.grants.has(action.grant)) {
          s.revoked.add(action.grant);
        }
        break;
      }
      case 'settle':
        this.applySettlement(action.id, action.settlement);
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
          this.trace(
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
      case 'set-parent':
        action.child.parent = action.up;
        break;
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
    for (const waiter of s.waiters.filter(w => w.running === running)) {
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

  private stopState(s: ScriptState, reason: string) {
    if (s.stopped) {
      return;
    }
    s.stopped = true;
    s.loaded.live = false;
    s.stopReason = reason;
    const runs = this.runsOf(s);
    const messages = s.queue.filter((q): q is Delivery => !('run' in q));
    const pendingCalls: string[] = [];
    for (const r of runs) {
      this.accumulateRunCosts(s, r.run);
      pendingCalls.push(
        ...r.run.discard(r.parked || r.resuming || r.cleanupReady),
      );
      this.finalizeEffects(r, true);
      this.forgetWait(s, r);
    }
    s.queue = [];
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
      this.reportStop(s, reason, runs, messages, pendingCalls);
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

  private reportStop(
    s: ScriptState,
    reason: string,
    runs: Running[],
    messages: Delivery[],
    pendingCalls: string[],
  ) {
    this.trace(
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

  private dropStoppedMailbox(s: ScriptState) {
    const messages = s.queue.filter((q): q is Delivery => !('run' in q));
    s.queue = [];
    if (messages.length) {
      this.reportStop(s, s.stopReason!, [], messages, []);
    }
  }

  private acceptDelivery(s: ScriptState, delivery: Delivery) {
    s.queue.push(delivery);
    if (s.stopped) {
      this.dropStoppedMailbox(s);
    }
  }

  private landUrgentInputs() {
    while (this.inputs.some(i => i.urgent)) {
      const urgent = this.inputs.filter(i => i.urgent);
      this.inputs = this.inputs.filter(i => !i.urgent);
      for (const input of urgent) {
        this.trace(typeof input.line === 'string' ? input.line : input.line());
        this.applyInput(input.action);
      }
    }
  }

  constructor(options: GroupOptions) {
    this.name = options.name;
    this.onReady = options.onReady;
    this.trace = line => {
      if (this.drainingTrace) {
        this.drainingTrace.push(line);
      } else {
        options.trace?.(line);
      }
    };
  }

  script(name: string): Script | undefined {
    return this.scripts.find(s => s.name === name)?.handle;
  }

  // Notify once per accepted Host Input, including urgent inputs drained in this Pump.
  private queueInput(input: QueuedInput): void {
    const landing = this.debugController?.current;
    if (
      landing?.reason === 'replay' &&
      (input.action.k === 'stop' || input.action.k === 'cancel-run') &&
      typeof input.line === 'string'
    ) {
      input.line += ` pc=${landing.pc}`;
    }
    this.inputs.push(input);
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
    if (this.pumping || this.cleaning) {
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

  scriptCounters(name: string): Counters {
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
    this.trace(recordLine('counters', [name], [], true));
    this.trace(
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

  scriptGrants(name: string): Record<string, string[]> {
    this.worker();
    return Object.fromEntries(
      [...this.scripts.find(s => s.name === name)!.grants]
        .sort(([a], [b]) => compareText(a, b))
        .map(([name, grant]) => [name, [...grant.ops].sort(compareText)]),
    );
  }

  /** Worker. Compiles, checks and loads a Script, or throws LoadError. */
  load(o: LoadOptions): Script {
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
    );
    this.trace(recordLine('load', [o.name], [['identity', p.identity]], true));
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
    const handle = new Script(this, o.name);
    if (owner) {
      owner.owner = o.name;
    }
    this.scripts.push({
      name: o.name,
      waiters: [],
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
  ): Loaded {
    try {
      if (p.diagnostics) {
        throw new LoadError(p.diagnostics);
      }
      // An extension's lowering also depends on all earlier definitions and
      // variable slots, so cache it under the complete extended Script identity.
      const identity = existing?.identity ?? p.identity;
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
      this.writeDiagnostics(error);
      throw error;
    }
  }

  private writeDiagnostics(error: unknown) {
    if (error instanceof LoadError) {
      for (const d of error.diagnostics) {
        this.trace(
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
      waiters: [],
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
      this.trace(
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
  reload(name: string, source: string, carry: CarryOver): Report[] {
    this.worker();
    this.requireKnownEffects();
    const s = this.scripts.find(s => s.name === name)!;
    const p = prepare('script', name, source, this.libraries);
    this.trace(
      recordLine(
        'reload',
        [name],
        [
          ['carry', carry === 'carry variables' ? 'yes' : 'no'],
          ['source', displayText(source)],
          ['identity', p.identity],
        ],
        true,
      ),
    );
    const replacement = this.replacement(s, source, carry);
    return this.replaceScripts([{ s, ...replacement }]);
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
      const key = `@${code.name}`;
      links.set(key, code);
      for (const [library, linked] of code.libraries) {
        links.set(library, linked);
      }
      for (const binding of unit.tree.scopes[0]!.bindings) {
        if (binding.span === null) {
          continue;
        }
        existing[binding.name] = {
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
        this.trace(
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
      this.trace(
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
    this.trace(
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
  ): Report[] {
    const previous = this.drainReports;
    const reports: Report[] = [];
    this.drainReports = reports;
    try {
      for (const { s } of replacements) {
        this.stopState(s, 'reload');
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

  /** Worker. Prepare every dependent before changing the Group. */
  replaceLibrary(l: Library, carry: CarryOver): Report[] {
    this.worker();
    this.requireKnownEffects();
    this.trace(
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
      this.trace(recordLine('refused', [], [['code', JSON.stringify(code)]]));
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
    const reports = this.replaceScripts(replacements);
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
  private hostFor(s: ScriptState, run: Run): RunHost {
    const group = this;
    return {
      crossing: () => {
        const active = this.active!;
        this.writeRecords(active.running, active.records);
        active.records = run.records.length;
        const cancelling = run.cancelling;
        this.landUrgentInputs();
        return s.stopped || (!cancelling && run.cancelling);
      },
      group,
      disableGrant: name => s.disabled.add(name),
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
    receiver.queue.push(delivery);
  }

  private timer(
    deadline: bigint,
    action: TimerAction,
    running?: Running,
  ): Timer {
    const t = { deadline, action, live: true, seq: this.timerSeq++, running };
    this.timers.push(t);
    return t;
  }

  private fireTimer(timer: Timer) {
    const action = timer.action;
    switch (action.k) {
      case 'wake':
        this.ready(action.s, action.running, { k: 'wake' });
        break;
      case 'event':
        this.endWaiter(action.s, action.waiter);
        this.ready(action.s, action.waiter.running, {
          k: 'event-timeout',
          branch: action.branch,
        });
        break;
      case 'call':
        action.abort?.abort();
        this.settleReply(action.id, { k: 'timeout', after: action.ms });
        break;
    }
  }

  // A suspended Run made ready: it joins the back of its Script's queue.
  private ready(s: ScriptState, running: Running, r: Resumption) {
    s.suspended.delete(running);
    running.run.wake(r);
    running.resuming = true;
    s.queue.push(running);
  }

  // A call's answer or failure, or a reply; one no longer pending is noted.
  private settleReply(id: string, r: Resumption) {
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
    let fuel = 0;
    for (const waiter of s.waiters) {
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
        this.endWaiter(s, waiter);
        this.seal(delivery, { verdict: 'allowed' });
        this.ready(s, waiter.running, fired);
      }
    }
    return fuel;
  }

  // A Run that suspended: wait on its timer, its answer or its reply.
  private suspended(s: ScriptState, running: Running, sus: Suspension) {
    s.suspended.add(running);
    const now = this.lastClock!;
    if (sus.k === 'wait') {
      return this.timer(now + sus.ns, { k: 'wake', s, running }, running)
        .deadline;
    }
    if (sus.k === 'wait-for') {
      // A timeout, and each `after` branch, is a timer; the first to fire
      // ends the wait, as a matching message does.
      const waiter = { running, timers: [] as Timer[] };
      const fire = (branch: number): TimerAction => ({
        k: 'event',
        s,
        waiter,
        branch,
      });
      if (sus.timeout !== null) {
        waiter.timers.push(this.timer(now + sus.timeout, fire(0), running));
      }
      for (const after of sus.afters) {
        waiter.timers.push(
          this.timer(now + after.ns, fire(after.branch), running),
        );
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
        const timer = this.timer(
          now + BigInt(m.ms) * 1_000_000n,
          { k: 'call', id: m.id, ms: m.ms },
          running,
        );
        this.pending.set(m.id, { s, running, timer, join });
      }
      return null;
    }
    const id = sus.k === 'ask' ? sus.call.id : sus.id;
    const ms = sus.k === 'ask' ? sus.ms : running.run.limits.maxWaitMs;
    const timer = this.timer(
      now + BigInt(ms) * 1_000_000n,
      { k: 'call', id, ms, ...(sus.k === 'ask' ? { abort: sus.abort } : {}) },
      running,
    );
    this.pending.set(id, { s, running, timer });
    return null;
  }

  private checkFunctionGroups(values: readonly Value[], line?: string) {
    if (!functionsBelongTo(values, this.functionGroup)) {
      if (line) {
        this.trace(line);
        this.trace(recordLine('refused', [], [['code', '"wrong group"']]));
      }
      throw new HostError('wrong group');
    }
  }

  /** A queued Delivery: its id now, its line and its mailbox entry at the next Pump. */
  queueDelivery(
    record: 'deliver' | 'request' | 'decide' | 'call-value',
    to: string | ObjectState,
    m: Message,
    request: Delivery['request'],
    ballot?: Ballot,
    fn?: Value,
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
      this.trace(this.deliveryLine(record, null, toText, m, fn));
      this.trace(recordLine('refused', [], [['code', JSON.stringify(code)]]));
      throw error;
    };
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
    this.queueInput({
      line: this.deliveryLine(record, delivery.id, toText, m, fn),
      action: { k: 'delivery', to, state: state ?? null, delivery },
    });
    return delivery;
  }

  /** Queued. Asks the object's Message Path for a Verdict. */
  decide(to: HostObject, m: Message, o?: CancellationOptions): Deciding {
    return this.queueDecision(this.held(to), m, o);
  }

  queueDecision(
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
    this.checkFunctionGroups(
      m.args ?? [],
      recordLine(record, [], messageFields(m), true),
    );
    for (const [name, value] of Object.entries(m.limits ?? {})) {
      if (!validOverride(name, value, defaultLimits[name as LimitName])) {
        this.trace(recordLine(record, [], messageFields(m), true));
        this.trace(recordLine('refused', [], [['code', '"invalid value"']]));
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
    action.recipients = this.scripts
      .filter(
        s =>
          !s.stopped &&
          (s.loaded.clauses.has(m.name) ||
            s.waiters.some(
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
        return {
          s,
          delivery: {
            ballot,
            broadcast: id,
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

  /** Queued. Calls a Function Value as a Request to its Home Script. */
  call(
    fn: Value,
    args: Value[],
    o?: CancellationOptions & { limits?: LimitOverride },
  ): Requested {
    const ref = fn.asFunction();
    if (!ref || ref.group !== this.functionGroup) {
      const code = ref ? 'wrong group' : 'invalid value';
      this.trace(
        recordLine(
          'call-value',
          [],
          [
            ['fn', traceValue(fn)],
            ['args', traceValue(listValues(args))],
          ],
          true,
        ),
      );
      this.trace(recordLine('refused', [], [['code', JSON.stringify(code)]]));
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

  /** TS helper for reaching a handle that was reconstructed by Restore. */
  objectById(kind: string, id: string): HostObject | undefined {
    return this.objects.get(`${kind}\u0000${id}`)?.handle;
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
        ['parent', up ? traceValue(up.handle.value) : 'nothing'],
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
    this.observer?.({
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
        const reason =
          outcome.kind === 'limit fault' ? 'limit fault' : outcome.kind;
        delivery.request.reject(
          new ScriptError(
            'send failed',
            `No answer came: the receiver's Run ended ${reason}`,
            map([['reason', text(reason)]]),
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
    if (this.lastClock !== null && now < this.lastClock) {
      this.trace(
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
      this.trace(recordLine('refused', [], [['code', '"clock backwards"']]));
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
        inputLines.push(
          typeof input.line === 'string' ? input.line : input.line(),
        );
        this.applyInput(input.action);
      }
    } finally {
      this.drainingTrace = null;
    }
    for (const line of inputLines) {
      this.trace(line);
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
    for (const line of outputLines) {
      this.trace(line);
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
        this.fireTimer(t);
      }
    }
    this.timers = this.timers.filter(t => t.live);
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
    let progress = true;
    while (progress && !capped()) {
      progress = false;
      for (const s of this.scripts) {
        if (!s.queue.length || sliced(s) || capped()) {
          continue;
        }
        progress = true;
        yield* this.turn(
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
    this.landUrgentInputs();
    for (const s of this.scripts) {
      if (s.stopped) {
        this.dropStoppedMailbox(s);
      }
    }
    const state =
      this.scripts.length && this.scripts.every(s => s.stopped)
        ? 'stopped'
        : this.scripts.some(s => s.queue.length)
          ? 'sliced'
          : 'idle';
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
        : dispatch(s.loaded, delivery.message, delivery.args, limits);
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
        r =>
          r !== running &&
          r.selected &&
          r.delivery.message === running.delivery.message &&
          r.run.clauseNumber === run.clauseNumber,
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
    while (!run.done && !run.suspended && !running.parked && !s.stopped) {
      // Selection/parking can fault without stepping an instruction. Finish
      // that deferred fault before a cap or slice may end this stretch.
      by = machineDebug.get(run)?.pending ? null : preempt();
      if (by) {
        break;
      }
      const pause = this.debugController?.boundary(run, s.name);
      if (pause) {
        yield pause;
        this.landUrgentInputs();
        if (run.done || run.suspended || s.stopped) {
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
        if (s.stopped || run.done || run.cancelling !== cancelling) {
          debug.pending = null;
          debug.fault = null;
          break;
        }
        const pending = debug.pending;
        debug.pending = null;
        debug.fault = null;
        pending();
      }
      run.finishInstruction();
      this.writeRecords(running, this.active.records);
      this.active.records = run.records.length;
      if (run.effectStateUnknown) {
        this.stopUnknownEffects();
      }
      selected();
      charge(run.fuel - last);
      last = run.fuel;
    }
    let outcome = run.ended;
    if (outcome?.kind === 'completed' && outcome.veto && !run.openVerdict) {
      this.trace(recordLine('note', [running.id], [['kind', 'no-verdict']]));
    }
    if (outcome) {
      this.debugController?.ended(run);
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
    if (outcome?.kind === 'cancelled' && outcome.cleanupFailed) {
      const failed = outcome.cleanupFailed;
      this.trace(
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
    if ((run.done || run.suspended) && !s.stopped) {
      this.finalizeEffects(running);
    }
    if (run.effectStateUnknown) {
      this.stopUnknownEffects();
    }
    outcome = run.ended;
    this.active = null;
    const handler =
      !running.delivery.fn && s.loaded.clauses.has(running.delivery.message)
        ? running.delivery.message
        : null;
    const observe = (end: string, until?: bigint) =>
      this.observer?.({
        k: 'seg',
        run: running.id,
        how,
        ...(how === 'start' && running.delivery.id
          ? { delivery: running.delivery.id }
          : {}),
        end,
        ...(until === undefined ? {} : { until }),
        calls: end === 'stop' ? [] : (this.waitView(running).calls ?? []),
      });
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
            [
              'fn',
              running.delivery.fn ? traceValue(running.delivery.fn) : null,
            ],
          ]
        : [];
    const stretch: [string, string][] = [
      ['fuel', String(run.fuel - fuel0)],
      ['alloc', String(run.alloc - alloc0)],
    ];
    if (s.stopped) {
      this.trace(
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
      this.trace(
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
      observe(
        run.suspended.k === 'wait-for' && run.suspended.any
          ? 'wait-for-any'
          : suspendReasons[run.suspended.k],
        deadline ?? undefined,
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
      this.writeCancellationAbandons(run);
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
    this.endRun(s, running, outcome, reports, handler);
  }

  private writeCancellationAbandons(run: Run) {
    for (const id of run.cancellationAbandons) {
      this.trace(recordLine('abandon', [id], []));
    }
    run.cancellationAbandons = [];
  }

  // The Host-side report of a `host error`, beside its `call-failed` record.
  private callFailed(
    script: string,
    rec: Extract<RunRecord, { kind: 'call-failed' }>,
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

  private writeRecords(running: Running, records0: number) {
    const { run } = running;
    for (let i = records0; i < run.records.length; i++) {
      const rec = run.records[i]!;
      if (rec.kind === 'scope') {
        this.trace(
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
        this.trace(
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
        this.trace(
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
        continue;
      }
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
              ['message', rec.message ?? null],
              [
                'args',
                rec.args.length ? traceValue(listValues(rec.args)) : null,
              ],
              ['target', rec.target ? traceValue(rec.target) : null],
            ],
          ),
        );
        this.observer?.({
          k: 'unhandled',
          run: running.id,
          message: rec.message ?? '',
          args: rec.args,
        });
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
              ['automatic', rec.automatic ? 'yes' : null],
            ],
          ),
        );
        this.observer?.({ k: 'call', call: rec.id, run: running.id });
        continue;
      }
      if (rec.kind === 'call-failed') {
        this.trace(recordLine('call-failed', [rec.id], [['op', rec.op]]));
        this.observer?.({ k: 'call', call: rec.id, run: running.id });
        this.drainReports.push(this.callFailed(run.script.name, rec));
        continue;
      }
      if (rec.kind === 'send') {
        this.trace(
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
  }

  private endRun(
    s: ScriptState,
    running: Running,
    outcome: Outcome,
    reports: Report[],
    handler: string | null,
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
    this.trace(
      recordLine(
        'run',
        [running.id],
        [
          ['outcome', word],
          ['delivery', delivery.id],
          ['broadcast', delivery.broadcast ?? null],
          ['handler', handler],
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
    this.observer?.({
      k: 'run',
      run: running.id,
      outcome: word,
      ...(delivery.id ? { delivery: delivery.id } : {}),
      ...(error ? { error } : {}),
    });
    reports.push({
      kind: 'run end',
      script: s.name,
      run: running.id,
      ...(delivery.id ? { delivery: delivery.id } : {}),
      ...(delivery.broadcast ? { broadcast: delivery.broadcast } : {}),
      ...(handler ? { handler } : {}),
      ...(delivery.fn ? { fn: delivery.fn } : {}),
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
    this.releaseParked(s, running);
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
            delivery.fn
              ? ['fn', delivery.fn]
              : ['name', text(delivery.message)],
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
        this.unhandled(delivery, reports, running.id);
        return;
      }
      const waiting =
        next.s.queue.filter(item => !('run' in item)).length + next.s.incoming;
      if (waiting >= next.s.limits.mailboxDepth) {
        this.trace(recordLine('note', [running.id], [['kind', 'climb-full']]));
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
    const sameClause = (r: Running) =>
      !r.delivery.fn &&
      !ended.delivery.fn &&
      r.delivery.message === ended.delivery.message &&
      r.run.clauseNumber === ended.run.clauseNumber;
    if (this.runsOf(s).some(r => !r.parked && sameClause(r))) {
      return;
    }
    const next = s.parked.find(sameClause);
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
    const deadlines = this.timers
      .filter(
        t =>
          t.live &&
          t.running === running &&
          (t.action.k === 'wake' || t.action.k === 'event'),
      )
      .map(t => t.deadline);
    const until = deadlines.length
      ? deadlines.reduce((a, b) => (b < a ? b : a))
      : undefined;
    const calls =
      sus.k === 'ask'
        ? [sus.call.id]
        : sus.k === 'send' || sus.k === 'call-value'
          ? [sus.id]
          : sus.k === 'join'
            ? sus.members.map(m => m.id).filter(id => this.pending.has(id))
            : [];
    return {
      wait:
        sus.k === 'wait-for' && sus.any
          ? 'wait-for-any'
          : suspendReasons[sus.k],
      ...(until === undefined ? {} : { until }),
      ...(calls.length ? { calls } : {}),
    };
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
            segment: Number(run.segmentId.split('.s')[1]),
            frames: run.frames.map(frame => {
              const ins = frame.code.unit.code[frame.pc]!;
              return {
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
    this.trace(recordLine('vars', [], [], true));
    const view = this.inspection();
    for (const s of view.scripts) {
      this.trace(
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

type SavedGrant = {
  capability: string;
  name: string;
  operations: { declaration: Operation<unknown>; name: string }[];
};
type SavedGroup = {
  costModel: number;
  family: string;
  fingerprint: string;
  format: number;
  graph: Graph;
  id: string;
  language: string;
  libraries: [string, string][];
  name: string;
  objects: {
    disposed: boolean;
    id: string;
    key: string;
    kind: string;
    owner: string | null;
    parent: string | null;
  }[];
  scripts: {
    grants: SavedGrant[];
    limits: Limits;
    name: string;
    objects: [string, string][];
    owner: string | null;
    sources: string[];
  }[];
};
type SavedScriptState = Pick<
  ScriptState,
  | 'name'
  | 'fuelTotal'
  | 'allocTotal'
  | 'faults'
  | 'debt'
  | 'incoming'
  | 'parked'
  | 'queue'
  | 'runs'
  | 'stopped'
  | 'stopReason'
  | 'suspended'
  | 'waiters'
  | 'revoked'
  | 'disabled'
> & {
  definitions: Value[][];
  live: boolean;
  variableNames: string[];
  variables: Value[];
};
type SavedState = {
  broadcasts: number;
  deliveries: number;
  discardedDecisions: Decision[];
  inputs: { action: InputAction; line?: string; urgent?: boolean }[];
  lastClock: bigint | null;
  pending: Map<string, Pending>;
  scripts: SavedScriptState[];
  timers: Timer[];
  timerSeq: number;
};
const compareNames = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
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
const hexOf = (bytes: Uint8Array) =>
  [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const savedRuns = (s: SavedScriptState) =>
  [
    ...s.queue.filter((q): q is Running => 'run' in q),
    ...s.suspended,
    ...s.parked,
  ].sort((a, b) => Number(a.id.split('/r')[1]) - Number(b.id.split('/r')[1]));
const savedOperation = (op: Operation<unknown>): Operation<unknown> =>
  Object.fromEntries(
    Object.entries(op).filter(
      ([key]) => !['do', 'fire', 'run', 'start'].includes(key),
    ),
  ) as Operation<unknown>;
const readSave = (bytes: Uint8Array): SavedGroup => {
  try {
    const outer = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as { hash: string; payload: string };
    if (
      typeof outer.payload !== 'string' ||
      sha256(outer.payload) !== outer.hash
    ) {
      throw new Error('Corrupt save');
    }
    const saved = JSON.parse(outer.payload) as SavedGroup;
    if (
      saved.family !== 'odgn-talk-ts' ||
      saved.format !== saveFormatVersion ||
      !/^s[1-9]\d*$/.test(saved.id) ||
      !Array.isArray(saved.scripts) ||
      !Array.isArray(saved.objects) ||
      !Array.isArray(saved.libraries) ||
      !Array.isArray(saved.graph.nodes)
    ) {
      throw new Error('Unreadable save');
    }
    return saved;
  } catch {
    throw new HostError('invalid save');
  }
};

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

export const newGroup = (o: GroupOptions): Group => new Group(o);

export const restore = (bytes: Uint8Array, options: RestoreOptions) =>
  Group.restore(bytes, options);
