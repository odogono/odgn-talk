// The NorthTalk TS Core's embedding interface: declarations only, never compiled.
// The package is @odgn/northtalk.
//
// This file mirrors talk.go call for call. The differences are idiom only
// (ADR 0015): exceptions instead of error values, an optional
// Promise-returning `run` beside `start`/`answer`, AbortSignal instead of
// context, bigint epoch nanoseconds instead of time.Time, and maps built from
// Map or record() instead of pairs. None of them can be observed by a Script.
// Chapter 9 of the spec (09-embedding.md) holds the Host error catalogue and
// the Operation naming guide.
//
// Threads: TS has one, but the input-queue rules of talk.go still hold.
// Calls marked "queued" append to the Group's input queue and return at once.
// The next Pump drains the queue in call order, right after it takes its
// Clock reading. stop, cancelRun and rewindRun land at the latest at the running Pump's
// next Host crossing (an Operation or property call) or its end, and may land
// sooner, between instructions. A worker call (load, reload, extend, addLibrary,
// replaceLibrary, pump, save, inspect) made from inside the Group's own Pump,
// from an Operation function say, throws HostError "reentrant call".

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface Diagnostic {
  code: string;    // from the diagnostic catalogue
  message: string; // wording: not covered by parity
  unit: string;    // the Script or Library the diagnostic is in
  line: number;
  col: number;
}

/** Rejects source: a Script, an Entry for extend Script, or a Library. */
export declare class LoadError extends Error {
  readonly diagnostics: Diagnostic[];
}

export type HostErrorCode =
  | "clock backwards" | "parent cycle" | "duplicate object id" | "name reused"
  | "reentrant call" | "wrong group" | "library mismatch"
  | "reserved name" | "not adoptable" | "invalid value"
  | "invalid save" | "save mismatch" | "unknown call" | "state too large"
  | "effects pending" | "effect state unknown";

/** Host misuse, refused at the call that made it (09-embedding.md). */
export declare class HostError extends Error {
  readonly code: HostErrorCode;
}

/** Load shedding, not a bug. Counts the Deliveries already queued to the Script. */
export declare class MailboxFull extends Error {}

/**
 * An ordinary, catchable Error inside the Script (ADR 0017). A catalogue
 * code the Operation doesn't declare, a code outside a declared list, or a
 * data key that clashes with a reserved key (errors.toml), or data that is
 * neither a map nor Nothing, becomes `host error` instead. The Host-side
 * detail goes only in the `call failed` report.
 */
export declare class ScriptError extends Error {
  constructor(code: string, message: string, data?: Value);
  readonly code: string;
  readonly data: Value; // a map, or nothing
}

/** Thrown by call.charge; let it propagate without doing the work. */
export declare class LimitReached extends Error {}

// ---------------------------------------------------------------------------
// Values (ADR 0030)
// ---------------------------------------------------------------------------

/**
 * One immutable Script value or Host Object handle, built only through the
 * constructors below. Input the value model can't hold throws HostError
 * "invalid value". `null` and `undefined` are never accepted.
 */
export declare class Value {
  private readonly brand: "Value";
  readonly kind: Kind;
  asBool(): boolean | undefined;
  asText(): string | undefined; // always NFC
  asDecimal(): Decimal | undefined;
  asQuantity(): { number: Decimal; unit: string } | undefined;
  asCivilDate(): DateFields | undefined;
  asInstant(): bigint | undefined; // epoch nanoseconds
  asBytes(): Uint8Array | undefined; // a copy
  asObject(): HostObject | undefined;
  asRange(): { from: Value; to: Value } | undefined;
  readonly length: number; // list length; 0 for anything else
  index(i: number): Value; // 1-based; nothing past the end
  get(key: string): Value;
  entries(): [string, Value][]; // insertion order
  /** A Text Pattern's canonical source, for display. */
  patternSource(): string | undefined;
  /**
   * A Function Value's Home Script (ADR 0025), its only read. It is bound to
   * its Group, and doesn't survive save and restore on the Host side.
   */
  homeScript(): string | undefined;
  toString(): string; // the display form (ADR 0018)
  equals(other: Value): boolean;
}

