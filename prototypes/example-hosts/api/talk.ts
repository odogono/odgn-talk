// PROTOTYPE: proposed TS Core embedding API (throwaway), used by the Bun and
// browser Example Hosts. Declarations only. It mirrors ../api/talk.go; the
// differences are deliberate and listed in ../NOTES.md ("Go vs TS").
// `// ??` marks a place the API strains.

// ---------------------------------------------------------------------------
// Versions (ADR 0009)
// ---------------------------------------------------------------------------

export interface Versions {
  language: string;   // "1.0"
  costModel: string;  // "1"
  machine: string;    // "1"
  unicode: string;    // "16.0"
  core: string;       // "ts/0.1.0" — informational
  saveFormat: string; // "ts-1" — same-core only
}
export declare const coreVersions: Versions;
export declare function parityCompatible(a: Versions, b: Versions): boolean;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Immutable Script value or Host Object handle. Opaque on purpose. */
export declare class Value {
  private readonly brand: unique symbol;
  readonly kind: Kind;
  asText(): string | undefined;
  asDecimal(): Decimal | undefined;
  asBytes(): Uint8Array | undefined; // a copy
  get(key: string): Value;           // Nothing when missing
  index(i: number): Value;           // 1-based
  readonly length: number;
  entries(): [string, Value][];      // insertion order
  asObject(): HostObject | undefined;
  toString(): string;                // canonical text form
}
export type Kind =
  | "nothing" | "boolean" | "number" | "quantity" | "text" | "bytes"
  | "list" | "map" | "instant" | "civil date" | "pattern" | "object";

export declare class Decimal {
  toString(): string;
  toBigInt(): bigint | undefined; // when an integer
  toNumberLossy(): number;
}

export declare const nothing: Value;
export declare function bool(b: boolean): Value;
/** Throws on lone surrogates; applies NFC. */
export declare function text(s: string): Value;
/**
 * Exact integers only: a JS number must be a safe integer, else it throws.
 * Fractions go through `dec("0.1")` or the visibly lossy `fromFloat`.
 * ?? Go's `Int(int64)` can't be misused this way; here `int(0.1)` throws at
 *    run time. Worth it to keep `0.1` from silently becoming
 *    0.1000000000000000055511151231257827.
 */
export declare function int(n: number | bigint): Value;
export declare function dec(literal: string): Value;
export declare function fromFloat(f: number): Value; // shortest round-trip; NaN/±Infinity throw
export declare function quantity(n: Value, unit: string): Value;
export declare function bytes(b: Uint8Array): Value; // copied in
export declare function list(...vs: Value[]): Value;
/** From pairs, in order. */
export declare function map(pairs: Iterable<[string, Value]>): Value;
/**
 * Convenience for literal records in Host code. Throws if any key is
 * integer-like ("1", "42"), because JS enumerates those first, which would
 * silently reorder the map.
 * ?? A trap Go doesn't have. Keep it, or force `map([...])` everywhere?
 */
export declare function record(o: Record<string, Value>): Value;
export declare function instant(epochNanos: bigint): Value;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export declare class Shape { private readonly brand: unique symbol }
export declare const shape: {
  any: Shape; text: Shape; number: Shape; bytes: Shape; bool: Shape;
  listOf(s: Shape): Shape;
  map(fields: Record<string, Shape | { shape: Shape; optional: true }>): Shape;
  openMap(fields: Record<string, Shape | { shape: Shape; optional: true }>): Shape;
  object(kind: ObjectKind): Shape;
  oneOf(...ss: Shape[]): Shape;
  optional(s: Shape): Shape;
};

// ---------------------------------------------------------------------------
// Capabilities and Operations (ADR 0012)
// ---------------------------------------------------------------------------

export interface Cost { fuel: number; alloc?: number }

interface OpBase {
  args?: Shape[];
  result?: Shape;
  cost: Cost;
}
export interface ImmediateOp<B> extends OpBase {
  mode: "immediate";
  do(call: Call<B>, ...args: Value[]): Value;
}
/**
 * Suspending. Two spellings of the same thing:
 *  - `start`: the Host answers later via call.answer/fail (what save/restore
 *    needs, since a Promise can't be saved);
 *  - `run`: Promise sugar; the Core calls answer/fail when it settles.
 * ?? `run` is what every TS Host will reach for. It's fine until a save:
 *    the promise is simply forgotten and Settle on restore reissues it.
 */
export interface SuspendingOp<B> extends OpBase {
  mode: "suspending";
  start?(call: Call<B>, ...args: Value[]): void;
  run?(call: Call<B>, ...args: Value[]): Promise<Value>;
}
export interface FireOp<B> extends OpBase {
  mode: "fire-and-forget";
  fire(call: Call<B>, ...args: Value[]): void;
}
export type Operation<B> = ImmediateOp<B> | SuspendingOp<B> | FireOp<B>;

export interface CapabilityDef<B> {
  readonly name: string;
  grant(ops: string[] | "all", binding: B): Grant<B>;
}
export declare function defineCapability<B = void>(
  name: string,
  ops: Record<string, Operation<B>>,
): CapabilityDef<B>;

export interface Grant<B> {
  readonly binding: B;
  revoke(): void;
}

export interface Call<B> {
  readonly id: string;              // "r12.c3"
  readonly binding: B;
  readonly script: Script;
  /** Aborted when the Run is cancelled or its Script stops. */
  readonly signal: AbortSignal;
  /** Throws LimitReached; let it propagate (or rethrow) without doing the work. */
  charge(fuel: number): void;
  answer(v: Value): void;
  fail(e: ScriptError): void;
}
export declare class LimitReached extends Error {}
/** An ordinary, catchable error inside the Script. */
export declare class ScriptError extends Error {
  constructor(code: string, message: string, data?: Value);
  readonly code: string;
}