export type Kind =
  | "nothing" | "boolean" | "number" | "quantity" | "text" | "bytes"
  | "list" | "map" | "range" | "instant" | "civil date" | "pattern" | "function" | "object";

export declare class Decimal {
  toString(): string;                  // canonical, trailing zeros kept
  toBigInt(): bigint;                  // throws unless an integer
  toNumberLossy(): number;             // nearest, ties to even; every number fits (ADR 0034)
}

export interface DateFields {
  year: number; month: number; day: number;
  hour?: number; minute?: number; second?: number; nanosecond?: number;
}

export declare const nothing: Value;
export declare function bool(b: boolean): Value;
export declare function text(s: string): Value;    // a lone surrogate throws; NFC applied, uncharged
export declare function num(n: number | bigint): Value; // shortest round-trip; NaN, ±Infinity, >34 digits, |n| >= 1e34 throw
export declare function dec(s: string): Value;     // the `as number` grammar
export declare function quantity(n: Decimal, unit: string): Value;
export declare function civilDate(f: DateFields | string): Value; // fields, or the `as civil date` grammar
export declare function instant(epochNanos: bigint): Value;       // JS Date is never accepted
export declare function bytes(b: Uint8Array): Value;              // copied in
export declare function list(...vs: Value[]): Value;
/** Two numbers, or two Quantities of one dimension, kept as given (ADR 0034). */
export declare function range(from: Value, to: Value): Value;
/** Insertion order. A duplicate key after NFC throws. */
export declare function map(m: Map<string, Value> | Iterable<[string, Value]>): Value;
/** Literal records in Host code. Throws on integer-like keys, which JS reorders. */
export declare function record(o: Record<string, Value>): Value;

// ---------------------------------------------------------------------------
// JSON and the Value Encoding (ADRs 0021, 0030)
// ---------------------------------------------------------------------------

export declare function decodeJson(s: string): Value; // numbers read from text, never JSON.parse
export declare function encodeJson(v: Value): string;
/** The `+` rules, outside any Run and uncharged. Throws the ScriptError `+` would raise. */
export declare function add(a: Value, b: Value): Value;
export declare function encodeValue(v: Value): string; // a Function Value throws
export declare function decodeValue(
  s: string,
  resolve: (kind: string, id: string) => HostObject | undefined,
): Value;

// ---------------------------------------------------------------------------
// Shapes (ADRs 0015, 0030)
// ---------------------------------------------------------------------------

export declare class Shape { private readonly brand: "Shape" }
export type FieldShape = Shape | { shape: Shape; optional: true };

export declare const shape: {
  any: Shape; nothing: Shape; bool: Shape; number: Shape; text: Shape;
  value: Shape; // every value, including nested Function Values; not a storage encoding
  bytes: Shape; instant: Shape; civilDate: Shape; range: Shape; pattern: Shape;
  function: Shape; // a Function Value; any data Shape refuses one with `not encodable`
  quantityOf(unit: string): Shape;
  quantityKind(kind: string): Shape;
  listOf(s: Shape): Shape;
  map(fields: Record<string, FieldShape>): Shape; // closed
  openMap(fields: Record<string, FieldShape>): Shape;
  object(kind: ObjectKind): Shape;
  oneOf(...ss: Shape[]): Shape;
  optional(s: Shape): Shape; // Nothing or s; an outer Optional suffix may be omitted
};

// ---------------------------------------------------------------------------
// Capabilities and Operations (ADRs 0012, 0015)
// ---------------------------------------------------------------------------

export interface Cost { fuel: number; alloc?: number }
/** When an Operation lists any, the Core enforces the list (ADRs 0017, 0033). */
export interface ErrorDecl { code: string; fields?: Record<string, FieldShape> }

interface OpBase {
  /** A trailing Optional suffix may be omitted; Host functions receive only supplied args. */
  args?: Shape[];
  result?: Shape;
  cost: Cost;
  errors?: ErrorDecl[];
  /** Plain text for tooling only: the Host Manifest carries these, and nothing else reads them. */
  description?: string;
  examples?: string[]; // NorthTalk source, each calling this Operation
}
export type ScopeDecl =
  | { opens: string; abandon: string; closes?: never }
  | { closes: string; opens?: never; abandon?: never };

/** Synchronous, unmetered Host lifecycle work; see embedding/scoped-effects.md. */
export interface SegmentContext<B> {
  readonly group: Group; // identity namespace, not just its name
  readonly scriptName: string;
  readonly runId: string;
  readonly grantName: string; // the first enrolled Grant
  readonly segmentId: string;
  readonly binding: B;
  readonly now: bigint;
  readonly grants: readonly SegmentGrant<B>[]; // enrolled, in enrollment order; begin sees only the first
}
export interface SegmentGrant<B> {
  readonly grantName: string;
  readonly binding: B;
}
export interface EffectResult {
  status: "ok" | "failed" | "unknown";
  detail?: string; // Host-only, not covered by parity
}
export interface SegmentLifecycle<B> {
  begin(context: SegmentContext<B>): EffectResult;
  commit(context: SegmentContext<B>): EffectResult;
  rollback(context: SegmentContext<B>): EffectResult;
}
/** Compared by identity: Grants mapped to one coordinator share a Segment's participant. */
export type SegmentCoordinator = SegmentLifecycle<unknown>;
/** Maps each binding to its coordinator once, when a Grant is created. */
export interface CoordinatedLifecycle<B> {
  coordinator(binding: B): SegmentCoordinator;
}

export interface ImmediateOp<B> extends OpBase {
  mode: "immediate";
  scope?: ScopeDecl;
  segmentBound?: boolean; // absent/false: ordinary immediate effects
  /** Return a Value, or throw ScriptError, LimitReached, or anything else as `host error`. */
  do(call: Call<B>, ...args: Value[]): Value;
}
/**
 * Exactly one of `start` and `run`. `run` is Promise sugar: the Core answers
 * or fails when it settles. After a restore a `run` call can be answered,
 * failed or reissued, but adopting one throws "not adoptable".
 */
export interface SuspendingOp<B> extends OpBase {
  mode: "suspending";
  maxPendingMs?: number; // whole milliseconds; otherwise the Script's maxWaitMs
  start?(call: Call<B>, ...args: Value[]): void;
  run?(call: Call<B>, ...args: Value[]): Promise<Value>;
}
export interface FireOp<B> extends OpBase {
  mode: "fire-and-forget";
  fire(call: Call<B>, ...args: Value[]): void;
}
export type Operation<B> = ImmediateOp<B> | SuspendingOp<B> | FireOp<B>;

/** Declarations are ordered by name, whatever order the record is in. */
export interface CapabilityDef<B> {
  readonly name: string;
  /** A reusable template. Each load binds it to one Script. */
  grant(ops: string[] | "all", binding: B): Grant<B>;
}
export interface Grant<B> { readonly binding: B }

export interface Call<B> {
  readonly group: Group; // worker calls remain forbidden in callbacks
  readonly id: string;         // unique within the Group ("pricing/r1.c1")
  readonly scriptName: string;
  readonly runId: string;
  readonly grantName: string;
  readonly segmentId: string;
  readonly scopeName?: string;
  readonly automatic: boolean; // true only for Core-triggered abandonment
  readonly binding: B;
  readonly now: bigint;        // the last observed Clock reading
  readonly signal: AbortSignal; // aborted when the call is abandoned, including by a timeout
  /** Legal only while starting a Script call; forbidden for automatic abandonment. Throws LimitReached. */
  charge(fuel: number): void;
  /**
   * Queued, into the Group that made this Call, never one restored from it.
   * Ignored once the call isn't pending: abandoned, its Run ended, or discarded by a restore.
   */
  answer(v: Value, lateCost?: { fuel: number }): void;
  fail(e: ScriptError): void;
}

// ---------------------------------------------------------------------------
// Standard Capabilities (ADRs 0023, 0024; #71)
// ---------------------------------------------------------------------------

/**
 * Per-call costs, keyed by Operation name and copied by the factory.
 * Missing or invalid costs throw HostError `invalid value` (chapter 9).
 * Extra names are ignored; an absent alloc is zero.
 */
export type Costs = Readonly<Record<string, Cost>>;