// ---------------------------------------------------------------------------
// Host Objects and the Message Path
// ---------------------------------------------------------------------------

export interface PropDef<N> {
  shape?: Shape;
  get(native: N): Value;
  set?(native: N, v: Value): void; // throw ScriptError to refuse
  getCost?: Cost;
  setCost?: Cost;
}
export interface ObjectKind<N = unknown> {
  readonly name: string;
  object(id: string, native: N): HostObject<N>; // id: stable, Host-supplied (ADR 0008)
}
export declare function defineObjectKind<N>(k: {
  name: string;
  props: Record<string, PropDef<N>>;
  parent?(native: N): HostObject | undefined; // ?? see talk.go: pure, or Core-owned parents
  endOfPath?(native: N, m: Message): void;
}): ObjectKind<N>;

export interface HostObject<N = unknown> {
  readonly id: string;
  readonly native: N;
  readonly value: Value;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Limits, Core, Group, Script
// ---------------------------------------------------------------------------

export interface Limits {
  fuelPerRun: number;
  allocPerRun: number;
  persistentState: number;
  callDepth: number;
  mailboxDepth: number;
  maxWaitMs: number;
  perHandler?: Record<string, Partial<Limits>>;
}
export declare const defaultLimits: Limits;

/** Instant in epoch nanoseconds, as bigint. ?? see NOTES: Instant resolution. */
export interface Clock { now(): bigint }

export interface GroupOptions {
  name: string;
  clock: Clock;
  reports?: Reports;
  trace?: (line: string) => void;
  /**
   * Called when a delivery or an answer makes the Group runnable. The Host
   * decides when to pump (microtask, next tick, next game frame).
   */
  onReady?(): void;
}

export interface MessageDecl {
  args?: Shape[];
  deciding?: boolean;
  defaultQueueing?: "queued" | "replacing" | "dropping" | "every time";
}

export interface LoadOptions {
  name: string;
  source: string;
  grants: Record<string, Grant<any>>;
  owner?: HostObject;
  limits?: Partial<Limits>;
  messages?: Record<string, MessageDecl>;
}

export interface Diagnostic { code: string; message: string; line: number; col: number }
export declare class LoadError extends Error { readonly diagnostics: Diagnostic[] }

export interface Message { name: string; args?: Value[]; to?: HostObject }

export interface Script {
  readonly name: string;
  counters(): Counters;
  stop(reason: string): void;
  cancelRun(id: string): void;
  reload(source: string, opts?: { carryVariables?: boolean }): void; // throws LoadError
  /** Throws MailboxFull. Never runs Script code. */
  deliver(m: Message): void;
  /** `send … and wait` from outside. Settles once the Group is pumped far enough. */
  request(m: Message): Promise<Value>; // rejects with ScriptError or RunEnded
  decide(m: Message): Decision;
}
export interface Decision {
  readonly resolved: boolean;
  readonly vetoed: boolean;
  readonly reason: Value;
  readonly settled: Promise<void>;
}
export declare class MailboxFull extends Error {}
export declare class RunEnded extends Error { readonly report: RunReport }

export interface Counters {
  fuelTotal: number; allocTotal: number; runs: number; faults: number;
  persistentState: number; mailboxLen: number;
}

export interface PumpOptions {
  fuelSlicePerScript?: number;
  fuelCap?: number;
}
export interface PumpResult {
  state: "idle" | "sliced" | "stopped";
  nextDeadline?: bigint;
  fuelUsed: number;
}

export interface Group {
  load(o: LoadOptions): Script; // throws LoadError
  script(name: string): Script | undefined;
  /** Synchronous. Reads the Clock once. The Group is Quiescent afterwards. */
  pump(o?: PumpOptions): PumpResult;
  save(): Uint8Array;
}

export interface Core {
  newGroup(o: GroupOptions): Group;
  restore(save: Uint8Array, o: RestoreOptions): { group: Group; report: RestoreReport };
}
export declare function createCore(): Core;

/**
 * Helper, not part of the Core proper: drives a Group on a server with a
 * real Clock. It pumps on onReady (via queueMicrotask) and at nextDeadline
 * (via setTimeout), with a Fuel cap per pump so the event loop breathes.
 * The browser game doesn't use it; it pumps once per tick.
 */
export declare function autoDrive(
  group: Group,
  o?: { fuelCap?: number },
): { stop(): void };

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface Reports {
  runEnd?(r: RunReport): void;
  stop?(r: StopReport): void;
  unhandled?(s: Script, m: Message): void;
}
export interface RunReport {
  script: Script;
  run: string;
  handler: string;
  outcome: "completed" | "errored" | "limit fault" | "cancelled" | "unhandled";
  error?: ScriptError;
  limit?: "fuel" | "alloc" | "persistent" | "depth";
  at?: { line: number; col: number; handler: string; pc: number };
  fuel: number;
  alloc: number;
}
export interface StopReport {
  script: Script;
  reason: string;
  discardedRuns: string[];
  pendingCalls: string[];
}

// ---------------------------------------------------------------------------
// Save and restore (ADR 0008)
// ---------------------------------------------------------------------------

export interface PendingCall {
  id: string; script: string; capability: string; operation: string; args: Value[];
}
export type Settlement =
  | { answer: Value }
  | { fail: ScriptError }
  | { reissue: true };

export interface RestoreOptions extends Omit<GroupOptions, "name"> {
  grants(script: string, name: string): Grant<any> | undefined;
  resolve(kind: string, id: string): HostObject | undefined;
  settle(p: PendingCall): Settlement;
  onMismatch: "reject" | "variables only";
}
export interface RestoreReport {
  variablesOnly: boolean;
  discardedRuns: string[];
  disposed: string[];
}