/**
 * The binding is the default zone; an omitted or Nothing zone is undefined.
 * toInstant receives a resolved disambiguation, defaulting to "compatible".
 * Throw ScriptError `unknown zone` {zone} for an unknown zone, and
 * `ambiguous time` {civil, zone} from toInstant with "reject" (ADR 0033).
 */
export interface CalendarImpl {
  today(call: Call<string>, zone?: string): Value;
  now(call: Call<string>, zone?: string): Value;
  toCivil(call: Call<string>, instant: Value, zone?: string): Value;
  toInstant(call: Call<string>, civil: Value, disambiguation: string, zone?: string): Value;
  offset(call: Call<string>, instant: Value, zone?: string): Value;
  zone(call: Call<string>, zone?: string): Value;
}
/**
 * The binding is the default tag. The Core checks the effective tag's RFC 5646
 * syntax before these run; the Host owns supported-tag lookup and fallback.
 * Omitted/Nothing tags arrive as undefined; opts has all keys with defaults
 * filled in. Every Host failure becomes host error, including bad locale.
 */
export interface LocaleImpl {
  compare(call: Call<string>, a: Value, b: Value, opts: Value, tag?: string): Value;
  rank(call: Call<string>, texts: Value, opts: Value, tag?: string): Value;
  upper(call: Call<string>, s: Value, tag?: string): Value;
  lower(call: Call<string>, s: Value, tag?: string): Value;
  numberSymbols(call: Call<string>, tag?: string): Value;
  monthNames(call: Call<string>, opts: Value, tag?: string): Value;
  dayNames(call: Call<string>, opts: Value, tag?: string): Value;
  tag(call: Call<string>, tag?: string): Value;
}
export interface TimerImpl {
  schedule(call: Call<unknown>, name: string, at: Value, message: string, args: Value): void;
  cancel(call: Call<unknown>, name: string): void;
}
/**
 * The binding is the Store's name. The Core has checked the Shapes and
 * refused an empty key with `invalid key`; default and by arrive as supplied.
 * set, delete, increment and swap are Segment-bound: they act on the calling
 * Segment's pending writes, which commit applies and rollback discards.
 * Throw ScriptError `can't store` {kind}, `store full` {limit} or `store busy`
 * {key}, and from increment the error `add` throws (chapter 7, ADR 0062).
 * The implementation is its own Segment Coordinator, which a SqliteImpl gives
 * for the database that keeps its Stores (ADR 0070).
 */
export interface StoreImpl extends SegmentLifecycle<string> {
  get(call: Call<string>, key: string, fallback?: Value): Value;
  set(call: Call<string>, key: string, value: Value): void;
  delete(call: Call<string>, key: string): void;
  keys(call: Call<string>, prefix?: string): Value;
  increment(call: Call<string>, key: string, by?: Value): Value;
  swap(call: Call<string>, key: string, expected: Value, replacement: Value): boolean;
}
/**
 * sqlite is optional (chapter 7, ADR 0070). The binding names a database the
 * Host keeps; tables, when present, limits the tables a Grant may use, and
 * maxRows caps the rows a call may give.
 */
export interface SqliteBinding {
  readonly database: string;
  readonly tables?: readonly string[];
  readonly maxRows: number;
}
/** NULL, INTEGER, REAL, TEXT and BLOB. */
export type SqlValue = null | bigint | number | string | Uint8Array;
/** A list binds `?` and `?NNN`; a Map binds `:name`, keyed without the colon. */
export type SqlParams = readonly SqlValue[] | ReadonlyMap<string, SqlValue>;
export interface SqlRows {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly SqlValue[])[]; // each in column order
}
/**
 * The Core has checked the Shapes and max, converted params by the chapter 7
 * rules and charged max × perRow. It converts the result, raising `sql` for a
 * column named twice and `unrepresentable` for a double it can't hold.
 * change, begin, commit and rollback are Segment-bound: they act inside the
 * calling Segment's transaction, which the coordinator publishes or discards.
 * begin, commit and rollback open, release and roll back a savepoint. A failed
 * call leaves the database as it was. Throw ScriptError `sql` {reason},
 * `constraint` {kind}, `sqlite busy`, `not read-only`, `too many rows` {max},
 * or `unrepresentable` {column} for TEXT that isn't valid UTF-8 (chapter 9).
 */
export interface SqliteImpl {
  /** Called once per Grant. The same database gives the same coordinator. */
  coordinator(database: string): SegmentCoordinator;
  query(call: Call<SqliteBinding>, sql: string, params: SqlParams, max: number): SqlRows;
  change(call: Call<SqliteBinding>, sql: string, params: SqlParams, max: number): SqlRows & { readonly changes: number };
  begin(call: Call<SqliteBinding>): void;
  commit(call: Call<SqliteBinding>): void;
  rollback(call: Call<SqliteBinding>): void;
}
/** Write shows the Value's text form. Read answers with text, without its line break. */
export interface ConsoleImpl {
  write(call: Call<unknown>, value: Value): void;
  read(call: Call<unknown>): void;
}

// ---------------------------------------------------------------------------
// Host Objects (ADRs 0012, 0016)
// ---------------------------------------------------------------------------

export interface PropDef<N> {
  shape?: Shape;
  get(o: HostObject<N>): Value;
  /** Omit for read-only. Throw ScriptError to refuse. */
  set?(o: HostObject<N>, v: Value): void;
  getCost?: Cost;
  setCost?: Cost;
}
export interface ObjectKindDef<N> {
  name: string;
  props: Record<string, PropDef<N>>;
  /** For the Host Manifest only. setParent doesn't check it. */
  parentKinds?: string[];
}
export interface ObjectKind<N = unknown> { readonly name: string }

/** A Group-scoped handle to something the Host owns. */
export interface HostObject<N = unknown> {
  readonly id: string;
  readonly kind: ObjectKind<N>;
  readonly native: N;
  readonly value: Value;
}

// ---------------------------------------------------------------------------
// Limits (ADRs 0006, 0015, 0026; #71)
// ---------------------------------------------------------------------------

export interface Limits {
  fuelPerRun: number;
  allocPerRun: number;
  persistentState: number; // Script-wide; never overridden per Delivery
  callDepth: number;
  patternSize: number; // Text Pattern program instructions; never overridden per Delivery
  mailboxDepth: number;
  maxWaitMs: number; // whole milliseconds; a fraction throws "invalid value"
  maxJoin: number;
  cleanupBudget: number;
}
export declare const defaultLimits: Readonly<Limits>;

/** Tightens per-Run limits for one Delivery. Loosening throws "invalid value". */
export type LimitOverride = Partial<Pick<Limits, "fuelPerRun" | "allocPerRun" | "maxWaitMs" | "maxJoin">>;

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export interface Versions {
  language: string;
  costModel: string;
  unicode: string;
  core: string; // "ts/0.1.0": informational
  saveFormat: string;
}
export declare const coreVersions: Versions;

export interface GroupOptions {
  name: string;
  /** Called when a queued Host Input makes the Group runnable. Don't pump inside it. */
  onReady?(): void;
  trace?: (line: string) => void;
}

/** Compile-time Operation modes and argument Shapes, by the Grant name in source. */
export type GrantDecls = Readonly<Record<string, Readonly<Record<string, {
  mode: "immediate" | "suspending" | "fire-and-forget";
  args: readonly Shape[];
}>>>>;

export interface LibrarySource { name: string; version: string; source: string }
export interface OperationRef { capability: string; operation: string }

export interface Library {
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly identity: Uint8Array; // 32 bytes
  readonly imports: readonly Library[];
  readonly needs: readonly OperationRef[];
}

/** Process-wide: the compile cache, and Capability and Object Kind definitions. */
export interface Core {
  /** A plain lifecycle makes each Grant its own coordinator. */
  defineCapability<B = void>(name: string, ops: Record<string, Operation<B>>, lifecycle?: SegmentLifecycle<B> | CoordinatedLifecycle<B>): CapabilityDef<B>;
  defineObjectKind<N>(k: ObjectKindDef<N>): ObjectKind<N>;
  clockCapability(costs: Costs): CapabilityDef<void>;
  calendarCapability(impl: CalendarImpl, costs: Costs): CapabilityDef<string>; // binding: default zone
  localeCapability(impl: LocaleImpl, costs: Costs): CapabilityDef<string>;     // binding: default tag
  timerCapability(impl: TimerImpl, costs: Costs): CapabilityDef<unknown>;
  consoleCapability(impl: ConsoleImpl, costs: Costs): CapabilityDef<unknown>;
  storeCapability(impl: StoreImpl, costs: Costs): CapabilityDef<string>;      // binding: the Store's name; impl coordinates every binding
  /** Optional for Hosts. perRow is whole Fuel charged per row of max; a bad one throws "invalid value". */
  sqliteCapability(impl: SqliteImpl, costs: Costs, perRow: number): CapabilityDef<SqliteBinding>;
  /** Throws LoadError. `imports` holds every Library its `use` lines name. */
  compileLibrary(src: LibrarySource, imports?: Library[], declarations?: GrantDecls): Library;
  newGroup(o: GroupOptions): Group;
  restore(save: Uint8Array, o: RestoreOptions): { group: Group; result: RestoreResult };
}
export declare function createCore(): Core;

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export interface LoadOptions {
  name: string;
  source: string;
  /** Keyed by the name the Script uses. */
  grants: Record<string, Grant<any>>;
  /** Trim once at Load, including Library needs and implicit abandonment dependencies. */
  grantsAsUsed?: boolean;
  owner?: HostObject;
  objects?: Record<string, HostObject>;
  limits?: Partial<Limits>;
}

export interface Message {
  name: string;
  args?: Value[];
  limits?: LimitOverride;
}

/** Settles when a Pump ends the Run it started. Rejects with ScriptError `send failed`. */
export interface Requested { id: string; result: Promise<Value> }

/** Settles, never rejects, when a Pump seals the Verdict: often before the Run ends. */
export interface Deciding { id: string; decided: Promise<Decided> }
export type Verdict = "allowed" | "vetoed" | "undecided";
export interface Decided {
  delivery?: string;
  broadcast?: string;
  verdict: Verdict;
  vetoes: { script: string; run: string; reason: Value }[]; // recipient order
  undecided: { script: string; run?: string; outcome: Outcome }[];
}

export interface PumpOptions {
  fuelSlice?: number; // per Script, per Pump
  fuelCap?: number;   // across the Group
}
export interface PumpResult {
  state: "idle" | "sliced" | "stopped" | "rewound"; // rewound: a Rewind landed, and the Pump returned at once
  nextDeadline?: bigint;
  fuelUsed: number;
  reports: Report[];
}

export type CarryOver = "reset variables" | "carry variables";

export interface Group {
  readonly name: string;
  script(name: string): Script | undefined;
  /** Worker. Throws LoadError or HostError. */
  load(o: LoadOptions): Script;
  /** Worker, Host Input. */
  addLibrary(l: Library): void;
  /** Worker, one atomic Host Input. Recompiles dependents and stop-and-reloads importers. */
  replaceLibrary(l: Library, carry: CarryOver): Report[];
  /** Any time, inside a Pump too. Throws HostError "duplicate object id". */
  object<N>(kind: ObjectKind<N>, id: string, native: N): HostObject<N>;
  /** Any time, inside a Pump too. The handle with this Object Kind name and id, disposed or not, such as one Restore made. */
  objectById(kind: string, id: string): HostObject | undefined;
  /** Queued. Refuses cycles and disposed children at the call when known; otherwise Pump reports a host error. */
  setParent(o: HostObject, parent: HostObject | undefined): void;
  dispose(o: HostObject): void;
  /** Queued. Returns the delivery id. Throws MailboxFull or HostError. */
  deliver(to: HostObject, m: Message): string;
  /**
   * Queued. Aborting signal queues cancel-delivery: it cancels the Run, or
   * removes a Delivery still in the mailbox with a "cancelled" run end.
   */
  request(to: HostObject, m: Message, o?: { signal?: AbortSignal }): Requested;
  broadcast(m: Message): string; // the broadcast id
  /**
   * Queued. Asks whether something may happen (ADR 0031). Aborting the signal
   * before the Verdict is sealed queues cancel-delivery and settles it
   * "undecided"; aborting after does nothing.
   */
  decide(to: HostObject, m: Message, o?: { signal?: AbortSignal }): Deciding;
  /** Queued. Settles once every recipient has sealed. */
  decideBroadcast(m: Message, o?: { signal?: AbortSignal }): Deciding;
  /** Queued. A Host call of a Function Value, shaped like request. */
  call(fn: Value, args: Value[], o?: { signal?: AbortSignal; limits?: LimitOverride }): Requested;
  /** Worker. Synchronous. now is epoch nanoseconds; earlier than the last Pump's throws. */
  pump(now: bigint, o?: PumpOptions): PumpResult;
  /** Throws effects pending for live scopes, an enlisted participant or fatal effect uncertainty. */
  save(): Uint8Array;
  fingerprint(): Uint8Array; // the Group Fingerprint, 32 bytes
  /** Worker, and the Host Input `vars`. Reads the Group without changing it. */
  inspect(): Inspection;
  /**
   * Queued, before the first Pump after a restore. Throws HostError "unknown call"
   * for a call that isn't pending, one already settled, or once the first Pump has
   * started. For adopt, returns the Call the Host answers or fails through.
   */
  settle(callId: string, s: Settlement): Call<any> | undefined;
}

export interface Inspection {
  scripts: ScriptView[]; // in load order
}
export interface ScriptView {
  name: string;
  disabledGrants?: string[]; // disabled named Grants, in code-point order; absent when empty
  vars: [string, Value][]; // its Script Variables, in declaration order
  runs: RunView[];         // every Run that hasn't ended, in the order they started
  mailbox: MessageView[];  // in mailbox order
}
export interface RunView {
  id: string;
  status: "ready" | "suspended" | "parked" | "preempted";
  handler: string;   // its Handler, or the display form of the Function Value it runs
  wait?: string;     // suspended: the `seg` end reason it suspended at (chapter 11)
  until?: bigint;    // suspended: its deadline, if it has one
  calls?: string[];  // suspended: the calls, replies or Join Members it waits for
}
export interface MessageView {
  delivery?: string; // absent for a message a Script sent
  from?: string;     // for a message a Script sent, the call or Run that sent it
  message: Message;
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

export interface Counters {
  fuelTotal: number; allocTotal: number; runs: number; faults: number;
  persistentState: number; mailboxLen: number;
}

export interface Script {
  readonly name: string;
  /** Worker. A fresh map of kept names and Operations, including revoked and disabled Grants. */
  grants(): Record<string, string[]>;
  /** Worker. Fresh snapshot; chapter 9 defines lifetime totals and current state. */
  counters(): Counters;
  /** Worker. Throws LoadError. keepMailbox keeps the mailbox, a rewound message included (ADR 0068). */
  reload(source: string, carry: CarryOver, o?: { keepMailbox?: boolean }): Report[];
  /** Worker. A reused name throws HostError "name reused". */
  extend(source: string): void;
  /** Queued. stop, cancelRun and rewindRun land by the running Pump's next Host crossing. */
  stop(reason: string): void;
  cancelRun(runId: string): void;
  /** Puts a Run still in its first Segment back in the mailbox as its message (ADR 0068). */
  rewindRun(runId: string): void;
  revoke(grantName: string): void;
  deliver(m: Message): string;
  request(m: Message, o?: { signal?: AbortSignal }): Requested;
  decide(m: Message, o?: { signal?: AbortSignal }): Deciding;
}

// ---------------------------------------------------------------------------
// Reports (ADR 0015)
// ---------------------------------------------------------------------------

export type Outcome =
  | "completed" | "errored" | "limit fault" | "cancelled"
  | "unhandled" | "dropped" | "effect failed";

export interface Location { unit: string; line: number; col: number; handler: string; pc: number }

export interface EffectFailure {
  script: string;
  run: string;
  grant: string;
  segment: string;
  phase: "abandon" | "begin" | "commit" | "rollback";
  status: "failed" | "unknown";
  scope?: string; // abandonment only
  detail?: string; // Host-only, not covered by parity
}

/** Ordinary Host Delivery ancestry; retained across forwarding and saves. */
export interface RunAncestry {
  rootDelivery: string;
  parentRun?: string; // absent for a root Run
  parentCall?: string; // present when spawned through a call
}
export interface RunStarted extends RunAncestry {
  kind: "run started";
  script: string;
  run: string;
  delivery?: string;
  selector?: string; // absent for a Function Value invocation
  fn?: Value; // present instead of selector for a Function Value invocation
  args: Value[];
}
export interface RunDiscarded extends RunAncestry {
  kind: "run discarded";
  script: string;
  run: string;
  reason: string; // stop, reload, library replacement, variables-only restore, or rewind
}
export interface RunAccounting extends RunAncestry {
  kind: "run accounting";
  script: string;
  run: string;
  fuel: number; // lifetime cumulative, including observation/cleanup charges
  state: "live" | "terminal" | "discarded";
}
export interface CausalWork {
  kind: "causal work";
  rootDelivery: string;
  liveRuns: number;
  queuedMessages: number;
  discardedMessages: number; // cumulative lifecycle discards, not normal consumption
}

export type Report =
  | { kind: "host error"; code: HostErrorCode; detail?: string } // drain-time Host refusal; detail is outside parity
  | RunStarted | RunDiscarded | RunAccounting | CausalWork
  | {
      kind: "run end";
      script: string;
      run?: string; // absent for a Delivery cancelled before it started
      delivery?: string;
      broadcast?: string;
      handler?: string; // absent with run
      fallback?: boolean; // a Fallback Handler clause ran it; handler is then the message's Selector
      outcome: Outcome;
      effect?: EffectFailure; // effect failed: the failure that prevented commit
      cleanupFailed?: { code: string } | { limit: "cleanup" | "alloc" | "persistent" | "depth" | "pattern" | "join" };
      result?: Value;
      error?: ScriptError;
      limit?: "fuel" | "alloc" | "persistent" | "depth" | "pattern" | "join" | "cleanup";
      at?: Location;
      fuel: number;
      alloc: number;
    }
  | {
      kind: "stop";
      script: string;
      reason: string; // the Host's, or "owner disposed"
      discardedRuns: string[];
      droppedMessages: string[];
      pendingCalls: string[];
    }
  | { kind: "unhandled"; delivery: string; message: Message; target?: HostObject }
  | ({ kind: "effect failure" } & EffectFailure)
  | { kind: "call failed"; script: string; call: string; operation: OperationRef; detail: string }
  | ({ kind: "decided" } & Decided);

// ---------------------------------------------------------------------------
// Save and restore (ADR 0008)
// ---------------------------------------------------------------------------

export interface RestoreOptions extends GroupOptions {
  libraries: Library[];
  grants(script: string, name: string): Grant<any> | undefined;
  /** An id it can't resolve restores as a disposed Host Object. */
  resolve(kind: string, id: string): { native: unknown } | undefined;
  onMismatch: "reject" | "variables only";
}
export interface PendingCall { id: string; script: string; grant: string; operation: OperationRef; args: Value[] }
export interface RestoreResult {
  reports: Report[]; // accounting baseline, including saved work discarded on restore
  variablesOnly: boolean;
  pending: PendingCall[]; // unsettled at the first Pump fails as `call lost`
  discardedRuns: string[];
  disposed: [kind: string, id: string][]; // the Host Objects that didn't resolve
  // A variables-only restore also lists what it discarded (10-save-and-restore.md).
  droppedMessages: string[];
  abandonedCalls: string[];
}
export type Settlement =
  | { answer: Value }
  | { fail: ScriptError }
  | { reissue: true }
  | { adopt: true };

// ---------------------------------------------------------------------------
// Host Manifest (ADR 0028)
// ---------------------------------------------------------------------------

export interface MessageDecl {
  name: string;
  args?: Shape[];
  receivers?: ObjectKind[];
}
export interface ManifestSpec {
  kind: string;
  version: string;
  grants: Record<string, Grant<any>>;
  libraries?: Library[];
  messages?: MessageDecl[];
  objectKinds?: ObjectKind[];
  objects?: Record<string, ObjectKind>;
}
/** Deterministic JSON. A pure function of the definitions; never includes bindings. */
export declare function exportManifest(m: ManifestSpec): string;
