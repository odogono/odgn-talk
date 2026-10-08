import { deferFault, machineDebug } from './debug';
/* eslint require-yield: "off" */
// Chapter 8's Abstract Machine over the code units the lowering produces. A
// Run's frames, slots and operand stacks follow chapter 8's state; each
// instruction is charged by Cost Model 0 before it does anything, so a Run
// that can't pay faults at it; errors unwind through the Unwind Table.
import {
  buildBits,
  buildField,
  buildSized,
  readBits,
  readBytes,
  readInt,
  readLiteral,
  readRest,
  type Reader,
} from './binary';
import { charge, partSize, sizeOf, type Measured } from './costs';
import type { Body, CodeUnit, Instruction, UnwindEntry } from './code-unit';
import { arityOf, instructionSpec } from './code-unit';
import { errorMessages, limitDefaults } from './generated/machine';
import { builtins, grammar } from './generated/syntax';
import {
  appendTo,
  arithmetic,
  builtin,
  builtinDefaults,
  canConvert,
  chunkDelete,
  chunkGet,
  chunkSet,
  chunkThere,
  comparison,
  concat,
  convert,
  deleteKey,
  equals,
  getKey,
  hasKey,
  isEmpty,
  isKind,
  keyText,
  makePatternValue,
  makeRange,
  matchCaptures,
  matchesOf,
  member,
  negated,
  NotImplementedError,
  property,
  ScriptError,
  search,
  setKey,
  splice,
  textForm,
  waitNs,
  wrongKind,
} from './operations';
import { readDisplay } from './readers';
import { validComputedMessageName } from './selectors';
import { standardChecks } from './standard-capability-checks';
import {
  acceptsArgumentCount,
  LimitReached,
  mismatch,
  type Call,
  type Grant,
  type Operation,
  type ImmediateOp,
  type EffectResult,
  type SegmentContext,
  type Shape,
} from './capabilities';
import type { EffectFailure } from './group';
import { HostError, ScriptError as HostScriptError } from './errors';
import {
  bool,
  dec,
  functionValue,
  functionsBelongTo,
  listValues,
  map,
  nothing,
  quantity,
  text,
  Value,
  type FunctionRef,
} from './values';
import type { PatternElement } from './view';
import { stateOf, type ObjectState } from './objects';

export type LimitName =
  | 'fuelPerRun'
  | 'allocPerRun'
  | 'persistentState'
  | 'callDepth'
  | 'patternSize'
  | 'mailboxDepth'
  | 'maxWaitMs'
  | 'maxJoin'
  | 'cleanupBudget';
export type Limits = Record<LimitName, number>;
export const defaultLimits: Limits = {
  fuelPerRun: limitDefaults.fuelPerRun,
  allocPerRun: limitDefaults.allocPerRun,
  persistentState: limitDefaults.persistentState,
  callDepth: limitDefaults.callDepth,
  patternSize: limitDefaults.patternSize,
  mailboxDepth: limitDefaults.mailboxDepth,
  maxWaitMs: limitDefaults.maxWaitMs,
  maxJoin: limitDefaults.maxJoin,
  cleanupBudget: limitDefaults.cleanupBudget,
};

/** The error maps the Core raised, which a Trace writes without `message`. */
export const coreRaised = new WeakSet<Value>();

/** A code unit that can't load: a literal pattern past its limit, or a failed initialiser. */
export class UnitLoadError extends Error {
  constructor(
    readonly code: 'pattern too large' | 'initialiser failed',
    readonly line: number,
    readonly col: number,
    readonly error: Value | null = null,
  ) {
    super(`${code} at ${line}:${col}`);
    this.name = 'UnitLoadError';
  }
}

const builtinContracts = new Map<string, { required: number; total: number }>(
  builtins.flatMap(b =>
    'contract' in b ? [[b.name, b.contract] as const] : [],
  ),
);
// The Built-in Constants' values (chapter 7, Constants).
const builtinConstants: Record<string, Value> = {
  pi: dec('3.141592653589793238462643383279503'),
  newline: text('\n'),
  tab: text('\t'),
  quote: text('"'),
};

type Constant =
  | { k: 'value'; value: Value }
  | { els: readonly PatternElement[]; k: 'template' }
  | { k: 'unimplemented'; what: string };

/**
 * A loaded code unit, a Script's or a Library's: its constants, definitions
 * and Handler clauses, linked to the Libraries its `use` lines name.
 */
export class Code {
  readonly constants: Constant[];
  readonly definitions: Value[];
  readonly clauses = new Map<string, Body[]>();
  /**
   * Its Fallback Handler's clauses, in source order. They are kept apart
   * from `clauses`, so no Selector finds them (ADR 0064).
   */
  fallback: Body[] = [];
  /** The Libraries it imports, by name. */
  readonly libraries = new Map<string, Code>();
  /** Whether it is a stdlib Library's, whose errors name the caller (ADR 0037). */
  stdlib = false;
  /**
   * Whether its errors name the caller, as a stdlib Library's do. A Host may
   * ask this of any Library, outside the Spec, as `northtalk test` does.
   */
  atCaller = false;

  constructor(
    readonly unit: CodeUnit,
    readonly identity = '',
  ) {
    this.constants = unit.constants.map((display, i) => {
      const els = unit.patterns.get(i);
      if (els) {
        return /\(\d+\)/.test(display) && hasSplice(els)
          ? { k: 'template', els }
          : { k: 'value', value: makePatternValue(els) };
      }
      if (display in builtinConstants) {
        return { k: 'value', value: builtinConstants[display]! };
      }
      try {
        return { k: 'value', value: readDisplay(display) };
      } catch {
        return { k: 'unimplemented', what: `the constant ${display}` };
      }
    });
    this.definitions = unit.definitions.map(() => nothing);
    for (const body of unit.bodies) {
      if (body.kind === 'handler') {
        const list = this.clauses.get(body.name) ?? [];
        list.push(body);
        this.clauses.set(body.name, list);
      } else if (body.kind === 'fallback') {
        this.fallback.push(body);
      }
    }
  }

  get name() {
    return this.unit.name;
  }

  constant(i: number): Value {
    const c = this.constants[i]!;
    if (c.k === 'value') {
      return c.value;
    }
    throw new NotImplementedError(
      c.k === 'template' ? 'a template constant' : c.what,
    );
  }

  /** The Library that holds an import, written `library:name`. */
  library(name: string): { code: Code; name: string } {
    const at = name.indexOf(':');
    const library = name.slice(0, at);
    const code = this.libraries.get(library);
    if (!code) {
      throw new NotImplementedError(`the stdlib Library ${library}`);
    }
    return { code, name: name.slice(at + 1) };
  }

  /** An exported function's body. */
  function(name: string): Body {
    return this.unit.bodies.find(
      b => b.kind === 'function' && b.name === name,
    )!;
  }

  /** Link the Libraries it imports, and take the Constants it imports from them. */
  link(libraries: ReadonlyMap<string, Code>, home?: Script) {
    for (const [name, code] of libraries) {
      this.libraries.set(name, code);
    }
    this.unit.definitions.forEach((name, i) => {
      if (/^[^.]*:/.test(name)) {
        const { code, name: constant } = this.library(name);
        const value =
          code.definitions[code.unit.definitions.indexOf(constant)]!;
        this.definitions[i] = home ? homeConstant(value, home) : value;
      }
    });
  }
}

/** A loaded Script: its code, and its Script Variables. */
export class Script extends Code {
  variables: Value[];
  functionGroup?: object;
  readonly boundConstants = new Map<Value, Value>();
  live = true;
  readonly units: Code[] = [this];
  variableNames: string[];

  constructor(
    unit: CodeUnit,
    readonly limits: Limits = defaultLimits,
    readonly home?: Script,
    identity = '',
  ) {
    super(unit, identity);
    this.variableNames = [...unit.variables];
    this.variables = unit.variables.map(() => nothing);
  }

  codeFor(body: Body): Code {
    return this.units.find(code => code.unit.bodies.includes(body)) ?? this;
  }

  attach(extension: Script) {
    this.units.push(extension);
    this.variableNames = [...extension.variableNames];
    this.variables = [...extension.variables];
    for (const [name, clauses] of extension.clauses) {
      this.clauses.set(name, clauses);
    }
    // A Fallback Handler in an extension replaces the older one, as a
    // Handler's clauses do (ADR 0064).
    if (extension.fallback.length) {
      this.fallback = extension.fallback;
    }
  }

  /** The Script Variables' share of Persistent State. */
  variablesSize(): number {
    return this.variables.reduce((total, v) => total + sizeOf(v), 0);
  }
}

const hasSplice = (els: readonly PatternElement[]): boolean => {
  const work = [...els];
  while (work.length) {
    const e = work.pop()!;
    if (e.k === 'splice') {
      return true;
    }
    if (e.k === 'group') {
      work.push(...e.els);
    } else if (e.k === 'alternation') {
      work.push(...e.options);
    } else if ('e' in e && typeof e.e === 'object' && 'k' in e.e) {
      work.push(e.e);
    }
  }
  return false;
};

/**
 * Load a code unit: check each literal Text Pattern against the size limit,
 * then run the initialiser, which is never charged (chapter 8, Charging).
 */
export const loadScript = (
  unit: CodeUnit,
  limits: Partial<Limits> = {},
  libraries: ReadonlyMap<string, Code> = new Map(),
  initialVariables: readonly Value[] = [],
  home?: Script,
  identity = '',
  functionGroup?: object,
): Script => {
  const script = new Script(
    unit,
    { ...defaultLimits, ...limits },
    home,
    identity,
  );
  script.functionGroup = functionGroup ?? home?.functionGroup;
  initialVariables.forEach((value, i) => {
    script.variables[i] = value;
  });
  script.link(libraries, script.home ?? script);
  unit.constants.forEach((_, i) => {
    const c = script.constants[i]!;
    if (c.k === 'value' && c.value.kind === 'pattern') {
      if (c.value.asPattern()!.program > script.limits.patternSize) {
        const at = unit.code.find(
          ins => ins.op === 'const' && ins.operands[0] === i,
        );
        throw new UnitLoadError(
          'pattern too large',
          at?.line ?? 1,
          at?.col ?? 1,
        );
      }
    }
  });
  const run = new Run(script, unit.bodies[0]!, [], {
    ...script.limits,
    fuelPerRun: Infinity,
    allocPerRun: Infinity,
  });
  run.charging = false;
  const outcome = run.finish();
  if (outcome.kind === 'errored') {
    const at = outcome.error.get('at');
    throw new UnitLoadError(
      'initialiser failed',
      Number(at.get('line').asDecimal()?.toString() ?? 1),
      Number(at.get('column').asDecimal()?.toString() ?? 1),
      outcome.error,
    );
  }
  return script;
};
/**
 * Load a Library's code unit, linked to the Libraries it imports: its
 * initialiser computes its Constants once, for every Group that holds it.
 */
export const loadLibrary = (
  unit: CodeUnit,
  libraries: ReadonlyMap<string, Code>,
  identity = '',
): Code => loadScript(unit, {}, libraries, [], undefined, identity);

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

type Iterator = {
  at: number;
  count: number;
  k: 'iterator';
  source: Value | null;
};
type Replacement = {
  at: number;
  cs: readonly string[];
  found: { end: number; start: number }[];
  k: 'replacement';
  matches: Value[];
  pieces: string[];
  subject: Value;
};
type Item = Value | Iterator | Replacement | Reader | Receiver;
// A Library Constant's Function Values are templates until used by a Script.
// Walk explicitly so nested constants and captures do not grow the JS stack.
const homeConstant = (root: Value, home: Script): Value => {
  if (root.kind !== 'function' && root.kind !== 'list' && root.kind !== 'map') {
    return root;
  }
  const values = home.boundConstants;
  const work = [{ value: root, ready: false }];
  while (work.length) {
    const { value, ready } = work.pop()!;
    if (values.has(value)) {
      continue;
    }
    const ref = value.asFunction();
    if (
      ref &&
      (ref.group !== undefined ||
        (ref.code as FunctionCode).home === home ||
        !(ref.code as FunctionCode).home.live)
    ) {
      values.set(value, value);
      continue;
    }
    const children =
      value.kind === 'list'
        ? listItems(value)
        : value.kind === 'map'
          ? value.entries().map(([, value]) => value)
          : ref
            ? ref.captures.map(([, value]) => value)
            : [];
    if (!ready && children.length) {
      work.push({ value, ready: true });
      for (const value of children) {
        work.push({ value, ready: false });
      }
      continue;
    }
    const get = (value: Value) => values.get(value)!;
    if (ref) {
      const { code, body } = ref.code as FunctionCode;
      const place =
        body.kind === 'lambda'
          ? ref.place.split(':').slice(-2).join(':')
          : body.name;
      values.set(
        value,
        functionValue({
          ...ref,
          group: home.functionGroup,
          home: home.name,
          displayHome: home.name,
          place: `${code.name}:${place}`,
          identity: `${home.name}#${code.identity || code.name}#${body.index}`,
          captures: ref.captures.map(([name, value]) => [name, get(value)]),
          code: { code, body, home } satisfies FunctionCode,
        }),
      );
    } else if (children.some(value => get(value) !== value)) {
      values.set(
        value,
        value.kind === 'list'
          ? listValues(children.map(get))
          : map(value.entries().map(([name, value]) => [name, get(value)])),
      );
    } else {
      values.set(value, value);
    }
  }
  return values.get(root)!;
};

// A Function Value's code: the code unit its body is in, and the body.
type FunctionCode = { body: Body; code: Code; home: Script };
type Dispatch = {
  args: Value[];
  clauses: Body[];
  code: Code;
  /**
   * A Delivery that may reach a Fallback Handler: its clauses, tried after
   * `clauses` with the message map, and the message's Selector (ADR 0064).
   */
  fallback?: { clauses: Body[]; selector: string };
  next: number;
};
type Frame = {
  activation?: boolean;
  body: Body;
  /** A clause's `clause` charge, added to its first instruction's. */
  clauseCharge: boolean;
  /** The code unit the body is in: the Script's own, or a Library's. */
  code: Code;
  dispatch: Dispatch | null;
  handler: string;
  locals: Value[];
  owner?: Frame;
  pc: number;
  stack: Item[];
};
type RecoveryDispatch = {
  activation?: Frame;
  at: CodePosition;
  boundary?: { frame: Frame; outer: RecoveryDispatch };
  cleanup?: Frame;
  cleanupEntry?: UnwindEntry;
  cleanupOnly: Set<Frame>;
  cursor: number;
  entry?: UnwindEntry;
  error: Value;
  excluded: Map<Frame, Set<string>>;
  exited: { entry: UnwindEntry; frame: Frame; index: number }[];
  owner?: Frame;
  pending?:
    | { kind: 'error' }
    | { frame: Frame; kind: 'catch'; pc: number; stack: Item[] }
    | {
        args: Value[];
        attempt: number;
        binds: number[];
        frame: Frame;
        kind: 'offer';
        pc: number;
        stack: Item[];
      };
  queue: { entry: UnwindEntry; frame: Frame; index: number }[];
  retained: Frame[];
  seen: Map<Frame, Set<number>>;
};
const requireSnapshot = (ok: unknown): void => {
  if (!ok) {
    throw new HostError('invalid save');
  }
};
const snapshotCounter = (n: number) => Number.isSafeInteger(n) && n >= 0;

// A `finally` block running because of an error: its frame, the error, and
// where its cleanup copy starts.
type Cleanup = { error: Value; frame: Frame; start: number };

/**
 * What happened in a Run that a Trace records: each raise, caught or not,
 * and each clause or branch a guard region skipped, with its error's code or
 * the value its Guard gave that wasn't a boolean.
 */
export type RunRecord =
  | {
      args: Value[];
      at: { pc: number; unit: string };
      attempt: number;
      kind: 'offer-chosen';
      name: string;
      target: { pc: number; unit: string };
    }
  | {
      attempt: number;
      kind: 'offer-entered';
      target: { pc: number; unit: string };
    }
  | {
      code?: string;
      col: number;
      kind: 'raise' | 'guard-skip';
      line: number;
      pc: number;
      unit: string;
      value?: Value;
    }
  | {
      args: Value[];
      automatic?: boolean;
      charged: number;
      error?: Value;
      id: string;
      kind: 'call';
      op: string;
      result?: Value;
    }
  | {
      action: 'opened' | 'closed' | 'abandoned' | 'failed';
      grant: string;
      id: string;
      kind: 'scope';
      name: string;
    }
  | {
      detail: string;
      grant: string;
      kind: 'effect-failure';
      phase: EffectFailure['phase'];
      scope?: string;
      segment: string;
      status: 'failed' | 'unknown';
    }
  | {
      grant: string;
      kind: 'effect';
      phase: 'begin' | 'commit' | 'rollback';
      segment: string;
      status: EffectResult['status'];
    }
  | { detail: string; id: string; kind: 'call-failed'; op: string }
  | { id: string; kind: 'abandon' }
  | { args: Value[]; kind: 'unhandled'; message: string; target: Value | null }
  | {
      error?: Value;
      kind: 'prop';
      name: string;
      object: Value;
      op: 'get' | 'set';
      value?: Value;
    }
  | {
      args: Value[];
      fn?: Value;
      /** The call id of a send that waits for its reply. */
      id?: string;
      /** A Join Member's send. */
      join?: boolean;
      kind: 'send';
      message?: string;
      to: string;
    };

// A call in flight: what its answer or failure needs at the call.
type CallContext = {
  adoptable?: boolean;
  declared: number;
  id: string;
  key: string;
  named: [string, Value][];
  op: Operation<unknown>;
  /** As the Trace names it, `<granted name>.<operation>`. */
  opName: string;
};
/** Why a Run suspended, which its Group waits on (chapter 5, Suspension Points). */
export type Suspension =
  | { k: 'wait'; ns: bigint }
  | { abort: AbortController; call: CallContext; k: 'ask'; ms: number }
  | { args: Value[]; id: string; k: 'send'; message: string; to: string }
  | { args: Value[]; fn: Value; id: string; k: 'call-value'; to: string }
  | { k: 'join'; members: Member[] }
  | WaitFor;
/**
 * A `wait for`, one-line or block: its `when` branches with their `from`
 * Scripts or objects and captures, its `after` branches' durations and its timeout,
 * each branch numbered from 1 in source order.
 */
export type WaitFor = {
  afters: { branch: number; ns: bigint }[];
  any: boolean;
  code: Code;
  k: 'wait-for';
  timeout: bigint | null;
  whens: {
    binds: number[];
    body: number | null;
    branch: number;
    captures: Value[];
    from: string | Value | null;
    message: string;
  }[];
};
/** A Join Member: its call id, and for a Capability call, its context. */
export type Member = {
  abort: AbortController | null;
  /** An answer that arrived early, which Persistent State counts. */
  answer?: Value;
  call: CallContext | null;
  id: string;
  ms: number;
  /** A Script reply received before its preempted Join closes. */
  reply?: Resumption;
};
/** What resumes a suspended Run. */
export type Resumption =
  | { k: 'wake' }
  | { code: 'call lost' | 'capability revoked'; k: 'restore-fail' }
  | { fuel: number; k: 'answer'; value: Value }
  | { detail?: string; error: HostScriptError | null; k: 'fail' }
  | { after: number; k: 'timeout' }
  | { k: 'reply'; value: Value }
  | { error: Value | null; k: 'send failed'; reason: string }
  | { answers: Resumption[]; k: 'joined' }
  | { binds: Value[]; branch: number; k: 'event'; message: Value }
  | { branch: number; k: 'event-timeout' }
  | { abandon: string[]; failure: Resumption; index: number; k: 'join-failed' };

/**
 * What a Run reaches outside its Script through, which its Group gives it:
 * the Script's Grants, the Pump's Clock reading, and other Scripts' mailboxes.
 */
export type RunHost = {
  /** Queues a suspending call's answer, as the Host Input `answer`. */
  answer(id: string, value: Value, fuel: number): void;
  /** Queues a foreign Function Value in its Home Script's mailbox. */
  callValue(fn: Value, args: Value[], reply: string): string;
  /** Land Stop and CancelRun after the crossing record, before conversion. */
  crossing?(): boolean;
  disableGrant(name: string): void;
  /**
   * Queues its failure, as `fail`; null fails with what isn't a Script error,
   * which `detail` describes for the `call failed` report.
   */
  fail(id: string, error: HostScriptError | null, detail?: string): void;
  readonly grants: ReadonlyMap<string, Grant<unknown>>;
  readonly group: import('./group').Group;
  isDisabled(name: string): boolean;
  isRevoked?(name: string): boolean;
  /** Whether a name is a Script of the Group. */
  isScript(name: string): boolean;
  isUnbound?(name: string): boolean;
  /** The object the Script owns, or Nothing. */
  readonly me: Value;
  readonly now: bigint;
  /** The well-known Host Object the Host bound to a name at load. */
  object(name: string): Value | undefined;
  /**
   * Puts a message in the mailbox of a Script, or of an object's nearest
   * Owning Script, or throws ScriptError `mailbox full`; `reply` is the call
   * id of a send that waits for its reply. Gives the Script it reached, or
   * null for a message no Script on its path takes.
   */
  send(
    to: string | ObjectState,
    message: string,
    args: Value[],
    reply: string | null,
  ): string | null;
  /** Sends a Command Call with no Handler up the Message Path, as `send` does. */
  sendUp(message: string, args: Value[], reply: string | null): string | null;
};
const listItems = (v: Value): Value[] =>
  Array.from({ length: v.length }, (_, i) => v.index(i + 1));

// The logical size of a stack item: a value's, or an internal value's,
// which counts what it holds (chapter 8, Sizes).
const itemSize = (item: Item): number => {
  if (isValue(item)) {
    return sizeOf(item);
  }
  switch (item.k) {
    case 'iterator':
      return partSize('iterator', 0, item.source ? sizeOf(item.source) : 0);
    case 'reader':
      return partSize('reader', 0, partSize('bytes', 0, item.bytes.length));
    case 'replacement':
      return partSize(
        'replacement',
        0,
        sizeOf(item.subject) + item.matches.reduce((t, v) => t + sizeOf(v), 0),
      );
    case 'receiver':
      return 0;
  }
};

// What the Host did wrong, for a `call failed` report's detail. Its wording
// is outside parity (chapter 9).
const hostDetail = (error: unknown): string =>
  error instanceof Error
    ? `${error.name}: ${error.message}`
    : `the Host threw ${typeof error === 'symbol' ? error.toString() : String(error)}`;
const resultDetail = (
  result: unknown,
  shape: Shape | undefined,
  group: object | undefined,
): string => {
  if (!Value.isValue(result)) {
    return 'its result is not a Value';
  }
  if (!functionsBelongTo([result], group)) {
    return 'its result holds a Function Value from another Group';
  }
  const bad = shape && mismatch(result, shape);
  if (bad) {
    const at = bad.path.length ? ` at ${bad.path.join('.')}` : '';
    return `its result breaks its Shape${at}: expected ${bad.expected}, got ${bad.got}`;
  }
  // Only a Standard Capability's own result rules remain.
  return 'its result breaks its Standard Capability’s rules';
};

// A path's step: a map key, or a 1-based list index.
const keyValue = (k: string | number): Value =>
  typeof k === 'number' ? dec(String(k)) : text(k);
// The keys a Host `Fail`'s Data may not use (chapter 6, the catalogue).
// The sends that pop a computed message name (ADR 0057).
// A spreading send pops its name, as text, and its arguments as one list
// (ADR 0064).
const spreadSends = new Set([
  'send-spread',
  'send-spread-wait',
  'join-send-spread',
]);
const namedSends = new Set([
  'send-named',
  'send-named-wait',
  'join-send-named',
  ...spreadSends,
]);
const reservedKeys = new Set([
  'code',
  'message',
  'at',
  'capability',
  'operation',
  'index',
  'during',
]);

// A Script named as a `send`'s receiver; a Script isn't a value (chapter 5).
type Receiver = { k: 'receiver'; name: string };
/** An instruction's code position and source position (chapter 9, Reports). */
export type CodePosition = {
  col: number;
  /** The frame's Handler, as an error's `at` names it. */
  handler: string;
  line: number;
  pc: number;
  /** The code unit the instruction is in. */
  unit: string;
};
export type Outcome =
  | { kind: 'completed'; passed?: boolean; result: Value; veto?: Value }
  /** `at` is the raise that no Unwind Table entry caught. */
  | { at: CodePosition; error: Value; kind: 'errored' }
  | {
      col: number;
      /** The faulting frame's Handler. */
      handler: string;
      kind: 'limit fault';
      limit: LimitName;
      line: number;
      pc: number;
      /** The Script Variables the rollback changed back, in declaration order. */
      rollback: string[];
      /** The code unit the faulting instruction is in. */
      unit: string;
    }
  | { effect: EffectFailure; kind: 'effect failed' }
  | { kind: 'unhandled' | 'dropped' }
  | {
      cleanupFailed?: { code: string } | { limit: LimitName };
      kind: 'cancelled';
    };

class LimitFaultError extends Error {
  constructor(
    readonly limit: LimitName,
    readonly pc: number,
  ) {
    super(limit);
  }
}
const iteratorItem = (source: Value | null, at: number): Value => {
  if (!source) {
    return nothing;
  }
  if (source.kind === 'list') {
    return source.index(at);
  }
  const start = BigInt(
    source.asRange()!.from.asDecimal()!.toString().split('.')[0]!,
  );
  return dec(String(start + BigInt(at - 1)));
};

const isValue = (item: Item | undefined): item is Value => Value.isValue(item);

// Scheduler callbacks last only for one step and are never saved with a Run.
const clauseChargeCallbacks = new WeakMap<Run, () => void>();

export class Run {
  /** Its id in the Trace, such as `orders/r2`, which its call ids extend. */
  id = '';
  /** Whether this Run holds a Decision’s open Verdict. */
  openVerdict = false;
  /** `the target`: the object its message was delivered to, or Nothing. */
  target: Value = nothing;
  host: RunHost | null = null;
  /** Why it suspended, until its Group resumes it. */
  suspended: Suspension | null = null;
  private resumption: Resumption | null = null;
  private abandoning: string[] = [];
  /** The calls a Limit Fault abandoned, which the Trace writes after it. */
  faultAbandons: string[] = [];
  /** The Join open in this Run, with the members it has started. */
  private join: {
    frame: Frame;
    members: Member[];
    replies?: { id: string; reply: Resumption }[];
    start: number;
  } | null = null;
  // What a woken Run had suspended on, until its resume.
  private waitedOn: Suspension | null = null;
  private calls = 0;
  private segment = 1;
  private scopes: {
    abandonName: string;
    grant: Grant<unknown>;
    grantName: string;
    name: string;
    op: ImmediateOp<unknown>;
  }[] = [];

  private participant: { grant: Grant<unknown>; grantName: string } | null =
    null;
  private participantAbandonment: EffectFailure | null = null;
  effectStateUnknown = false;

  get hasParticipant(): boolean {
    return this.participant !== null;
  }

  private lifecycle(phase: 'begin' | 'commit' | 'rollback'): EffectResult {
    const participant = this.participant!;
    const context: SegmentContext<unknown> = {
      group: this.host!.group,
      binding: participant.grant.binding,
      scriptName: this.script.name,
      runId: this.id,
      grantName: participant.grantName,
      segmentId: this.segmentId,
      now: this.host!.now,
    };
    let result: EffectResult;
    try {
      const returned = participant.grant.capability.lifecycle![phase](context);
      const status = returned?.status;
      const detail = returned?.detail;
      if (
        !['ok', 'failed', 'unknown'].includes(status) ||
        (detail !== undefined && typeof detail !== 'string')
      ) {
        throw new Error('Malformed lifecycle result');
      }
      result = { status, ...(detail === undefined ? {} : { detail }) };
    } catch (error) {
      result = { status: 'unknown', detail: hostDetail(error) };
    }
    this.records.push({
      kind: 'effect',
      grant: participant.grantName,
      segment: this.segmentId,
      phase,
      status: result.status,
    });
    if (result.status !== 'ok') {
      this.records.push({
        kind: 'effect-failure',
        grant: participant.grantName,
        segment: this.segmentId,
        phase,
        status: result.status,
        detail: result.detail ?? '',
      });
    }
    return result;
  }

  private effectFailure(
    phase: EffectFailure['phase'],
    result: EffectResult,
  ): EffectFailure {
    return {
      script: this.script.name,
      run: this.id,
      grant: this.participant!.grantName,
      segment: this.segmentId,
      phase,
      status: result.status as 'failed' | 'unknown',
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    };
  }

  private rollbackParticipant() {
    if (!this.participant) {
      return;
    }
    if (this.lifecycle('rollback').status !== 'ok') {
      this.effectStateUnknown = true;
    }
    this.participant = null;
    this.participantAbandonment = null;
    this.script.variables = [...this.segmentBase];
  }

  /** After charges/state checks, before any Segment outcome becomes visible. */
  finalizeEffects(rollback = false) {
    if (rollback || this.done) {
      this.abandonScopes();
    }
    if (!this.participant) {
      return;
    }
    if (
      rollback ||
      this.outcome?.kind === 'limit fault' ||
      (this.outcome?.kind === 'cancelled' &&
        this.outcome.cleanupFailed &&
        'limit' in this.outcome.cleanupFailed)
    ) {
      this.rollbackParticipant();
      return;
    }
    const abandonment = this.participantAbandonment;
    const result = abandonment ? null : this.lifecycle('commit');
    if (result?.status === 'ok') {
      this.participant = null;
      this.participantAbandonment = null;
      return;
    }
    const failure = abandonment ?? this.effectFailure('commit', result!);
    if (result?.status === 'unknown') {
      this.effectStateUnknown = true;
    }
    this.rollbackParticipant();
    const pending = this.discard();
    this.records.push(...pending.map(id => ({ kind: 'abandon' as const, id })));
    this.script.variables = [...this.segmentBase];
    this.outcome = { kind: 'effect failed', effect: failure };
  }

  get hasOpenScopes(): boolean {
    return this.scopes.length !== 0;
  }
  /** Still in the Segment it started in, so it can be rewound (ADR 0068). */
  get rewindable(): boolean {
    return (
      this.segment === 1 &&
      !this.done &&
      !this.cancelling &&
      !this.suspended &&
      !this.waitedOn &&
      !this.resumption &&
      !this.join
    );
  }
  get segmentId(): string {
    return `${this.id}.s${this.segment}`;
  }

  private checkScopeBoundary() {
    const scope = this.scopes.at(-1);
    if (scope) {
      throw new ScriptError(
        'scope open',
        [
          ['capability', text(scope.grantName)],
          ['scope', text(scope.name)],
        ],
        true,
      );
    }
  }

  /** Reserved Host cleanup, called by the Group before publishing termination. */
  abandonScopes(grantName?: string) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (grantName !== undefined && this.scopes[i]!.grantName !== grantName) {
        continue;
      }
      const scope = this.scopes.splice(i, 1)[0]!;
      const id = `${this.id}.c${++this.calls}`;
      let contractFailure = false;
      // eslint-disable-next-line unicorn/consistent-function-scoping -- Each attempt tracks forbidden calls even if the Host catches their error.
      const forbidden = (): never => {
        contractFailure = true;
        throw new HostError(
          'invalid value',
          'Automatic abandonment cannot charge, answer or fail',
        );
      };
      const call: Call<unknown> = {
        id,
        group: this.host!.group,
        runId: this.id,
        grantName: scope.grantName,
        segmentId: this.segmentId,
        scopeName: scope.name,
        automatic: true,
        binding: scope.grant.binding,
        scriptName: this.script.name,
        now: this.host!.now,
        signal: new AbortController().signal,
        charge: forbidden,
        answer: forbidden,
        fail: forbidden,
      };
      const record = {
        kind: 'call' as const,
        id,
        op: `${scope.grantName}.${scope.abandonName}`,
        args: [],
        charged: 0,
        automatic: true,
      };
      try {
        const result = scope.op.do(call);
        if (
          contractFailure ||
          !Value.isValue(result) ||
          result.kind !== 'nothing'
        ) {
          throw new HostError(
            'invalid value',
            'Automatic abandonment must return Nothing',
          );
        }
        this.records.push(
          { ...record, result },
          {
            kind: 'scope',
            id,
            grant: scope.grantName,
            name: scope.name,
            action: 'abandoned',
          },
        );
      } catch (error) {
        this.host!.disableGrant(scope.grantName);
        let failed = map([]);
        let status: 'failed' | 'unknown' = 'unknown';
        if (!contractFailure && error instanceof HostScriptError) {
          // Retain the Host answer for replay, without Script conversion costs.
          try {
            const data =
              Value.isValue(error.data) && error.data.kind === 'map'
                ? error.data
                : map([]);
            if (functionsBelongTo([data], this.script.functionGroup)) {
              failed = map([
                ['code', text(error.code)],
                ...(error.message
                  ? [['message', text(error.message)] as [string, Value]]
                  : []),
                ...data.entries(),
              ]);
              if (
                !(error.code in errorMessages) &&
                !data.entries().some(([key]) => reservedKeys.has(key)) &&
                (!scope.op.errors ||
                  scope.op.errors.some(e => e.code === error.code))
              ) {
                status = 'failed';
              }
            }
          } catch {
            // Malformed Host failure data is itself an unknown contract failure.
          }
        }
        this.records.push(
          { ...record, error: failed },
          {
            kind: 'scope',
            id,
            grant: scope.grantName,
            name: scope.name,
            action: 'failed',
          },
          {
            kind: 'effect-failure',
            phase: 'abandon',
            grant: scope.grantName,
            segment: this.segmentId,
            scope: scope.name,
            status,
            detail: hostDetail(error),
          },
        );
        if (this.participant?.grantName === scope.grantName) {
          this.participantAbandonment ??= {
            script: this.script.name,
            run: this.id,
            grant: scope.grantName,
            segment: this.segmentId,
            phase: 'abandon',
            scope: scope.name,
            status,
            detail: hostDetail(error),
          };
        }
      }
    }
  }
  private crossingCall: { abort: AbortController; id: string } | null = null;
  frames: Frame[] = [];
  fuel = 0;
  alloc = 0;
  charging = true;
  records: RunRecord[] = [];
  /**
   * The Script's Persistent State, measured at the Segment's end without this
   * Run, since a Run that is ending keeps nothing (chapter 6, Limits). The
   * Group adds what else the Script holds, such as its mailbox.
   */
  persistentState: () => number = () => this.script.variablesSize();
  /** The Script Variables when the Segment began, for rollback (ADR 0006). */
  segmentBase: Value[];
  private cleanups: Cleanup[] = [];
  private recoveries: RecoveryDispatch[] = [];
  private offerAttempt = 0;
  private outcome: Outcome | null = null;
  private entryError: 'wrong arity' | null = null;
  private m: Measured = {};
  private clause = 0;
  /** Its entry dispatch reached the Fallback Handler's clauses (ADR 0064). */
  private viaFallback = false;
  private during: Value = nothing;
  private cancellation:
    { entry: CodeUnit['unwind'][number]; frame: Frame }[] | null = null;
  private cancellationOwners: Frame[] = [];
  private cleanupFuel = 0;
  /** Calls abandoned when cancellation landed, traced after the cancel Segment. */
  cancellationAbandons: string[] = [];

  rebindCalls(): void {
    const s = this.suspended;
    const contexts =
      s?.k === 'ask'
        ? [s.call]
        : s?.k === 'join'
          ? s.members.flatMap(m => (m.call ? [m.call] : []))
          : this.openJoinCalls().map(m => m.call!);
    for (const context of contexts) {
      const [grant, operation] = context.opName.split('.');
      context.op = this.host!.grants.get(grant!)!.capability.operations.get(
        operation!,
      )!;
    }
  }

  /**
   * The Capability calls an open Join started and hasn't heard from, while a
   * Fuel Slice has preempted its body: they are pending too (chapter 8).
   */
  openJoinCalls(): Member[] {
    const join = this.join;
    if (!join || this.suspended || this.resumption) {
      return [];
    }
    return join.members.filter(m => m.call && !m.reply);
  }

  /** A pending call's context: the one suspended on, or an open Join's. */
  pendingCall(id: string): Pick<Member, 'abort' | 'call'> | undefined {
    const s = this.suspended;
    return s?.k === 'ask'
      ? s.call.id === id
        ? s
        : undefined
      : s?.k === 'join'
        ? s.members.find(m => m.id === id)
        : this.openJoinCalls().find(m => m.id === id);
  }

  callAdoptable(id: string): boolean {
    return this.pendingCall(id)?.call?.adoptable === true;
  }

  /** Reconnect the Host side of a saved suspending Operation. */
  restoredCall(
    id: string,
    grantName: string,
    args: Value[],
    reissue: boolean,
  ): { call: Call<unknown>; failure?: Resumption } {
    const suspension = this.suspended;
    const pending = this.pendingCall(id)!;
    const context = pending.call!;
    const abort = pending.abort!;
    const grant = this.host!.grants.get(grantName)!;
    let starting = false;
    let charged = 0;
    let reached = false;
    const call: Call<unknown> = {
      id,
      scriptName: this.script.name,
      group: this.host!.group,
      runId: this.id,
      grantName,
      segmentId: this.segmentId,
      automatic: false,
      binding: grant.binding,
      signal: abort.signal,
      get now() {
        return run.host!.now;
      },
      answer: (value, cost) => this.host!.answer(id, value, cost?.fuel ?? 0),
      fail: error =>
        error instanceof HostScriptError
          ? this.host!.fail(id, error)
          : this.host!.fail(id, null, hostDetail(error)),
      charge: fuel => {
        if (!starting || !Number.isSafeInteger(fuel) || fuel < 0) {
          throw new HostError('invalid value');
        }
        if (this.fuel + fuel > this.limits.fuelPerRun) {
          reached = true;
          throw new LimitReached();
        }
        this.fuel += fuel;
        charged += fuel;
      },
    };
    const run = this;
    if (!reissue) {
      return { call };
    }
    if (this.host!.isUnbound?.(grantName)) {
      return {
        call,
        failure: { k: 'restore-fail', code: 'capability revoked' },
      };
    }
    const op = grant.capability.operations.get(
      context.opName.slice(grantName.length + 1),
    )!;
    context.op = op;
    const record = { kind: 'call' as const, id, op: context.opName, args };
    starting = true;
    let failure: Resumption | undefined;
    try {
      if (op.mode !== 'suspending') {
        throw new Error('A saved call is not suspending');
      }
      if (op.start) {
        op.start(call, ...args);
      } else {
        this.forwardResult(op.run!(call, ...args), call);
      }
      this.records.push({ ...record, charged });
    } catch (error) {
      this.records.push({
        ...record,
        charged,
        ...(reached
          ? {}
          : {
              error:
                error instanceof HostScriptError
                  ? Value.isValue(error.data) && error.data.kind === 'map'
                    ? error.data
                    : map([])
                  : map([]),
            }),
      });
      if (!reached) {
        failure =
          error instanceof HostScriptError
            ? { k: 'fail', error }
            : { k: 'fail', error: null, detail: hostDetail(error) };
      }
    } finally {
      starting = false;
    }
    if (reached) {
      // The saved suspension committed its Segment. Reissue can't roll it back.
      // A preempted Join body keeps its saved segment base (chapter 10).
      if (suspension) {
        this.segmentBase = [...this.script.variables];
      }
      this.fault('fuelPerRun', this.frame.code.unit.code[this.frame.pc]!);
      if (suspension?.k === 'ask') {
        abort.abort();
        this.faultAbandons.push(id);
      }
      failure = { k: 'wake' };
    }
    return { call, ...(failure ? { failure } : {}) };
  }

  /** The plain machine state, without its Group's Host functions. */
  snapshot(): Record<string, unknown> {
    const { host: _host, persistentState: _state, ...state } = this;
    return state;
  }

  /** Allocate before linking shared frames and Join state from a save. */
  static empty(): Run {
    return Object.create(Run.prototype) as Run;
  }

  restore(state: Record<string, unknown>): void {
    Object.assign(this, state);
    this.host = null;
    this.persistentState = () => this.script.variablesSize();
  }

  /** Validate decoded control after the graph is complete, before Host rebinding. */
  validateSnapshot(knownCode: ReadonlySet<object>): void {
    try {
      this.validateControl(knownCode);
    } catch {
      throw new HostError('invalid save');
    }
  }

  private validateControl(knownCode: ReadonlySet<object>): void {
    requireSnapshot(
      snapshotCounter(this.offerAttempt) &&
        snapshotCounter(this.fuel) &&
        snapshotCounter(this.alloc),
    );
    requireSnapshot(
      Array.isArray(this.frames) && Array.isArray(this.recoveries),
    );
    requireSnapshot(
      Array.isArray(this.segmentBase) &&
        this.segmentBase.length === this.script.variables.length,
    );
    requireSnapshot(
      this.cancellation === null || Array.isArray(this.cancellation),
    );
    requireSnapshot(!this.cancelling || this.recoveries.length === 0);
    requireSnapshot(this.cancelling || this.cancellationOwners.length === 0);
    requireSnapshot(this.done || this.frames.length > 0);
    const frames = new Set<Frame>();
    const add = (f: Frame) => {
      requireSnapshot(f && typeof f === 'object');
      frames.add(f);
    };
    this.frames.forEach(add);
    this.cancellationOwners.forEach(add);
    this.cleanups.forEach(c => add(c.frame));
    this.cancellation?.forEach(c => add(c.frame));
    const contexts = new Set(this.recoveries);
    requireSnapshot(contexts.size === this.recoveries.length);
    for (const c of this.recoveries) {
      requireSnapshot(c && Array.isArray(c.retained) && c.retained.length > 0);
      requireSnapshot(
        snapshotCounter(c.cursor) && c.cursor < c.retained.length,
      );
      requireSnapshot(Value.isValue(c.error) && c.error.kind === 'map');
      requireSnapshot(
        Object.getPrototypeOf(c.seen) === Map.prototype &&
          Object.getPrototypeOf(c.excluded) === Map.prototype &&
          Object.getPrototypeOf(c.cleanupOnly) === Set.prototype,
      );
      requireSnapshot(Array.isArray(c.queue) && Array.isArray(c.exited));
      c.retained.forEach(add);
      if (c.owner) {
        add(c.owner);
      }
      if (c.activation) {
        add(c.activation);
      }
      if (c.cleanup) {
        add(c.cleanup);
      }
      if (c.pending && c.pending.kind !== 'error') {
        add(c.pending.frame);
      }
      c.queue.forEach(s => add(s.frame));
      c.exited.forEach(s => add(s.frame));
      c.seen.forEach((_, f) => add(f));
      c.excluded.forEach((_, f) => add(f));
      c.cleanupOnly.forEach(add);
    }
    // Include owner-only continuations, then reject cycles without recursion.
    for (const f of frames) {
      if (f.owner) {
        add(f.owner);
      }
    }
    const checkedOwners = new Set<Frame>();
    for (const f of frames) {
      requireSnapshot(
        knownCode.has(f.code) && f.code.unit.bodies.includes(f.body),
      );
      requireSnapshot(
        snapshotCounter(f.pc) && f.pc >= f.body.start && f.pc < f.body.end,
      );
      requireSnapshot(
        Array.isArray(f.locals) &&
          f.locals.length === f.body.locals.length &&
          f.locals.every(Value.isValue),
      );
      requireSnapshot(Array.isArray(f.stack));
      requireSnapshot(f.activation === undefined || f.activation === true);
      if (f.activation) {
        requireSnapshot(f.owner);
      }
      if (f.owner) {
        requireSnapshot(
          f.owner.code === f.code &&
            f.owner.body === f.body &&
            f.owner.locals === f.locals,
        );
      }
      const chain = new Set<Frame>();
      let owner: Frame | undefined = f;
      while (owner && !checkedOwners.has(owner)) {
        requireSnapshot(!chain.has(owner));
        chain.add(owner);
        owner = owner.owner;
      }
      chain.forEach(f => checkedOwners.add(f));
    }
    const entry = (f: Frame, e: UnwindEntry | undefined, kind: string) => {
      requireSnapshot(e && e.kind === kind && f.code.unit.unwind.includes(e));
      requireSnapshot(e!.start >= f.body.start && e!.end <= f.body.end);
    };
    const cleanup = (s: { entry: UnwindEntry; frame: Frame }) => {
      entry(s.frame, s.entry, 'finally');
      requireSnapshot(this.activeEntries(s.frame).includes(s.entry));
      requireSnapshot(s.frame.stack.length >= s.entry.depth);
    };
    this.cancellation?.forEach(cleanup);
    for (const [i, c] of this.recoveries.entries()) {
      if (c.boundary) {
        requireSnapshot(this.recoveries.slice(0, i).includes(c.boundary.outer));
        requireSnapshot(
          c.retained.includes(c.boundary.frame) && c.boundary.frame.activation,
        );
        requireSnapshot(
          c.boundary.outer.activation === c.boundary.frame ||
            c.boundary.outer.cleanup === c.boundary.frame,
        );
      }
      if (c.owner || c.entry) {
        requireSnapshot(c.owner === c.retained[c.cursor]);
        entry(c.owner!, c.entry, 'catch');
        requireSnapshot(
          this.activeEntries(c.owner!).includes(c.entry!) &&
            c.seen.get(c.owner!)?.has(c.entry!.target),
        );
      }
      if (c.activation) {
        requireSnapshot(
          c.activation.activation &&
            c.activation.owner === c.owner &&
            c.activation.pc >= c.entry!.target,
        );
      }
      if (!c.pending) {
        requireSnapshot(
          c.owner &&
            c.entry &&
            c.activation &&
            !c.cleanup &&
            !c.cleanupEntry &&
            c.queue.length === 0,
        );
        requireSnapshot(
          c.activation!.owner === c.owner && c.activation!.activation,
        );
      } else {
        requireSnapshot(['error', 'catch', 'offer'].includes(c.pending.kind));
        requireSnapshot(c.cleanup && c.cleanupEntry && c.exited.length > 0);
        entry(c.cleanup!, c.cleanupEntry, 'finally');
        requireSnapshot(
          c.cleanup!.pc >= c.cleanupEntry!.target &&
            c.cleanup!.pc <
              cleanupEnd(c.cleanup!.code.unit, c.cleanupEntry!.target),
        );
        const p = c.pending;
        if (p.kind !== 'error') {
          requireSnapshot(c.owner && c.entry && c.retained.includes(p.frame));
          requireSnapshot(
            snapshotCounter(p.pc) &&
              p.pc >= p.frame.body.start &&
              p.pc < p.frame.body.end &&
              Array.isArray(p.stack),
          );
          if (p.kind === 'catch') {
            requireSnapshot(
              p.frame === c.owner &&
                c.activation &&
                p.pc === c.activation.pc + 1 &&
                p.frame.code.unit.code[p.pc - 1]?.op === 'catch-accept',
            );
          } else {
            requireSnapshot(
              snapshotCounter(p.attempt) &&
                p.attempt > 0 &&
                p.attempt <= this.offerAttempt,
            );
            requireSnapshot(
              Array.isArray(p.args) &&
                p.args.every(Value.isValue) &&
                Array.isArray(p.binds) &&
                p.args.length === p.binds.length,
            );
            const target = this.activeEntries(p.frame).find(
              e =>
                e.kind === 'offer' &&
                p.frame.code.unit.offers?.[e.target]?.offers.some(
                  o =>
                    o.target === p.pc &&
                    o.binds.length === p.binds.length &&
                    o.binds.every((slot, j) => slot === p.binds[j]),
                ),
            );
            requireSnapshot(target && p.stack.length === target.depth);
          }
        }
      }
      const scopes = new Map<Frame, Set<UnwindEntry>>();
      for (const s of [...c.exited, ...c.queue]) {
        cleanup(s);
        requireSnapshot(
          snapshotCounter(s.index) &&
            (c.retained[s.index] === s.frame ||
              (s.index === c.retained.length &&
                s.frame.activation &&
                s.frame.owner === c.owner)),
        );
        const seen = scopes.get(s.frame) ?? new Set<UnwindEntry>();
        requireSnapshot(!seen.has(s.entry));
        seen.add(s.entry);
        scopes.set(s.frame, seen);
      }
      c.seen.forEach((targets, f) => {
        requireSnapshot(Object.getPrototypeOf(targets) === Set.prototype);
        targets.forEach(pc =>
          requireSnapshot(
            f.code.unit.unwind.some(
              e =>
                e.kind === 'catch' &&
                e.target === pc &&
                e.start >= f.body.start &&
                e.end <= f.body.end,
            ),
          ),
        );
      });
      c.excluded.forEach((keys, f) => {
        requireSnapshot(Object.getPrototypeOf(keys) === Set.prototype);
        keys.forEach(key =>
          requireSnapshot(
            f.code.unit.unwind.some(
              e =>
                this.entryKey(e) === key &&
                e.start >= f.body.start &&
                e.end <= f.body.end,
            ),
          ),
        );
      });
    }
    const attempts = new Set<number>();
    for (const r of this.records) {
      if (r.kind === 'offer-chosen') {
        requireSnapshot(
          snapshotCounter(r.attempt) &&
            r.attempt > 0 &&
            r.attempt <= this.offerAttempt &&
            !attempts.has(r.attempt),
        );
        attempts.add(r.attempt);
      }
    }
    let lastAttempt = 0;
    for (const attempt of attempts) {
      lastAttempt = Math.max(lastAttempt, attempt);
    }
    requireSnapshot(this.offerAttempt === lastAttempt);
  }

  get cancelling(): boolean {
    return this.cancellation !== null;
  }

  /** Drop a new Run immediately after dispatch, without entering its body. */
  drop() {
    if (this.charging && this.persistentState() > this.limits.persistentState) {
      this.fault('persistentState', this.frame.code.unit.code[this.frame.pc]!);
      return;
    }
    this.frames = [];
    this.outcome = { kind: 'dropped' };
  }

  /** Roll back the active Segment and abandon every pending call without unwinding. */
  discard(betweenSegments = false): string[] {
    const debug = machineDebug.get(this);
    if (debug) {
      debug.pending = null;
      debug.fault = null;
    }
    if (!betweenSegments && !this.suspended && !this.resumption && !this.done) {
      this.script.variables = [...this.segmentBase];
    }
    const pending = this.suspended;
    const members = this.resumption
      ? []
      : (this.join?.members.filter(m => m.answer === undefined && !m.reply) ??
        []);
    this.join = null;
    for (const member of members) {
      member.abort?.abort();
    }
    // Fail-fast abandonment happened at input drain, but its records would
    // normally wait for resume. Keep them when that resume is discarded.
    const ids = [
      ...this.cancellationAbandons,
      ...(this.resumption?.k === 'join-failed'
        ? this.resumption.abandon
        : members.map(m => m.id)),
    ];
    this.cancellationAbandons = [];
    if (this.crossingCall) {
      this.crossingCall.abort.abort();
      ids.push(this.crossingCall.id);
      this.crossingCall = null;
    }
    if (pending?.k === 'ask') {
      pending.abort.abort();
      ids.push(pending.call.id);
    } else if (pending?.k === 'send' || pending?.k === 'call-value') {
      ids.push(pending.id);
    }
    this.suspended = null;
    this.resumption = null;
    this.waitedOn = null;
    this.frames = [];
    this.recoveries = [];
    this.cleanups = [];
    this.cancellation = null;
    this.cancellationOwners = [];
    return ids;
  }

  /** Cancellation lands here; only finally copies are kept for the next turn. */
  cancel(betweenSegments = false) {
    if (this.cancelling || this.done) {
      return;
    }
    const blocks: { entry: UnwindEntry; frame: Frame }[] = [];
    const seen = new Map<Frame, Set<number>>();
    const scopeOwner = (frame: Frame, entry: UnwindEntry): Frame => {
      while (
        frame.owner &&
        this.activeEntries(frame.owner).some(
          e => e.kind === 'finally' && e.target === entry.target,
        )
      ) {
        frame = frame.owner;
      }
      return frame;
    };
    const remember = (frame: Frame, entry: UnwindEntry) => {
      const owner = scopeOwner(frame, entry);
      const targets = seen.get(owner) ?? new Set<number>();
      if (targets.has(entry.target)) {
        return false;
      }
      targets.add(entry.target);
      seen.set(owner, targets);
      return true;
    };
    // Entered cleanup scopes have already been left, even if cancellation
    // interrupts their copy. Retained failure PCs must not restart them.
    for (const context of this.recoveries) {
      for (const scope of context.exited) {
        remember(scope.frame, scope.entry);
      }
    }
    const controls = [
      ...this.frames.slice().reverse(),
      ...this.recoveries
        .slice()
        .reverse()
        .flatMap(c => c.retained.slice().reverse()),
    ];
    for (const frame of controls) {
      for (const entry of this.activeEntries(frame)) {
        if (
          entry.kind === 'finally' &&
          scopeOwner(frame, entry) === frame &&
          remember(frame, entry)
        ) {
          // Keep each iterator prefix while all copies share the owner locals.
          blocks.push({ frame, entry });
        }
      }
    }
    const depths = new Map<Frame, number>();
    for (const block of blocks) {
      depths.set(
        block.frame,
        Math.max(depths.get(block.frame) ?? 0, block.entry.depth),
      );
    }
    for (const [frame, depth] of depths) {
      frame.stack = frame.stack.slice(0, depth);
    }
    const owners = [...new Set(blocks.map(b => this.realOwner(b.frame)))];
    for (const owner of owners) {
      if (!blocks.some(b => b.frame === owner)) {
        owner.stack = [];
      }
    }
    if (this.participant) {
      this.abandonScopes(this.participant.grantName);
      this.rollbackParticipant();
    }
    this.cancellationAbandons = this.discard(betweenSegments);
    this.segment++;
    this.cancellation = blocks;
    this.cancellationOwners = owners;
    this.cleanups = [];
    this.frames = [];
    this.beginCleanupSegment();
    this.nextCancellationCleanup();
  }

  /** Other Runs may have committed since cancellation made this Run ready. */
  beginCleanupSegment() {
    this.segmentBase = [...this.script.variables];
  }

  /** A parked Run resumes after dispatch, with no resumption instruction. */
  beginReadySegment() {
    if (!this.resumption) {
      this.segmentBase = [...this.script.variables];
    }
  }

  park(): boolean {
    if (this.persistentState() + this.size() > this.limits.persistentState) {
      this.fault('persistentState', this.frame.code.unit.code[this.frame.pc]!);
      return false;
    }
    return true;
  }

  private nextCancellationCleanup() {
    const block = this.cancellation!.shift();
    const owners = new Set(
      [...(block ? [block] : []), ...this.cancellation!].map(b =>
        this.realOwner(b.frame),
      ),
    );
    this.cancellationOwners = this.cancellationOwners.filter(f =>
      owners.has(f),
    );
    if (!block) {
      this.frames = [];
      this.outcome = { kind: 'cancelled' };
      return;
    }
    const { frame, entry } = block;
    frame.pc = entry.target;
    frame.stack.length = entry.depth;
    frame.clauseCharge = false;
    this.frames = [frame];
  }

  /** The failed Run’s message for an internally queued error Delivery. */
  setDuring(value: Value) {
    this.during = value;
    for (const f of this.frames) {
      if (f.body.duringSlot !== undefined) {
        f.locals[f.body.duringSlot] = value;
      }
    }
  }

  constructor(
    readonly script: Script,
    entry: Body | Body[],
    args: Value[],
    readonly limits: Limits = script.limits,
    code: Code = script,
    /** The Selector of a Delivery that may reach a Fallback Handler. */
    fallback?: string,
  ) {
    this.segmentBase = [...script.variables];
    const clauses = Array.isArray(entry) ? entry : [entry];
    if (!Array.isArray(entry)) {
      this.push(code, entry, args, null);
    } else if (
      !this.dispatch({
        clauses,
        code: script,
        next: 0,
        args,
        ...(fallback !== undefined && script.fallback.length
          ? { fallback: { clauses: script.fallback, selector: fallback } }
          : {}),
      })
    ) {
      this.outcome = { kind: 'unhandled' };
    }
  }

  /** Whether a Fallback Handler clause runs, or is being tried (ADR 0064). */
  get fallback(): boolean {
    return this.viaFallback;
  }

  /** A mailbox call has no Handler Clause and starts in the value's code unit. */
  static fromFunction(
    script: Script,
    fn: Value,
    args: Value[],
    limits: Limits,
  ): Run {
    const ref = fn.asFunction()!;
    const { code, body } = ref.code as FunctionCode;
    const arity = arityOf(body);
    const run = new Run(script, body, args, limits, code);
    if (args.length < arity.min || args.length > arity.max) {
      run.entryError = 'wrong arity';
    } else {
      const filled =
        body.kind === 'lambda' ? args : run.fillDefaults(code, body, args);
      filled.forEach((value, i) => {
        run.frame.locals[i + 1] = value;
      });
      ref.captures.forEach(([, value], i) => {
        run.frame.locals[body.captureStart + i] = value;
      });
    }
    return run;
  }

  /** The clause number the Run's dispatch chose, or is trying. */
  get clauseNumber(): number {
    return this.clause;
  }

  /** A successful entry dispatch, at its first body instruction. */
  get selectedClause(): Body | null {
    const f = this.frames[0];
    return f && f.pc === f.body.acceptedAt ? f.body : null;
  }

  /** Whether entry dispatch still shares its charge with a body instruction. */
  get clauseChargePending(): boolean {
    return this.frames[0]?.clauseCharge === true;
  }

  /** Empty parameter/Guard regions still pay the clause's dispatch rate. */
  acceptClause(dispatchOnly: boolean): boolean {
    if (this.frame.clauseCharge) {
      try {
        const fuel = charge('clause').fuel;
        if (this.fuel + fuel > this.limits.fuelPerRun) {
          throw new LimitFaultError('fuelPerRun', this.frame.pc);
        }
        // A body instruction pays the clause rate alongside its own cost;
        // parking and dropping have no body instruction to pay it.
        if (dispatchOnly) {
          this.payAmount(fuel, 0);
        }
      } catch (error) {
        if (!(error instanceof LimitFaultError)) {
          throw error;
        }
        this.fault(error.limit, this.frame.code.unit.code[this.frame.pc]!);
        return false;
      }
    }
    return true;
  }

  /** Run to the end of the Run. */
  finish(): Outcome {
    while (!this.outcome) {
      if (this.suspended) {
        throw new NotImplementedError('a suspended Run outside a Group');
      }
      this.step();
    }
    return this.outcome;
  }

  get done(): boolean {
    return this.outcome !== null;
  }

  /** How the Run ended, once it has. */
  get ended(): Outcome | null {
    return this.outcome;
  }

  // ------------------------------------------------------------- frames

  private push(
    code: Code,
    body: Body,
    args: Value[],
    dispatch: Dispatch | null,
  ) {
    const locals: Value[] = Array.from(
      { length: body.locals.length },
      () => nothing,
    );
    args.forEach((v, i) => {
      locals[i + 1] = v;
    });
    if (body.duringSlot !== undefined) {
      locals[body.duringSlot] = this.during;
    }
    this.frames.push({
      body,
      code: code === this.script ? this.script.codeFor(body) : code,
      pc: body.start,
      locals,
      stack: [],
      dispatch,
      clauseCharge:
        (body.kind === 'handler' || body.kind === 'fallback') &&
        dispatch !== null,
      handler:
        body.kind === 'lambda'
          ? body.name.replace(/(?::\d+:\d+)+$/, '')
          : body.name,
    });
  }

  // Push the next clause whose parameter count matches, or report none.
  // When a Delivery's clauses are exhausted, its Fallback Handler's are
  // tried next, with the message map as their one argument, built without
  // charge (chapter 8, Handlers).
  private dispatch(d: Dispatch): boolean {
    for (;;) {
      while (d.next < d.clauses.length) {
        const body = d.clauses[d.next++]!;
        if (body.params.length === d.args.length) {
          // The Run's clause is its entry Handler's, not a called Handler's.
          if (!this.frames.length) {
            this.clause = body.clause ?? 0;
          }
          this.push(d.code, body, d.args, d);
          return true;
        }
      }
      if (!d.fallback) {
        return false;
      }
      const { clauses, selector } = d.fallback;
      delete d.fallback;
      d.clauses = clauses;
      d.next = 0;
      d.args = [
        map([
          ['name', text(selector)],
          ['args', listValues(d.args)],
        ]),
      ];
      this.viaFallback = true;
    }
  }

  /** Whether a dispatch has a clause left to try after the current one. */
  private static more(d: Dispatch | null): boolean {
    return (
      !!d &&
      (!!d.fallback?.clauses.length ||
        d.clauses.slice(d.next).some(b => b.params.length === d.args.length))
    );
  }

  private get frame(): Frame {
    return this.frames.at(-1)!;
  }

  /** Tooling-only control views; never part of Inspect or saved state. */
  debugFrames(): {
    frame: Frame;
    owner?: number;
    role?: 'retained' | 'dispatch';
  }[] {
    const retained = new Set(this.recoveries.flatMap(c => c.retained));
    const frames: Frame[] = [];
    // Transfer cleanup can execute after its owner leaves the active stack.
    const add = (frame: Frame) => {
      if (!frames.includes(frame)) {
        if (frame.owner) {
          add(frame.owner);
        }
        frames.push(frame);
      }
    };
    for (const frame of [...retained, ...this.frames]) {
      add(frame);
    }
    return frames.map(frame => ({
      frame,
      ...(frame.owner ? { owner: frames.indexOf(this.realOwner(frame)) } : {}),
      ...(retained.has(frame) || !this.frames.includes(frame)
        ? { role: 'retained' as const }
        : frame.owner
          ? { role: 'dispatch' as const }
          : {}),
    }));
  }

  // ------------------------------------------------------------- charging

  /** Charge an instruction, faulting before it does anything if it can't pay. */
  private pay(key: string, measured: Measured = this.m, allocation = 0) {
    if (!this.charging) {
      return;
    }
    const frame = this.frame;
    const own = charge(key, measured);
    this.payAmount(
      own.fuel + (frame.clauseCharge ? charge('clause').fuel : 0),
      own.alloc + allocation,
    );
  }

  // Charge an amount, faulting at the current instruction if it can't pay.
  private payAmount(fuel: number, alloc: number) {
    if (!this.charging) {
      return;
    }
    const frame = this.frame;
    if (
      this.cancelling
        ? this.cleanupFuel + fuel > this.limits.cleanupBudget
        : this.fuel + fuel > this.limits.fuelPerRun
    ) {
      throw new LimitFaultError(
        this.cancelling ? 'cleanupBudget' : 'fuelPerRun',
        frame.pc,
      );
    }
    if (this.alloc + alloc > this.limits.allocPerRun) {
      throw new LimitFaultError('allocPerRun', frame.pc);
    }
    const entryCharge = frame.clauseCharge && frame === this.frames[0];
    frame.clauseCharge = false;
    this.fuel += fuel;
    if (this.cancelling) {
      this.cleanupFuel += fuel;
    }
    this.alloc += alloc;
    if (entryCharge) {
      const paid = clauseChargeCallbacks.get(this);
      clauseChargeCallbacks.delete(this);
      paid?.();
    }
  }

  // ------------------------------------------------------------- stepping

  private pop(): Value {
    const item = this.frame.stack.pop();
    if (!isValue(item)) {
      throw new Error('expected a value on the stack');
    }
    return item;
  }
  private popN(n: number): Value[] {
    const items = this.frame.stack.splice(this.frame.stack.length - n, n);
    if (!items.every(isValue)) {
      throw new Error('expected values on the stack');
    }
    return items;
  }
  private reader(): Reader {
    const item = this.frame.stack.at(-1);
    if (!item || isValue(item) || item.k !== 'reader') {
      throw new Error('expected a reader on the stack');
    }
    return item;
  }
  private peek(n = 0): Value {
    const item = this.frame.stack.at(-1 - n);
    if (!isValue(item)) {
      throw new Error('expected a value on the stack');
    }
    return item;
  }

  step(clausePaid?: () => void) {
    if (clausePaid) {
      clauseChargeCallbacks.set(this, clausePaid);
    }
    const frame = this.frame;
    const ins = frame.code.unit.code[frame.pc]!;
    // A Built-in call is charged by that Built-in's rate, when it raises too.
    const key =
      ins.op === 'call-builtin'
        ? `builtin.${ins.operands[0]}`
        : instructionSpec.get(ins.op)!.cost;
    this.m = {};
    const resumption = this.resumption;
    this.resumption = null;
    try {
      if (this.entryError) {
        const code = this.entryError;
        this.entryError = null;
        // The function was never entered: its catch/finally regions cannot
        // see an invalid Host argument count, and no instruction is charged.
        const error = this.errorMap(code, [], ins);
        const finish = () => {
          this.records.push({
            kind: 'raise',
            code,
            unit: frame.code.name,
            pc: frame.pc,
            line: ins.line,
            col: ins.col,
          });
          this.frames = [];
          this.outcome = {
            kind: 'errored',
            error,
            at: {
              unit: frame.code.name,
              handler: frame.handler,
              pc: frame.pc,
              line: ins.line,
              col: ins.col,
            },
          };
        };
        if (!deferFault(this, { reason: 'error', error }, finish)) {
          finish();
        }
        return;
      }
      if (resumption) {
        this.resume(resumption);
      } else {
        this.execute(ins, key);
      }
    } catch (error) {
      if (error instanceof CrossingInterruptedError) {
        // Cancellation has already installed cleanup, or Stop discarded the Run.
      } else if (error instanceof ScriptError) {
        this.raiseCore(error, ins, key);
      } else if (error instanceof ThrownError) {
        this.unwind(error.error, ins);
      } else if (error instanceof LimitFaultError) {
        this.fault(error.limit, ins);
      } else {
        throw error;
      }
    } finally {
      clauseChargeCallbacks.delete(this);
    }
    this.finishInstruction();
  }

  /** Internal: also called after a debug-deferred unwind. */
  finishInstruction() {
    if (machineDebug.get(this)?.pending) {
      return;
    }
    // An abandoned call is written after the raise that reports it.
    for (const id of this.abandoning) {
      this.records.push({ kind: 'abandon', id });
    }
    this.abandoning = [];
  }

  /** TS tooling: a resumption consumes the suspension instruction, not a new statement. */
  get resumingInstruction(): boolean {
    return this.resumption !== null;
  }

  /** Retain a reply while a Fuel Slice has preempted an open Join's body. */
  replyToOpenJoin(id: string, reply: Resumption): boolean {
    const join = this.join;
    if (!join || this.suspended || this.resumption) {
      return false;
    }
    const member = join.members.find(m => m.id === id && !m.reply);
    if (!member) {
      return false;
    }
    member.reply = reply;
    if (reply.k === 'reply' || reply.k === 'answer') {
      member.answer = reply.value;
    }
    (join.replies ??= []).push({ id, reply });
    return true;
  }

  /** Replay buffered replies in arrival order once the Join starts waiting. */
  takeJoinReplies(): { id: string; reply: Resumption }[] {
    const replies = this.join?.replies ?? [];
    if (this.join) {
      this.join.replies = [];
    }
    return replies;
  }

  /** Make a suspended Run ready: its next step resumes it with `r`. */
  wake(r: Resumption) {
    this.resumption = r;
    this.waitedOn = this.suspended;
    this.suspended = null;
  }

  // Suspend at the current instruction, a Segment's end: Persistent State,
  // this Run's frames included, is measured first (chapter 6, Limits).
  private suspend(s: Suspension) {
    // Measure the prospective suspension without installing it: a fault must
    // still roll back this Segment, while preserving already-started crossings.
    if (
      this.charging &&
      this.persistentState() + this.size(s) > this.limits.persistentState
    ) {
      if (s.k === 'ask') {
        s.abort.abort();
        this.faultAbandons.push(s.call.id);
      } else if (s.k === 'send' || s.k === 'call-value') {
        this.faultAbandons.push(s.id);
      }
      throw new LimitFaultError('persistentState', this.frame.pc);
    }
    this.suspended = s;
  }

  /**
   * Resume at the instruction the Run suspended at, in a new Segment: an
   * answer is checked and its conversion charged by that instruction's rate,
   * then pushed; a failure or timeout raises there (chapter 8, Charging).
   */
  private resume(r: Resumption) {
    const s = this.waitedOn!;
    this.waitedOn = null;
    this.segment++;
    this.segmentBase = [...this.script.variables];
    const frame = this.frame;
    if (s.k === 'wait-for') {
      // The message, or Nothing, and for a block its branch's number.
      if (r.k === 'event') {
        const when = s.whens.find(w => w.branch === r.branch)!;
        when.binds.forEach((slot, i) => {
          frame.locals[slot] = r.binds[i]!;
        });
      }
      frame.stack.push(r.k === 'event' ? r.message : nothing);
      if (s.any) {
        frame.stack.push(dec(String((r as { branch: number }).branch)));
      }
      frame.pc++;
      return;
    }
    if (s.k === 'join') {
      this.join = null;
      if (r.k === 'join-failed') {
        // Failing fast: the first failure, with its member's `index`.
        this.abandoning = r.abandon;
        try {
          this.settled(s.members[r.index - 1]!.call, r.failure);
        } catch (error) {
          throw this.withIndex(error, r.index);
        }
      }
      const answers = (r as Extract<Resumption, { k: 'joined' }>).answers;
      const values = s.members.map((m, i) => {
        try {
          return this.settled(m.call, answers[i]!);
        } catch (error) {
          throw this.withIndex(error, i + 1);
        }
      });
      const result = listValues(values);
      const all = charge('join', { result });
      const before = charge('join', {});
      this.payAmount(all.fuel - before.fuel, all.alloc - before.alloc);
      frame.stack.push(result);
      frame.pc++;
      return;
    }
    if (r.k === 'timeout') {
      this.abandoning =
        s.k === 'ask'
          ? [s.call.id]
          : s.k === 'send' || s.k === 'call-value'
            ? [s.id]
            : [];
    }
    const value = this.settled(s.k === 'ask' ? s.call : null, r);
    if (s.k !== 'wait') {
      frame.stack.push(value);
    }
    frame.pc++;
  }

  // What one call's resumption gives: its value, or the error it raises. An
  // answer is checked against its Shape, then its conversion and any late
  // cost charged (chapter 8, Charging).
  private settled(call: CallContext | null, r: Resumption): Value {
    switch (r.k) {
      case 'wake':
        return nothing;
      case 'restore-fail':
        throw new ScriptError(r.code, call?.named ?? [], true);
      case 'reply':
        return r.value;
      case 'send failed':
        throw new ScriptError(
          'send failed',
          [
            ['reason', text(r.reason)],
            ...(r.error ? [['error', r.error] as [string, Value]] : []),
          ],
          true,
        );
      case 'timeout':
        throw new ScriptError(
          'timeout',
          [
            ['after', quantity(dec(String(r.after)), 'ms')],
            ...(call?.named ?? []),
          ],
          true,
        );
      case 'fail':
        throw this.failure(call!, r.error, () => {}, r.detail);
      case 'answer':
        if (
          !functionsBelongTo([r.value], this.script.functionGroup) ||
          (call!.op.result && mismatch(r.value, call!.op.result))
        ) {
          throw this.hostError(
            call!,
            resultDetail(r.value, call!.op.result, this.script.functionGroup),
          );
        }
        this.payConversion(call!, r.value, r.fuel);
        return r.value;
    }
    throw new Error(`a Join's resumption for one call: ${r.k}`);
  }

  // A Join member's error, with `index` added at its end (chapter 6).
  private withIndex(error: unknown, index: number): unknown {
    const ins = this.frame.code.unit.code[this.frame.pc]!;
    const map0 =
      error instanceof ScriptError
        ? this.errorMap(error.code, error.fields, ins)
        : error instanceof ThrownError
          ? error.error
          : null;
    if (!map0) {
      return error;
    }
    const indexed = map([...map0.entries(), ['index', dec(String(index))]]);
    if (coreRaised.has(map0)) {
      coreRaised.add(indexed);
    }
    return new ThrownError(indexed);
  }

  /**
   * Whether a message a `wait for` is waiting on fires one of its `when`
   * branches: the first in source order whose message, `from` and test
   * match. The test runs on its own, and its Fuel and allocation count
   * toward this Run (chapter 8, The event table).
   */
  matchEvent(
    message: string,
    args: Value[],
    from: string | null,
    target: Value = nothing,
  ): Extract<Resumption, { k: 'event' }> | null {
    const s = this.suspended;
    if (s?.k !== 'wait-for') {
      return null;
    }
    for (const when of s.whens) {
      if (
        when.message !== message ||
        (when.from !== null &&
          (typeof when.from === 'string'
            ? when.from !== from
            : !when.from.equals(target)))
      ) {
        continue;
      }
      let binds: Value[] = [];
      if (when.body === null) {
        if (args.length) {
          continue;
        }
      } else {
        const body = s.code.unit.bodies[when.body]!;
        if (body.params.length !== args.length) {
          continue;
        }
        // As a one-clause dispatch, so a failed test ends `unhandled`.
        const test = new Run(this.script, [body], args, {
          ...this.limits,
          fuelPerRun: Infinity,
          allocPerRun: Infinity,
        });
        when.captures.forEach((v, i) => {
          test.frames[0]!.locals[body.captureStart + i] = v;
        });
        const outcome = test.finish();
        this.fuel += test.fuel;
        this.alloc += test.alloc;
        this.records.push(...test.records);
        if (outcome.kind !== 'completed') {
          continue;
        }
        binds = listItems(outcome.result);
      }
      return {
        k: 'event',
        branch: when.branch,
        binds,
        message: map([
          ['name', text(message)],
          ['args', listValues(args)],
        ]),
      };
    }
    return null;
  }

  /**
   * `the p of o` on a Host Object (chapter 4, Keys): its Core-held `id`, or
   * the Host's property, charged as a Capability result is, recorded as
   * `prop`. A key its Object Kind doesn't define gives Nothing.
   */
  private getProperty(v: Value, name: string, key: string): Value {
    const o = stateOf(v)!;
    if (name === 'id') {
      const id = text(o.handle.id);
      this.pay(key, { result: id });
      return id;
    }
    const guard = this.frame.code.unit.unwind.some(
      e =>
        e.kind === 'guard' && this.frame.pc >= e.start && this.frame.pc < e.end,
    );
    if (guard) {
      throw wrongKind('map', v);
    }
    if (o.disposed) {
      throw new ScriptError('object gone', [['object', v]]);
    }
    const prop = o.handle.kind.props.get(name);
    if (!prop) {
      this.pay(key);
      return nothing;
    }
    const ctx = this.propContext(o, name, prop.getCost);
    this.pay(key);
    this.payAmount(ctx.declared, prop.getCost?.alloc ?? 0);
    let result: unknown;
    try {
      result = prop.get(o.handle);
    } catch (error) {
      throw this.failure(
        ctx,
        error instanceof HostScriptError ? error : null,
        failed =>
          this.recordCrossing({
            kind: 'prop',
            object: v,
            name,
            op: 'get',
            error: failed,
          }),
      );
    }
    if (
      !Value.isValue(result) ||
      !functionsBelongTo([result], this.script.functionGroup) ||
      (prop.shape && mismatch(result, prop.shape))
    ) {
      this.recordCrossing({
        kind: 'prop',
        object: v,
        name,
        op: 'get',
        error: map([]),
      });
      throw this.hostError(
        ctx,
        resultDetail(result, prop.shape, this.script.functionGroup),
      );
    }
    this.recordCrossing({
      kind: 'prop',
      object: v,
      name,
      op: 'get',
      value: result,
    });
    this.payConversion(ctx, result, 0);
    return result;
  }

  /** `set the p of o to v`: the Host's `Set`, after the value's Shape check. */
  private setProperty(v: Value, name: string, value: Value, key: string) {
    const o = stateOf(v);
    if (!o) {
      throw wrongKind('object', v);
    }
    if (o.disposed) {
      throw new ScriptError('object gone', [['object', v]]);
    }
    const prop = o.handle.kind.props.get(name);
    if (!prop?.set) {
      throw new ScriptError('read only');
    }
    const bad = prop.shape && mismatch(value, prop.shape);
    if (bad) {
      throw new ScriptError(
        'wrong kind',
        [
          ['expected', text(bad.expected)],
          ['got', text(bad.got)],
          ['value', bad.value],
        ],
        true,
      );
    }
    const ctx = this.propContext(o, name, prop.setCost);
    this.pay(key, { input: value });
    this.payAmount(ctx.declared, prop.setCost?.alloc ?? 0);
    try {
      prop.set(o.handle, value);
    } catch (error) {
      throw this.failure(
        ctx,
        error instanceof HostScriptError ? error : null,
        failed =>
          this.recordCrossing({
            kind: 'prop',
            object: v,
            name,
            op: 'set',
            value,
            error: failed,
          }),
      );
    }
    this.recordCrossing({ kind: 'prop', object: v, name, op: 'set', value });
  }

  // A property call's context, for its failures and conversion: as an
  // Operation's, with the Object Kind as its Capability (chapter 9).
  private propContext(
    o: ObjectState,
    name: string,
    cost: { alloc?: number; fuel: number } | undefined,
  ): CallContext {
    return {
      id: '',
      op: { mode: 'immediate', cost: cost ?? { fuel: 0 }, do: () => nothing },
      key: 'capability',
      named: [
        ['capability', text(o.handle.kind.name)],
        ['operation', text(name)],
      ],
      declared: cost?.fuel ?? 0,
      opName: `${o.handle.kind.name}.${name}`,
    };
  }

  // A member past `MaxJoin` is a Limit Fault, checked before its charge.
  private joinWidth() {
    if (this.join!.members.length + 1 > this.limits.maxJoin) {
      throw new LimitFaultError('maxJoin', this.frame.pc);
    }
  }

  /** Its logical size, as Persistent State counts a suspended Run (chapter 8). */
  size(s: Suspension | null = this.suspended ?? this.waitedOn): number {
    let frames = 0;
    const retained = new Set([
      ...this.frames,
      ...this.recoveries.flatMap(c => [
        ...c.retained,
        ...(c.activation ? [c.activation] : []),
      ]),
      ...(this.cancellation ?? []).map(c => c.frame),
      ...this.cancellationOwners,
    ]);
    const cleanupOwners = new Set(
      this.recoveries.flatMap(c =>
        c.cleanup && !c.cleanup.activation ? [c.cleanup.owner!] : [],
      ),
    );
    for (const f of retained) {
      const stack = f.stack.reduce((total, item) => total + itemSize(item), 0);
      if (cleanupOwners.has(f)) {
        // Cleanup shares owner locals, but the failed operand stack is retained.
        frames += stack;
        continue;
      }
      frames += f.activation
        ? 48 + stack
        : partSize(
            'frame',
            f.locals.length,
            stack + f.locals.reduce((t, v) => t + sizeOf(v), 0),
          );
    }
    for (const c of this.recoveries) {
      const args = c.pending?.kind === 'offer' ? c.pending.args : [];
      frames +=
        96 +
        8 * args.length +
        sizeOf(c.error) +
        args.reduce((t, v) => t + sizeOf(v), 0);
    }
    // Each pending call, and a Join's early answers.
    let calls = 0;
    if (this.resumption) {
      calls = resumptionSize(this.resumption);
    } else if (s?.k === 'ask' || s?.k === 'send' || s?.k === 'call-value') {
      calls = partSize('pending call', 0, 0);
    } else if (s?.k === 'wait-for') {
      for (const when of s.whens) {
        if (Value.isValue(when.from)) {
          calls += sizeOf(when.from);
        }
        calls += when.captures.reduce((t, v) => t + sizeOf(v), 0);
      }
    } else if (s?.k === 'join' || this.join) {
      // The Join already owns its members before suspension is installed,
      // and keeps them across preemption while its body is still open.
      const members = s?.k === 'join' ? s.members : this.join!.members;
      for (const member of members) {
        calls += member.reply
          ? resumptionSize(member.reply)
          : member.answer
            ? sizeOf(member.answer)
            : partSize('pending call', 0, 0);
      }
    }
    return partSize('run', 0, calls + frames);
  }

  // An error caught outside an open Join's body, or not caught, abandons the
  // members it started, each written after the raise (chapter 5, Joins).
  private leaveJoin(handler: number, target: number | undefined) {
    const join = this.join;
    if (!join) {
      return;
    }
    const at = this.frames.indexOf(join.frame);
    if (handler > at) {
      return;
    }
    if (handler === at && target !== undefined) {
      const code = join.frame.code.unit.code;
      let end = join.start;
      while (end < code.length && code[end]!.op !== 'join-end') {
        end++;
      }
      if (target > join.start && target <= end) {
        return;
      }
    }
    for (const id of this.abandonJoin()) {
      this.records.push({ kind: 'abandon', id });
    }
  }

  // Abandon the open Join's members, signalling their Capability calls.
  private abandonJoin(): string[] {
    const members = (this.join?.members ?? []).filter(
      member => member.answer === undefined && !member.reply,
    );
    this.join = null;
    for (const member of members) {
      member.abort?.abort();
    }
    return members.map(member => member.id);
  }

  private fault(limit: LimitName, ins: Instruction) {
    if (
      deferFault(this, { reason: 'limitFault', limit }, () =>
        this.faultNow(limit, ins),
      )
    ) {
      return;
    }
    this.faultNow(limit, ins);
  }

  private faultNow(limit: LimitName, ins: Instruction) {
    this.recoveries = [];
    this.cancellationOwners = [];
    if (this.cancellation) {
      this.cancellation = [];
    }
    // A Join's members are abandoned, after the fault (chapter 5, Joins).
    this.faultAbandons.push(...this.abandonJoin());
    const code = this.frame.code;
    const handler = this.frame.handler;
    const rollback = this.script.variableNames.filter(
      (_, i) => !this.script.variables[i]!.equals(this.segmentBase[i]!),
    );
    this.script.variables = [...this.segmentBase];
    if (this.cancelling) {
      this.frames = [];
      this.outcome = { kind: 'cancelled', cleanupFailed: { limit } };
      return;
    }
    this.frames = [];
    this.outcome = {
      kind: 'limit fault',
      limit,
      rollback,
      unit: code.name,
      handler,
      pc: code.unit.code.indexOf(ins),
      line: ins.line,
      col: ins.col,
    };
  }

  // A Core-raised error: the instruction is charged on what it worked on, then
  // the error unwinds.
  private raiseCore(error: ScriptError, ins: Instruction, key: string) {
    try {
      if (!error.uncharged) {
        this.pay(key, { ...this.m, result: undefined });
      } else if (this.frame.clauseCharge) {
        // Validation and lifecycle guards skip the instruction's charge,
        // but dispatch still pays for trying this Handler Clause.
        this.payAmount(charge('clause').fuel, 0);
      }
    } catch (error_) {
      if (error_ instanceof LimitFaultError) {
        return this.fault(error_.limit, ins);
      }
      throw error_;
    }
    this.unwind(this.errorMap(error.code, error.fields, ins), ins);
  }

  /** A Core-raised error map: `code`, `message`, its fields, then `at` (chapter 6). */
  errorMap(
    code: string,
    fields: readonly (readonly [string, Value])[],
    ins: Instruction,
  ): Value {
    const template = errorMessages[code as keyof typeof errorMessages] ?? code;
    const message = template.replaceAll(/{(\w+)}/g, (_, name: string) => {
      const field = fields.find(([k]) => k === name);
      return field ? field[1].toString() : `{${name}}`;
    });
    const error = map([
      ['code', text(code)],
      ['message', text(message)],
      ...fields.map(([k, v]) => [k, v] as [string, Value]),
      ['at', this.at(ins)],
    ]);
    coreRaised.add(error);
    return error;
  }

  // An error's `at`: inside stdlib code, the call that entered the stdlib,
  // in the nearest frame that isn't stdlib code (ADR 0037). A Library the
  // Host compiled with `atCaller` counts as stdlib code here.
  private at(ins: Instruction): Value {
    let i = this.frames.length - 1;
    while (i > 0 && this.frames[i]!.code.atCaller) {
      i--;
    }
    const frame = this.frames[i]!;
    const site = frame === this.frame ? ins : frame.code.unit.code[frame.pc]!;
    return map([
      ['unit', text(frame.code.name)],
      ['handler', text(frame.handler)],
      ['line', dec(String(site.line))],
      ['column', dec(String(site.col))],
    ]);
  }

  private record(error: Value, ins: Instruction, skip: boolean): CodePosition {
    // A Guard that gives something other than a boolean is a skip with its value.
    const notBoolean =
      skip &&
      (ins.op === 'branch-false' || ins.op === 'branch-true') &&
      textForm(error.get('code')) === 'wrong kind';
    const at: CodePosition = {
      unit: this.frame.code.name,
      handler: this.frame.handler,
      pc: this.frame.code.unit.code.indexOf(ins),
      line: ins.line,
      col: ins.col,
    };
    this.records.push({
      kind: skip ? 'guard-skip' : 'raise',
      ...(notBoolean
        ? { value: error.get('value') }
        : { code: textForm(error.get('code')) }),
      unit: at.unit,
      pc: at.pc,
      line: at.line,
      col: at.col,
    });
    return at;
  }

  /**
   * Unwind an error from the current instruction (chapter 8, The Unwind
   * Table): find the first entry that holds a frame's place, charge `unwind`
   * for the frames search leaves, then dispatch there.
   */
  private unwind(error: Value, ins: Instruction) {
    const search = () => {
      try {
        this.unwindNow(error, ins);
      } catch (error_) {
        if (!(error_ instanceof LimitFaultError)) {
          throw error_;
        }
        this.fault(error_.limit, ins);
      }
    };
    if (!deferFault(this, { reason: 'error', error }, search)) {
      search();
    }
  }

  private unwindNow(error: Value, ins: Instruction) {
    if (this.cancelling) {
      this.record(error, ins, false);
      try {
        this.checkState();
      } catch (error_) {
        if (error_ instanceof LimitFaultError) {
          return this.fault(error_.limit, ins);
        }
        throw error_;
      }
      this.frames = [];
      this.cancellation = [];
      this.cancellationOwners = [];
      this.outcome = {
        kind: 'cancelled',
        cleanupFailed: { code: textForm(error.get('code')) },
      };
      return;
    }
    const guard = this.activeEntries(this.frame).find(e => e.kind !== 'offer');
    const at = this.record(error, ins, guard?.kind === 'guard');
    if (guard?.kind === 'guard') {
      this.frame.stack.length = guard.depth;
      this.frame.pc = guard.target;
      return;
    }
    const outer = this.recoveries.at(-1);
    let escapingCleanup: RecoveryDispatch | undefined;
    if (outer?.cleanup && this.frames.includes(outer.cleanup)) {
      // A local cleanup catch may finish; an escaping Error cancels acceptance.
      const local = this.frames
        .slice(this.frames.indexOf(outer.cleanup))
        .some(f =>
          this.activeEntries(f).some(
            e =>
              e.kind === 'catch' &&
              (f !== outer.cleanup ||
                (e.start >= outer.cleanupEntry!.target &&
                  e.end <=
                    cleanupEnd(f.code.unit, outer.cleanupEntry!.target))),
          ),
        );
      if (!local) {
        escapingCleanup = outer;
      }
    }
    const context: RecoveryDispatch = {
      error,
      at,
      boundary:
        outer?.activation &&
        !outer.cleanup &&
        this.frames.includes(outer.activation)
          ? { frame: outer.activation, outer }
          : undefined,
      excluded: new Map(),
      cleanupOnly: new Set(),
      exited: [],
      retained: [...this.frames],
      cursor: this.frames.length - 1,
      seen: new Map(),
      queue: [],
    };
    this.recoveries.push(context);
    if (escapingCleanup) {
      this.escapeCleanup(context, escapingCleanup);
    }
    this.searchCatch(context);
  }

  // Catch tests run on a separate cursor while the failed continuations stay intact.
  private activeEntries(frame: Frame) {
    return frame.code.unit.unwind.filter(
      e => frame.pc >= e.start && frame.pc < e.end,
    );
  }

  private realOwner(frame: Frame): Frame {
    while (frame.owner) {
      frame = frame.owner;
    }
    return frame;
  }

  private realDepth() {
    return new Set(
      [
        ...this.frames,
        ...this.recoveries.flatMap(c => c.retained),
        ...(this.cancellation ?? []).map(c => c.frame),
        ...this.cancellationOwners,
      ].map(f => this.realOwner(f)),
    ).size;
  }

  private searchCatch(context: RecoveryDispatch) {
    let left = 0;
    for (let i = context.cursor; i >= 0; i--) {
      const owner = context.retained[i]!;
      if (
        context.boundary &&
        i < context.retained.indexOf(context.boundary.frame)
      ) {
        this.escapePolicy(context);
      }
      let entry = this.dispatchEntries(context, owner).find(
        e => e.kind === 'catch' && !context.seen.get(owner)?.has(e.target),
      );
      if (this.leaveCleanupSearch(context, owner, entry)) {
        entry = this.dispatchEntries(context, owner).find(
          e => e.kind === 'catch' && !context.seen.get(owner)?.has(e.target),
        );
      }
      if (entry) {
        this.pay('unwind', { frames: left });
        context.cursor = i;
        const seen = context.seen.get(owner) ?? new Set<number>();
        seen.add(entry.target);
        context.seen.set(owner, seen);
        context.owner = owner;
        context.entry = entry;
        const activation: Frame = {
          ...owner,
          owner,
          activation: true,
          pc: entry.target,
          stack: [...owner.stack.slice(0, entry.depth), context.error],
          clauseCharge: false,
        };
        context.activation = activation;
        this.frames = [...context.retained, activation];
        return;
      }
      if (!owner.activation && !context.cleanupOnly.has(owner)) {
        left++;
      }
    }
    if (context.boundary) {
      this.escapePolicy(context);
    }
    this.leaveJoin(-1, undefined);
    this.pay('unwind', { frames: left });
    context.pending = { kind: 'error' };
    context.queue = this.exitedCleanups(context, -1);
    this.advanceTransfer(context);
  }

  private entryKey(entry: UnwindEntry) {
    return `${entry.kind}:${entry.target}`;
  }

  // Selection control inherits enclosing scopes, but nested policy search
  // may only inspect scopes entered by that control and its own helpers.
  private dispatchEntries(context: RecoveryDispatch, frame: Frame) {
    const inherited =
      context.boundary?.frame === frame
        ? new Set(
            this.activeEntries(context.boundary.outer.owner!).map(e =>
              this.entryKey(e),
            ),
          )
        : undefined;
    return this.activeEntries(frame).filter(
      e =>
        !context.excluded.get(frame)?.has(this.entryKey(e)) &&
        !inherited?.has(this.entryKey(e)),
    );
  }

  private excludeEntry(
    context: RecoveryDispatch,
    frame: Frame,
    entry: UnwindEntry,
  ) {
    const excluded = context.excluded.get(frame) ?? new Set<string>();
    excluded.add(this.entryKey(entry));
    context.excluded.set(frame, excluded);
  }

  private escapePolicy(context: RecoveryDispatch) {
    const { frame, outer } = context.boundary!;
    if (!hasKey(context.error, 'during')) {
      context.error = this.withDuring(context.error, outer.error);
    }
    // Never retest the original failure's catches or the catching try's siblings.
    for (let i = outer.retained.length - 1; i >= outer.cursor; i--) {
      const original = outer.retained[i]!;
      if (i > outer.cursor) {
        context.cleanupOnly.add(original);
      }
      for (const entry of this.activeEntries(original)) {
        if (
          entry.kind !== 'finally' &&
          (i > outer.cursor ||
            (entry.start >= outer.entry!.start &&
              entry.end <= outer.entry!.end))
        ) {
          this.excludeEntry(context, original, entry);
        }
      }
    }

    // The activation's enclosing finally scopes belong to the original owner.
    for (const entry of this.activeEntries(outer.owner!)) {
      this.excludeEntry(context, frame, entry);
    }
    for (const owner of outer.cleanupOnly) {
      context.cleanupOnly.add(owner);
    }
    for (const [owner, entries] of outer.excluded) {
      for (const key of entries) {
        const excluded = context.excluded.get(owner) ?? new Set<string>();
        excluded.add(key);
        context.excluded.set(owner, excluded);
      }
    }
    this.recoveries.splice(this.recoveries.indexOf(outer), 1);
    context.boundary = outer.boundary;
  }

  private withDuring(error: Value, original: Value) {
    const replacement = map([...error.entries(), ['during', original]]);
    if (coreRaised.has(error)) {
      coreRaised.add(replacement);
    }
    return replacement;
  }

  // A rejecting local catch has not accepted the cleanup Error. Attach the
  // original failure only when its search leaves the pending cleanup.
  private leaveCleanupSearch(
    context: RecoveryDispatch,
    owner: Frame,
    entry?: UnwindEntry,
  ) {
    const outer = this.recoveries.at(-2);
    if (!outer?.cleanup || !context.retained.includes(outer.cleanup)) {
      return;
    }
    const cleanupIndex = context.retained.indexOf(outer.cleanup);
    const index = context.retained.indexOf(owner);
    if (index > cleanupIndex) {
      return;
    }
    if (
      index === cleanupIndex &&
      entry &&
      entry.start >= outer.cleanupEntry!.target &&
      entry.end <= cleanupEnd(owner.code.unit, outer.cleanupEntry!.target)
    ) {
      return;
    }
    this.escapeCleanup(context, outer);
    return true;
  }

  private escapeCleanup(context: RecoveryDispatch, outer: RecoveryDispatch) {
    if (outer.pending?.kind === 'offer' && outer.cleanup!.activation) {
      // This cleanup is still dispatch-local selection control.
      context.boundary = { frame: outer.cleanup!, outer };
      this.escapePolicy(context);
      return;
    }
    if (!hasKey(context.error, 'during')) {
      context.error = this.withDuring(context.error, outer.error);
    }
    for (const [owner, entries] of outer.excluded) {
      const excluded = context.excluded.get(owner) ?? new Set<string>();
      for (const key of entries) {
        excluded.add(key);
      }
      context.excluded.set(owner, excluded);
    }
    for (const owner of outer.cleanupOnly) {
      context.cleanupOnly.add(owner);
    }
    context.boundary = outer.boundary;
    this.recoveries.splice(this.recoveries.indexOf(outer), 1);
  }

  private exitedCleanups(
    context: RecoveryDispatch,
    ownerIndex: number,
    stop?: UnwindEntry,
  ) {
    const queue: { entry: UnwindEntry; frame: Frame; index: number }[] = [];
    for (
      let i = context.retained.length - 1;
      i >= Math.max(0, ownerIndex);
      i--
    ) {
      const frame = context.retained[i]!;
      for (const entry of this.dispatchEntries(context, frame)) {
        if (
          i === ownerIndex &&
          entry.kind === stop?.kind &&
          entry.target === stop.target &&
          entry.start === stop.start &&
          entry.end === stop.end
        ) {
          break;
        }
        if (entry.kind === 'finally') {
          queue.push({ frame, index: i, entry });
        }
      }
    }
    return queue;
  }

  private acceptCatch() {
    const context = this.recoveries.at(-1)!;
    const activation = context.activation!;
    context.pending = {
      kind: 'catch',
      frame: context.owner!,
      pc: activation.pc + 1,
      stack: [...activation.stack],
    };
    context.queue = this.exitedCleanups(context, context.cursor, context.entry);
    this.advanceTransfer(context);
  }

  private nextCatch() {
    const context = this.recoveries.at(-1)!;
    context.activation = undefined;
    this.frames = context.retained;
    this.searchCatch(context);
  }

  private lookupOffer(name: string) {
    const context = this.recoveries.at(-1);
    if (!context) {
      return { frames: 0 };
    }
    let frames = 0;
    const visited = new Set<Frame>();
    for (
      let i = context.retained.length - 1;
      i >=
      (context.boundary ? context.retained.indexOf(context.boundary.frame) : 0);
      i--
    ) {
      const frame = context.retained[i]!;
      if (context.cleanupOnly.has(frame)) {
        continue;
      }
      const owner = this.realOwner(frame);
      if (!visited.has(owner)) {
        visited.add(owner);
        frames++;
      }
      for (const entry of this.dispatchEntries(context, frame)) {
        if (entry.kind !== 'offer') {
          continue;
        }
        const offer = frame.code.unit.offers![entry.target]!.offers.find(
          o => o.name === name,
        );
        if (offer) {
          return { frames, offer, frame, index: i, entry };
        }
      }
    }
    return { frames };
  }

  private chooseOffer(name: string, count: number, ins: Instruction) {
    const found = this.lookupOffer(name);
    this.m.count = count;
    this.pay('choose-offer');
    this.pay('offer-lookup', { frames: found.frames });
    if (!found.offer) {
      throw new ThrownError(
        this.errorMap('offer unavailable', [['name', text(name)]], ins),
      );
    }
    if (count !== found.offer.binds.length) {
      throw new ThrownError(this.errorMap('wrong arity', [], ins));
    }
    const args = this.frame.stack.slice(
      this.frame.stack.length - count,
    ) as Value[];
    const context = this.recoveries.at(-1)!;
    this.frame.stack.length -= count;
    const attempt = ++this.offerAttempt;
    this.records.push({
      kind: 'offer-chosen',
      attempt,
      name,
      at: { unit: this.frame.code.name, pc: this.frame.pc },
      target: { unit: found.frame!.code.name, pc: found.offer.target },
      args,
    });
    context.pending = {
      kind: 'offer',
      frame: found.frame!,
      pc: found.offer.target,
      stack: found.frame!.stack.slice(0, found.entry!.depth),
      binds: found.offer.binds,
      args,
      attempt,
    };
    context.queue = this.exitedCleanups(context, found.index!, found.entry);
    // A policy's own nested finally scopes precede the retained failure's cleanup.
    const activation = context.activation!;
    const inherited = new Set(
      this.activeEntries(context.owner!)
        .filter(e => e.kind === 'finally')
        .map(e => e.target),
    );
    const policy = this.activeEntries(activation).filter(
      e => e.kind === 'finally' && !inherited.has(e.target),
    );
    context.queue.unshift(
      ...policy.map(entry => ({
        frame: activation,
        index: context.retained.length,
        entry,
      })),
    );
    this.advanceTransfer(context);
  }

  private advanceTransfer(context: RecoveryDispatch) {
    const next = context.queue.shift();
    if (next) {
      context.exited.push(next);
      const frame = {
        ...next.frame,
        owner: next.frame.owner ?? next.frame,
        pc: next.entry.target,
        stack: next.frame.stack.slice(0, next.entry.depth),
        clauseCharge: false,
      };
      const excluded = new Set(context.excluded.get(next.frame));
      if (next.frame.activation && next.frame.owner) {
        for (const entry of this.activeEntries(next.frame.owner)) {
          excluded.add(this.entryKey(entry));
        }
      }
      if (excluded.size) {
        context.excluded.set(frame, excluded);
      }
      context.cleanup = frame;
      context.cleanupEntry = next.entry;
      if (context.pending!.kind === 'offer') {
        context.activation = next.frame.activation ? frame : undefined;
      }
      this.frames = [...context.retained.slice(0, next.index), frame];
      return;
    }
    const pending = context.pending!;
    this.recoveries.pop();
    if (pending.kind === 'error') {
      this.leaveJoin(-1, undefined);
      this.checkState();
      this.frames = [];
      this.outcome = { kind: 'errored', error: context.error, at: context.at };
      return;
    }
    const index = context.retained.indexOf(pending.frame);
    this.leaveJoin(index, pending.pc);
    this.frames = context.retained.slice(0, index + 1);
    pending.frame.pc = pending.pc;
    pending.frame.stack = pending.stack;
    if (pending.kind === 'offer') {
      pending.binds.forEach((slot, i) => {
        pending.frame.locals[slot] = pending.args[i]!;
      });
      this.records.push({
        kind: 'offer-entered',
        attempt: pending.attempt,
        target: { unit: pending.frame.code.name, pc: pending.pc },
      });
    }
  }

  // A Segment's end: a breach of the Persistent State cap faults here.
  private checkState() {
    if (this.charging && this.persistentState() > this.limits.persistentState) {
      throw new LimitFaultError('persistentState', this.frame.pc);
    }
  }

  private returnFrom(value: Value) {
    this.frames.pop();
    if (!this.frames.length) {
      this.outcome = { kind: 'completed', result: value };
      return;
    }
    this.frame.stack.push(value);
    this.frame.pc++;
  }

  private callBody(code: Code, body: Body, args: Value[]) {
    if (this.realDepth() + 1 > this.limits.callDepth) {
      throw new LimitFaultError('callDepth', this.frame.pc);
    }
    this.pay('call');
    this.push(code, body, args, null);
  }

  // A function's defaults are its own code unit's definitions.
  private fillDefaults(code: Code, body: Body, args: Value[]): Value[] {
    const filled = [...args];
    for (let i = args.length; i < body.params.length; i++) {
      filled.push(
        homeConstant(
          code.definitions[body.defaults[i]!]!,
          this.script.home ?? this.script,
        ),
      );
    }
    return filled;
  }

  // A Function Value's Home Script is the Script whose Run made it, wherever
  // its code is (chapter 7, Calls into a Library).
  private functionValue(
    code: Code,
    body: Body,
    captures: Value[],
    ins: Instruction,
  ): Value {
    const lambda = body.kind === 'lambda';
    const home = this.script.home ?? this.script;
    const own = home.units.includes(code) || code === this.script;
    const placeHome = own && lambda ? code.name : home.name;
    const where = own ? '' : `${code.name}:`;
    const ref: FunctionRef = {
      group: home.functionGroup,
      home: home.name,
      displayHome: placeHome,
      place: where + (lambda ? `${ins.line}:${ins.col}` : body.name),
      identity: `${home.name}#${code.identity || code.name}#${body.index}`,
      maySuspend: body.maySuspend,
      captures: captures.map((v, i) => [
        body.locals[body.captureStart + i]!,
        v,
      ]),
      code: { code, body, home } satisfies FunctionCode,
    };
    return functionValue(ref);
  }

  private popArgs(n: number): Value[] {
    return this.frame.stack.slice(this.frame.stack.length - n) as Value[];
  }

  /**
   * A Capability call (chapter 9): the arguments checked against their
   * Shapes, uncharged; the declared cost; the Host function, which may
   * `Charge` more while it starts; then an immediate call's result checked
   * and its conversion charged. A suspending call suspends the Run until it
   * is answered, fails or times out. A `Fail` raises its code, and anything
   * else the Host does wrong is `host error`.
   */
  private capability(
    grantName: string,
    opName: string,
    args: Value[],
    key: string,
    member = false,
  ): Value {
    const host = this.host;
    if (!host) {
      throw new NotImplementedError('a Capability call outside a Group');
    }
    if (host.isDisabled(grantName)) {
      throw new ScriptError(
        'capability disabled',
        [
          ['capability', text(grantName)],
          ['operation', text(opName)],
        ],
        true,
      );
    }
    if (host.isRevoked?.(grantName)) {
      throw new ScriptError(
        'capability revoked',
        [
          ['capability', text(grantName)],
          ['operation', text(opName)],
        ],
        true,
      );
    }
    const grant = host.grants.get(grantName);
    const op = grant?.ops.has(opName)
      ? grant.capability.operations.get(opName)
      : undefined;
    if (!grant || !op || !acceptsArgumentCount(op.args ?? [], args.length)) {
      // Script and Library calls were checked against these Grants at load.
      throw new Error('A Capability call was not validated at load');
    }
    const named: [string, Value][] = [
      ['capability', text(grantName)],
      ['operation', text(opName)],
    ];
    args.forEach((arg, i) => {
      const bad = mismatch(arg, op.args![i]!);
      if (!bad) {
        return;
      }
      const path = bad.path.length
        ? [['path', listValues(bad.path.map(keyValue))] as [string, Value]]
        : [];
      throw bad.unencodable
        ? new ScriptError(
            'not encodable',
            [
              ['kind', text(bad.got)],
              ['path', listValues([i + 1, ...bad.path].map(keyValue))],
            ],
            true,
          )
        : new ScriptError(
            'wrong kind',
            [
              ['expected', text(bad.expected)],
              ['got', text(bad.got)],
              ['value', bad.value],
              ...named,
              ['argument', dec(String(i + 1))],
              ...path,
            ],
            true,
          );
    });
    standardChecks(op)?.arguments?.(args, grant.binding);
    if (op.mode === 'suspending') {
      this.checkScopeBoundary();
    }
    const scope = op.mode === 'immediate' ? op.scope : undefined;
    const scopeName = scope && ('opens' in scope ? scope.opens : scope.closes);
    const slot =
      scope &&
      this.scopes.findIndex(
        s => s.grantName === grantName && s.name === scopeName,
      );
    if (scope) {
      const fields: [string, Value][] = [...named, ['scope', text(scopeName!)]];
      if ('opens' in scope && this.join) {
        throw new ScriptError('scope in join', fields, true);
      }
      if ('opens' in scope && slot! >= 0) {
        throw new ScriptError('scope already open', fields, true);
      }
      if ('closes' in scope && slot! < 0) {
        throw new ScriptError('scope not open', fields, true);
      }
    }
    if (
      op.mode === 'immediate' &&
      op.segmentBound &&
      this.participant &&
      this.participant.grantName !== grantName
    ) {
      throw new ScriptError(
        'segment participant conflict',
        [...named, ['participant', text(this.participant.grantName)]],
        true,
      );
    }
    const declared = op.cost.fuel;
    this.pay(key, { declared }, op.cost.alloc ?? 0);
    if (op.mode === 'immediate' && op.segmentBound && !this.participant) {
      this.participant = { grantName, grant };
      const result = this.lifecycle('begin');
      if (result.status === 'failed') {
        this.participant = null;
        throw new ScriptError('host error', named, true);
      }
      if (result.status === 'unknown') {
        // Keep the possibly acquired participant for terminal cleanup, which
        // abandons existing scopes before attempting rollback exactly once.
        this.effectStateUnknown = true;
        throw new CrossingInterruptedError();
      }
    }
    const id = `${this.id}.c${++this.calls}`;
    const ctx: CallContext = {
      id,
      op,
      key,
      named,
      declared,
      opName: `${grantName}.${opName}`,
      adoptable: op.mode === 'suspending' && !!op.start,
    };
    let charged = 0;
    let reached = false;
    let starting = true;
    const abort = new AbortController();
    if (op.mode === 'suspending') {
      this.crossingCall = { abort, id };
    }
    const call: Call<unknown> = {
      id,
      scriptName: this.script.name,
      group: host.group,
      runId: this.id,
      grantName,
      segmentId: this.segmentId,
      scopeName,
      automatic: false,
      binding: grant.binding,
      now: host.now,
      signal: abort.signal,
      charge: (fuel: number) => {
        if (!starting) {
          throw new HostError('invalid value', 'Charge only while starting');
        }
        if (
          this.charging &&
          (this.cancelling
            ? this.cleanupFuel + fuel > this.limits.cleanupBudget
            : this.fuel + fuel > this.limits.fuelPerRun)
        ) {
          reached = true;
          throw new LimitReached('the Run can’t cover this charge');
        }
        this.fuel += fuel;
        if (this.cancelling) {
          this.cleanupFuel += fuel;
        }
        charged += fuel;
      },
      answer: (v: Value, late?: { fuel: number }) =>
        host.answer(id, v, late?.fuel ?? 0),
      // Anything but a ScriptError fails as `host error`.
      fail: (e: HostScriptError) =>
        e instanceof HostScriptError
          ? host.fail(id, e)
          : host.fail(id, null, hostDetail(e)),
    };
    const record = {
      kind: 'call' as const,
      id,
      op: ctx.opName,
      args,
    };
    let result: unknown;
    try {
      if (op.mode === 'immediate') {
        result = op.do(call, ...args);
      } else if (op.mode === 'fire-and-forget') {
        op.fire(call, ...args);
        result = nothing;
      } else if (op.start) {
        op.start(call, ...args);
      } else {
        this.forwardResult(op.run!(call, ...args), call);
      }
    } catch (error) {
      starting = false;
      if (reached) {
        // Cut off by its own `Charge`: neither a result nor a failure.
        this.recordCrossing({ ...record, charged });
        throw new LimitFaultError(
          this.cancelling ? 'cleanupBudget' : 'fuelPerRun',
          this.frame.pc,
        );
      }
      throw this.failure(
        ctx,
        error instanceof HostScriptError ? error : null,
        failed => this.recordCrossing({ ...record, charged, error: failed }),
        hostDetail(error),
      );
    }
    starting = false;
    let acknowledgement: Extract<RunRecord, { kind: 'scope' }> | undefined;
    if (scope) {
      if ('opens' in scope) {
        this.scopes.push({
          grantName,
          name: scope.opens,
          grant,
          abandonName: scope.abandon,
          op: grant.capability.operations.get(
            scope.abandon,
          )! as ImmediateOp<unknown>,
        });
      } else {
        this.scopes.splice(slot!, 1);
      }
      acknowledgement = {
        kind: 'scope',
        id,
        grant: grantName,
        name: scopeName!,
        action: 'opens' in scope ? 'opened' : 'closed',
      };
    }
    if (reached) {
      this.recordCrossing({ ...record, charged }, acknowledgement);
      throw new LimitFaultError(
        this.cancelling ? 'cleanupBudget' : 'fuelPerRun',
        this.frame.pc,
      );
    }
    if (op.mode === 'suspending') {
      this.recordCrossing({ ...record, charged });
      const ms = op.maxPendingMs ?? this.limits.maxWaitMs;
      if (member) {
        this.join!.members.push({ id, call: ctx, abort, ms });
      } else {
        // The Host has consumed the operands. Retain the call, not another
        // copy of its arguments on the frame's operand stack.
        this.frame.stack.length -= args.length;
        this.suspend({ k: 'ask', call: ctx, abort, ms });
      }
      return nothing;
    }
    if (op.mode === 'fire-and-forget') {
      this.recordCrossing({ ...record, charged });
      return nothing;
    }
    if (
      !Value.isValue(result) ||
      !functionsBelongTo([result], this.script.functionGroup) ||
      (op.result && mismatch(result, op.result)) ||
      standardChecks(op)?.result?.(result, args) === false
    ) {
      this.recordCrossing(
        { ...record, charged, error: map([]) },
        acknowledgement,
      );
      throw this.hostError(
        ctx,
        resultDetail(result, op.result, this.script.functionGroup),
      );
    }
    this.recordCrossing({ ...record, charged, result }, acknowledgement);
    this.payConversion(ctx, result, 0);
    return result;
  }

  // Promise-returning Operations automatically forward their result. A refused
  // answer or failure must settle the wait, rather than reject an unobserved Promise.
  private forwardResult(result: Promise<Value>, call: Call<unknown>) {
    result
      .then(
        value => call.answer(value),
        (error: unknown) =>
          error instanceof HostScriptError
            ? this.host!.fail(call.id, error)
            : this.host!.fail(call.id, null, hostDetail(error)),
      )
      .catch((error: unknown) =>
        this.host!.fail(call.id, null, hostDetail(error)),
      );
  }

  private recordCrossing(
    record: Extract<RunRecord, { kind: 'call' | 'prop' }>,
    acknowledgement?: Extract<RunRecord, { kind: 'scope' }>,
  ) {
    this.records.push(record);
    if (acknowledgement) {
      this.records.push(acknowledgement);
    }
    if (this.host?.crossing?.()) {
      throw new CrossingInterruptedError();
    }
    this.crossingCall = null;
  }

  // `host error` for a call, with its `call-failed` record, which carries the
  // Host-side detail the Script never sees (chapter 6).
  private hostError(ctx: CallContext, detail: string): ScriptError {
    // A property call has no call id; its `prop` record carries the failure.
    if (ctx.id) {
      this.records.push({
        kind: 'call-failed',
        id: ctx.id,
        op: ctx.opName,
        detail,
      });
    }
    return new ScriptError('host error', ctx.named, true);
  }

  // A result's conversion, and any late cost, charged at the call.
  private payConversion(ctx: CallContext, result: Value, late: number) {
    const conversion = charge(ctx.key, { declared: ctx.declared, result });
    const before = charge(ctx.key, { declared: ctx.declared });
    this.payAmount(
      conversion.fuel - before.fuel + late,
      conversion.alloc - before.alloc,
    );
  }

  /**
   * What a call's failure raises: a `Fail` with a code the Operation may
   * use raises it, its Data converted and charged; anything else, given as
   * null, is `host error` (chapter 6, Errors from Capabilities). `record`
   * writes the call's failure first, when the call record carries it.
   */
  private failure(
    ctx: CallContext,
    error: HostScriptError | null,
    record: (failed: Value) => void,
    detail = 'the Host failed the call with something other than a ScriptError',
  ): Error {
    if (!error) {
      record(map([]));
      return this.hostError(ctx, detail);
    }
    const data =
      Value.isValue(error.data) && error.data.kind === 'map'
        ? error.data
        : map([]);
    const failed = map([
      ['code', text(error.code)],
      ...(error.message
        ? [['message', text(error.message)] as [string, Value]]
        : []),
      ...data.entries(),
    ]);
    if (!functionsBelongTo([data], this.script.functionGroup)) {
      record(map([]));
      return this.hostError(
        ctx,
        `failure "${error.code}" holds a Function Value from another Group`,
      );
    }
    record(failed);
    const declaredCodes = ctx.op.errors?.map(e => e.code);
    const reserved = data.entries().find(([k]) => reservedKeys.has(k));
    const refused =
      error.code in errorMessages &&
      !standardChecks(ctx.op)?.error?.(error.code, data)
        ? `failure "${error.code}" is a catalogue code the Operation doesn't declare`
        : reserved
          ? `failure "${error.code}" has the reserved data key "${reserved[0]}"`
          : declaredCodes && !declaredCodes.includes(error.code)
            ? `failure "${error.code}" is outside the Operation's declared codes`
            : null;
    if (refused) {
      return this.hostError(ctx, refused);
    }
    // Its Data is converted, and charged, as a result is.
    this.payConversion(ctx, data, 0);
    return new ThrownError(
      map([
        ...failed.entries(),
        ...ctx.named,
        ['at', this.at(this.frame.code.unit.code[this.frame.pc]!)],
      ]),
    );
  }

  // ------------------------------------------------------------- instructions

  private execute(ins: Instruction, key: string) {
    const frame = this.frame;
    const [a, b, c] = ins.operands;
    const m = this.m;
    const next = () => {
      frame.pc++;
    };
    const jump = (label: number) => {
      frame.pc = label;
    };
    const code = frame.code;
    const unit = code.unit;
    switch (ins.op) {
      // Values and slots
      case 'const': {
        const value = code.constant(a as number);
        this.pay(key);
        frame.stack.push(value);
        return next();
      }
      case 'pop':
        this.pay(key);
        frame.stack.pop();
        return next();
      case 'load':
        this.pay(key);
        frame.stack.push(frame.locals[a as number]!);
        return next();
      case 'store':
        this.pay(key);
        frame.locals[a as number] = this.pop();
        return next();
      case 'move':
        this.pay(key);
        frame.locals[b as number] = frame.locals[a as number]!;
        return next();
      case 'load-var':
        this.pay(key);
        frame.stack.push(this.script.variables[a as number]!);
        return next();
      case 'store-var':
        this.pay(key);
        this.script.variables[a as number] = this.pop();
        return next();
      case 'load-definition':
        this.pay(key);
        frame.stack.push(
          homeConstant(
            code.definitions[a as number]!,
            this.script.home ?? this.script,
          ),
        );
        return next();
      case 'store-definition':
        this.pay(key);
        code.definitions[a as number] = this.pop();
        return next();

      // Control
      case 'jump':
        this.pay(key);
        return jump(a as number);
      case 'branch-false':
      case 'branch-true':
      case 'check-boolean': {
        const v = this.peek();
        if (v.kind !== 'boolean') {
          throw wrongKind('boolean', v);
        }
        this.pay(key);
        if (ins.op === 'check-boolean') {
          return next();
        }
        this.pop();
        return v.asBool() === (ins.op === 'branch-true')
          ? jump(a as number)
          : next();
      }
      case 'not': {
        const v = this.peek();
        if (v.kind !== 'boolean') {
          throw wrongKind('boolean', v);
        }
        m.result = bool(!v.asBool());
        return this.replace(1, key);
      }

      // Operators
      case 'add':
      case 'subtract':
      case 'multiply':
      case 'divide':
      case 'div':
      case 'mod':
      case 'power':
        m.result = arithmetic(ins.op, this.peek(1), this.peek());
        return this.replace(2, key);
      case 'negate':
        m.result = negated(this.peek());
        return this.replace(1, key);
      case 'concat':
        m.result = concat(this.peek(1), this.peek());
        return this.replace(2, key);
      case 'range':
        m.result = makeRange(this.peek(1), this.peek());
        return this.replace(2, key);
      case 'equal':
      case 'not-equal':
      case 'less':
      case 'greater':
      case 'less-or-equal':
      case 'greater-or-equal': {
        const out = comparison(ins.op, this.peek(1), this.peek(), a === 'fold');
        m.scanned = out.scanned;
        m.result = out.result;
        return this.replace(2, key);
      }
      case 'member': {
        const out = member(this.peek(1), this.peek(), a === 'fold');
        m.scanned = out.scanned;
        m.result = out.result;
        return this.replace(2, key);
      }
      case 'is-kind':
        m.result = isKind(this.peek(), a as string);
        return this.replace(1, key);
      case 'is-empty':
        m.result = isEmpty(this.peek());
        return this.replace(1, key);
      case 'can-convert':
      case 'convert':
        m.input = this.peek();
        m.result =
          ins.op === 'convert'
            ? convert(m.input, a as string)
            : canConvert(m.input, a as string);
        return this.replace(1, key);
      case 'contains':
      case 'begins-with':
      case 'ends-with':
      case 'matches': {
        m.input = this.peek(1);
        const out = search(ins.op, m.input, this.peek(), a === 'fold');
        m.steps = out.steps;
        m.result = out.result;
        return this.replace(2, key);
      }

      // Keys, properties and chunks
      case 'get-key':
        if (this.peek().kind === 'object') {
          m.result = this.getProperty(this.peek(), a as string, key);
          frame.stack.pop();
          frame.stack.push(m.result);
          return next();
        }
        m.result = getKey(this.peek(), a as string);
        return this.replace(1, key);
      case 'set-property':
      case 'set-property-computed': {
        const computed = ins.op === 'set-property-computed';
        // Deepest first: the key, if computed, the object, then the value.
        const o = this.peek(1);
        const v = this.peek();
        const name = computed ? keyText(this.peek(2)) : (a as string);
        this.setProperty(o, name, v, key);
        this.popN(computed ? 3 : 2);
        return next();
      }
      case 'get-key-computed':
        if (this.peek().kind === 'object') {
          m.result = this.getProperty(this.peek(), keyText(this.peek(1)), key);
          frame.stack.length -= 2;
          frame.stack.push(m.result);
          return next();
        }
        m.result = getKey(this.peek(), keyText(this.peek(1)));
        return this.replace(2, key);
      case 'property':
        m.input = this.peek();
        m.result = property(a as string, m.input);
        return this.replace(1, key);
      case 'property-delimited':
        m.input = this.peek(1);
        m.result = property(a as string, m.input, this.peek());
        return this.replace(2, key);
      case 'chunk-get':
      case 'chunk-get-delimited': {
        const delimited = ins.op === 'chunk-get-delimited';
        const d = delimited ? this.peek() : null;
        const whole = this.peek(delimited ? 1 : 0);
        const index = this.peek(delimited ? 2 : 1);
        m.input = whole;
        const out = chunkGet(a as string, index, whole, d);
        m.scanned = out.scanned;
        m.result = out.result;
        return this.replace(delimited ? 3 : 2, key);
      }
      case 'chunk-set':
      case 'chunk-set-delimited': {
        const delimited = ins.op === 'chunk-set-delimited';
        const d = delimited ? this.peek() : null;
        const part = this.peek(delimited ? 1 : 0);
        const whole = this.peek(delimited ? 2 : 1);
        const index = this.peek(delimited ? 3 : 2);
        m.input = part;
        m.result = chunkSet(a as string, index, whole, part, d);
        return this.replace(delimited ? 4 : 3, key);
      }
      case 'chunk-delete':
      case 'chunk-delete-delimited': {
        const delimited = ins.op === 'chunk-delete-delimited';
        const d = delimited ? this.peek() : null;
        const whole = this.peek(delimited ? 1 : 0);
        const index = this.peek(delimited ? 2 : 1);
        m.result = chunkDelete(a as string, index, whole, d);
        return this.replace(delimited ? 3 : 2, key);
      }
      case 'test-chunk':
      case 'test-chunk-delimited': {
        const delimited = ins.op === 'test-chunk-delimited';
        const d = delimited ? this.peek() : null;
        const whole = this.peek(delimited ? 1 : 0);
        const index = this.peek(delimited ? 2 : 1);
        m.input = whole;
        const there = chunkThere(a as string, index, whole, d);
        m.scanned = chunkGet(a as string, index, whole, d).scanned;
        this.pay(key);
        this.popN(delimited ? 3 : 2);
        return there ? next() : jump(b as number);
      }
      case 'test-key':
      case 'test-key-computed': {
        const computed = ins.op === 'test-key-computed';
        const there = hasKey(
          this.peek(),
          computed ? keyText(this.peek(1)) : (a as string),
        );
        this.pay(key);
        this.popN(computed ? 2 : 1);
        return there ? next() : jump((computed ? a : b) as number);
      }
      case 'set-key':
        m.input = this.peek();
        m.result = setKey(this.peek(1), a as string, m.input);
        return this.replace(2, key);
      case 'set-key-computed':
        m.input = this.peek();
        m.result = setKey(this.peek(1), keyText(this.peek(2)), m.input);
        return this.replace(3, key);
      case 'delete-key':
        m.result = deleteKey(this.peek(), a as string);
        return this.replace(1, key);
      case 'delete-key-computed':
        m.result = deleteKey(this.peek(), keyText(this.peek(1)));
        return this.replace(2, key);
      case 'append':
      case 'prepend':
      case 'append-all':
      case 'prepend-all':
        m.input = this.peek();
        m.result = appendTo(this.peek(1), m.input, ins.op);
        return this.replace(2, key);

      // Building values
      case 'list': {
        const n = a as number;
        m.count = n;
        m.result = listValues(
          this.frame.stack.slice(this.frame.stack.length - n) as Value[],
        );
        return this.replace(n, key);
      }
      case 'list-append':
        m.result = appendTo(this.peek(1), this.peek(), 'append');
        return this.replace(2, key);
      case 'list-extend': {
        const e = this.peek();
        if (e.kind !== 'list') {
          throw wrongKind('list', e);
        }
        m.result = appendTo(this.peek(1), e, 'append-all');
        return this.replace(2, key);
      }
      case 'map': {
        const keys = code.constant(a as number);
        const n = b as number;
        m.count = n;
        const values = this.frame.stack.slice(
          this.frame.stack.length - n,
        ) as Value[];
        m.result = map(values.map((v, i) => [textForm(keys.index(i + 1)), v]));
        return this.replace(n, key);
      }
      // Building Bytes
      case 'bytes-field':
        m.input = this.peek();
        m.result = buildField(this.peek(1), m.input, a as string);
        return this.replace(2, key);
      case 'bytes-sized':
        m.input = this.peek(1);
        m.result = buildSized(this.peek(2), m.input, this.peek(), a as string);
        return this.replace(3, key);
      case 'bytes-bits': {
        const n = b as number;
        const values = this.frame.stack.slice(-n) as Value[];
        m.result = buildBits(
          this.peek(n),
          values,
          widthsOf(code.constant(a as number)),
        );
        return this.replace(n + 1, key);
      }

      // Binary Patterns: a jump pops the reader, and the subject or size.
      case 'bin-start': {
        const v = this.peek();
        this.pay(key);
        this.pop();
        if (v.kind !== 'bytes') {
          return jump(a as number);
        }
        frame.stack.push({ k: 'reader', bytes: v.bytesView()!, at: 0 });
        return next();
      }
      case 'bin-literal': {
        const r = this.reader();
        this.pay(key);
        if (!readLiteral(r, code.constant(a as number))) {
          frame.stack.pop();
          return jump(b as number);
        }
        return next();
      }
      case 'bin-int': {
        const r = this.reader();
        m.result = readInt({ ...r }, a as string);
        this.pay(key);
        if (!m.result) {
          frame.stack.pop();
          return jump(b as number);
        }
        readInt(r, a as string);
        frame.stack.push(m.result);
        return next();
      }
      case 'bin-bits': {
        const r = this.reader();
        const widths = widthsOf(code.constant(a as number));
        const values = readBits({ ...r }, widths);
        m.resultSize = values?.reduce((t, v) => t + sizeOf(v), 0) ?? 0;
        this.pay(key);
        if (!values) {
          frame.stack.pop();
          return jump(c as number);
        }
        readBits(r, widths);
        frame.stack.push(...values);
        return next();
      }
      case 'bin-bytes': {
        const size = this.peek();
        const r = this.frame.stack.at(-2) as Reader;
        const probe = { ...r };
        m.result = readBytes(probe, size, a as string);
        this.pay(key);
        frame.stack.pop();
        if (!m.result) {
          frame.stack.pop();
          return jump(b as number);
        }
        r.at = probe.at;
        frame.stack.push(m.result);
        return next();
      }
      case 'bin-rest': {
        const r = this.reader();
        m.result = readRest(r, a as string);
        this.pay(key);
        frame.stack.pop();
        if (!m.result) {
          return jump(b as number);
        }
        frame.stack.push(m.result);
        return next();
      }
      case 'bin-end': {
        const r = this.reader();
        this.pay(key);
        frame.stack.pop();
        return r.at === r.bytes.length ? next() : jump(a as number);
      }

      case 'make-pattern': {
        const template = code.constants[a as number]!;
        if (template.k !== 'template') {
          throw new Error('make-pattern of a constant that is not a template');
        }
        const n = b as number;
        m.count = n;
        const pattern = splice(
          template.els,
          this.frame.stack.slice(this.frame.stack.length - n) as Value[],
        );
        if (pattern.asPattern()!.program > this.limits.patternSize) {
          throw new LimitFaultError('patternSize', frame.pc);
        }
        m.result = pattern;
        return this.replace(n, key);
      }
      case 'match-all': {
        const out = matchesOf(this.peek(1), this.peek());
        m.steps = out.steps;
        m.result = listValues(out.matches);
        return this.replace(2, key);
      }
      case 'replace-start': {
        const pattern = this.peek(1);
        const subject = this.peek();
        const out = matchesOf(pattern, subject, a === 1 ? 1 : Infinity);
        const replacement: Replacement = {
          k: 'replacement',
          subject,
          cs: out.cs,
          found: out.found,
          matches: out.matches,
          at: 0,
          pieces: [],
        };
        m.steps = out.steps;
        m.resultSize = partSize(
          'replacement',
          0,
          sizeOf(subject) + out.matches.reduce((t, v) => t + sizeOf(v), 0),
        );
        this.pay(key);
        this.popN(2);
        frame.stack.push(replacement);
        return next();
      }
      case 'replace-next': {
        const r = frame.stack.at(-1) as Replacement;
        this.pay(key);
        if (r.at >= r.matches.length) {
          return jump(a as number);
        }
        frame.stack.push(r.matches[r.at]!);
        return next();
      }
      case 'replace-put': {
        const piece = this.peek();
        const r = frame.stack.at(-2) as Replacement;
        this.pay(key);
        this.pop();
        r.pieces.push(textForm(piece));
        r.at++;
        return next();
      }
      case 'replace-end': {
        const r = frame.stack.at(-1) as Replacement;
        const out: string[] = [];
        let from = 0;
        r.found.forEach((f, i) => {
          out.push(r.cs.slice(from, f.start).join(''), r.pieces[i] ?? '');
          from = f.end;
        });
        out.push(r.cs.slice(from).join(''));
        m.result = text(out.join(''));
        this.pay(key);
        frame.stack.pop();
        frame.stack.push(m.result);
        return next();
      }
      case 'make-closure': {
        const body = unit.bodies[a as number]!;
        const n = b as number;
        m.count = n;
        m.result = this.functionValue(
          code,
          body,
          this.frame.stack.slice(this.frame.stack.length - n) as Value[],
          ins,
        );
        return this.replace(n, key);
      }
      case 'make-function':
        m.result = this.functionValue(code, unit.bodies[a as number]!, [], ins);
        return this.replace(0, key);
      case 'make-imported-function': {
        const target = code.library(a as string);
        m.result = this.functionValue(
          target.code,
          target.code.function(target.name),
          [],
          ins,
        );
        return this.replace(0, key);
      }

      // Effects
      case 'load-object': {
        const name = unit.objects[a as number]!;
        const object = this.host?.object(name);
        if (object) {
          this.pay(key);
          frame.stack.push(object);
          return next();
        }
        // A receiver that names no Script of the Group (chapter 5, Sending).
        // A computed name is checked first, so its send raises this.
        const named = namedSends.has(unit.code[frame.pc + 1]?.op ?? '');
        if (!named && !this.host?.isScript(name)) {
          throw new ScriptError('object gone', [['object', text(name)]]);
        }
        this.pay(key);
        frame.stack.push({ k: 'receiver', name });
        return next();
      }
      case 'me': {
        // The object the Script owns, or Nothing (chapter 5, `me`). A Script
        // that owns none is its own receiver in `send … to me`.
        this.pay(key);
        const me = this.host?.me ?? nothing;
        const then = unit.code[frame.pc + 1]?.op;
        frame.stack.push(
          me.kind === 'nothing' &&
            (then === 'send' ||
              then === 'send-wait' ||
              then === 'join-send' ||
              namedSends.has(then ?? ''))
            ? { k: 'receiver', name: this.script.name }
            : me,
        );
        return next();
      }
      case 'ask':
      case 'tell': {
        const n = c as number;
        const args = this.popArgs(n);
        const result = this.capability(a as string, b as string, args, key);
        frame.stack.length -= n;
        if (ins.op === 'ask') {
          frame.stack.push(result);
        }
        return next();
      }
      case 'wait': {
        const ns = waitNs(this.peek());
        this.checkScopeBoundary();
        this.pay(key);
        this.pop();
        this.suspend({ k: 'wait', ns });
        return;
      }
      case 'ask-wait': {
        const n = c as number;
        const args = this.popArgs(n);
        this.capability(a as string, b as string, args, key);
        return;
      }
      case 'wait-for':
      case 'wait-for-any': {
        // Deepest first: each branch's `from` and captures, or duration,
        // then the timeout (chapter 8, The event table).
        const entry = unit.events[a as number]!;
        const count =
          entry.branches.reduce(
            (n, br) =>
              n + (br.kind === 'after' ? 1 : br.captures + (br.from ? 1 : 0)),
            0,
          ) + (entry.timeout ? 1 : 0);
        const items = frame.stack.slice(frame.stack.length - count);
        let i = 0;
        const sus: WaitFor = {
          code,
          k: 'wait-for',
          any: ins.op === 'wait-for-any',
          whens: [],
          afters: [],
          timeout: null,
        };
        entry.branches.forEach((br, n) => {
          if (br.kind === 'after') {
            sus.afters.push({ branch: n + 1, ns: waitNs(items[i++] as Value) });
            return;
          }
          let from: string | Value | null = null;
          if (br.from) {
            const x = items[i++]!;
            if (isValue(x)) {
              if (x.kind !== 'object') {
                throw wrongKind('object', x);
              }
              from = x;
            } else if (x.k === 'receiver') {
              from = x.name;
            } else {
              throw new Error(
                'A from expression must produce a receiver or Value',
              );
            }
          }
          sus.whens.push({
            branch: n + 1,
            message: br.message,
            from,
            body: br.body,
            binds: br.binds,
            captures: items.slice(i, i + br.captures) as Value[],
          });
          i += br.captures;
        });
        if (entry.timeout) {
          sus.timeout = waitNs(items[i++] as Value);
        }
        this.checkScopeBoundary();
        this.pay(key);
        frame.stack.length -= count;
        this.suspend(sus);
        return;
      }
      case 'join-start':
        this.checkScopeBoundary();
        this.pay(key);
        this.join = { frame, members: [], replies: [], start: frame.pc };
        return next();
      case 'join-ask': {
        this.joinWidth();
        const n = c as number;
        this.capability(a as string, b as string, this.popArgs(n), key, true);
        frame.stack.length -= n;
        return next();
      }
      case 'join-end': {
        const members = this.join!.members;
        if (!members.length) {
          // No members: `[]` at once, with no Segment boundary.
          m.result = listValues([]);
          this.pay(key);
          this.join = null;
          frame.stack.push(m.result);
          return next();
        }
        this.pay(key);
        this.suspend({ k: 'join', members });
        return;
      }
      case 'send':
      case 'send-wait':
      case 'join-send':
      case 'send-named':
      case 'send-named-wait':
      case 'join-send-named':
      case 'send-spread':
      case 'send-spread-wait':
      case 'join-send-spread':
      case 'send-up':
      case 'send-up-wait': {
        const join =
          ins.op === 'join-send' ||
          ins.op === 'join-send-named' ||
          ins.op === 'join-send-spread';
        if (join) {
          this.joinWidth();
        }
        const up = ins.op === 'send-up' || ins.op === 'send-up-wait';
        const named = namedSends.has(ins.op);
        // A spread's arguments are one list, below the receiver (ADR 0064).
        const spread = spreadSends.has(ins.op)
          ? listItems(frame.stack.at(-2) as Value)
          : null;
        const n = (spread ? spread.length : named ? a : b) as number;
        // A computed name, below the arguments, is checked before the
        // receiver (chapter 5, A computed name).
        let message = a as string;
        if (named) {
          const name = frame.stack.at(spread ? -3 : -n - 2) as Value;
          if (name.kind !== 'text') {
            throw wrongKind('text', name);
          }
          message = textForm(name);
          if (!validComputedMessageName(message, n)) {
            throw new ScriptError('bad message name', [
              ['name', name],
              ['arguments', dec(String(n))],
            ]);
          }
        }
        // The receiver: a Script named at load, a Host Object, or, for a
        // Command Call with no Handler, the Message Path (chapter 5).
        const to = up ? null : frame.stack.at(-1)!;
        let target: ObjectState | string | null = null;
        if (to && !isValue(to) && to.k === 'receiver') {
          if (named && !this.host?.isScript(to.name)) {
            throw new ScriptError('object gone', [['object', text(to.name)]]);
          }
          target = to.name;
        } else if (to) {
          const o = isValue(to) ? stateOf(to) : undefined;
          if (!o) {
            throw wrongKind('object', to as Value);
          }
          if (o.disposed) {
            throw new ScriptError('object gone', [['object', o.handle.value]]);
          }
          target = o;
        }
        const args =
          spread ??
          (this.frame.stack.slice(
            this.frame.stack.length - n - (up ? 0 : 1),
            up ? undefined : -1,
          ) as Value[]);
        const size = partSize(
          'message',
          0,
          args.reduce((sum, v) => sum + sizeOf(v), 0),
        );
        m.inputSize = size;
        // A send that waits is a call, with an id of its own.
        const waits =
          ins.op !== 'send' &&
          ins.op !== 'send-named' &&
          ins.op !== 'send-spread' &&
          ins.op !== 'send-up';
        if (waits) {
          this.checkScopeBoundary();
        }
        this.pay(key);
        const id = waits ? `${this.id}.c${this.calls + 1}` : null;
        const reached = up
          ? this.host!.sendUp(message, args, id)
          : this.host!.send(target!, message, args, id);
        frame.stack.length -= spread ? 3 : n + (up ? 0 : 1) + (named ? 1 : 0);
        const object = typeof target === 'object' && target ? target : null;
        if (reached === null) {
          // Past the last Owning Script: `unhandled`, and nothing to wait on.
          this.records.push({
            kind: 'unhandled',
            message,
            args,
            target: object ? object.handle.value : null,
          });
          if (waits) {
            throw new ScriptError(
              'send failed',
              [['reason', text('unhandled')]],
              true,
            );
          }
          return next();
        }
        this.records.push({
          kind: 'send',
          to: object ? object.handle.value.toString() : reached,
          message,
          args,
          ...(id ? { id } : {}),
          ...(join ? { join: true } : {}),
        });
        if (!id) {
          return next();
        }
        this.calls++;
        if (join) {
          this.join!.members.push({
            id,
            call: null,
            abort: null,
            ms: this.limits.maxWaitMs,
          });
          return next();
        }
        this.suspend({ k: 'send', id, to: reached, message, args });
        return;
      }
      case 'veto': {
        const reason = this.peek();
        this.checkState();
        this.pay(key);
        this.frames = [];
        this.outcome = { kind: 'completed', result: nothing, veto: reason };
        return;
      }
      case 'pass':
        // Ends the Run as `completed`; its Group sends the message on up.
        this.checkState();
        this.pay(key);
        this.frames = [];
        this.outcome = { kind: 'completed', result: nothing, passed: true };
        return;
      case 'target':
        this.pay(key);
        frame.stack.push(this.target);
        return next();

      // Calls
      case 'call': {
        const body = unit.bodies[a as number]!;
        const args = this.frame.stack.slice(
          this.frame.stack.length - (b as number),
        ) as Value[];
        this.callBody(code, body, this.fillDefaults(code, body, args));
        frame.stack.length -= b as number;
        return;
      }
      case 'call-import': {
        const target = code.library(a as string);
        const body = target.code.function(target.name);
        const args = this.frame.stack.slice(
          this.frame.stack.length - (b as number),
        ) as Value[];
        this.callBody(
          target.code,
          body,
          this.fillDefaults(target.code, body, args),
        );
        frame.stack.length -= b as number;
        return;
      }
      case 'call-handler':
      case 'call-handler-wait': {
        // An imported Handler's clauses are its Library's.
        const target = code.clauses.has(a as string)
          ? { code, name: a as string }
          : code.library(a as string);
        const clauses = target.code.clauses.get(target.name)!;
        const n = b as number;
        const args = this.frame.stack.slice(
          this.frame.stack.length - n,
        ) as Value[];
        if (!clauses.some(body => body.params.length === n)) {
          throw new ScriptError('no match');
        }
        if (this.realDepth() + 1 > this.limits.callDepth) {
          throw new LimitFaultError('callDepth', frame.pc);
        }
        this.pay('call');
        frame.stack.length -= n;
        this.dispatch({ clauses, code: target.code, next: 0, args });
        return;
      }
      case 'call-builtin': {
        const n = b as number;
        const given = this.frame.stack.slice(
          this.frame.stack.length - n,
        ) as Value[];
        // Missing trailing arguments take the Built-in's defaults.
        const defaults = builtinDefaults[a as string] ?? [];
        const required =
          (builtinContracts.get(a as string)?.total ?? n) - defaults.length;
        const args = [...given, ...defaults.slice(given.length - required)];
        m.x = args;
        if (a === 'offerAvailable') {
          const name = args[0]!;
          if (name.kind !== 'text') {
            throw wrongKind('text', name);
          }
          this.pay(key);
          const found =
            /^[A-Z_a-z]\w*$/.test(name.asText()!) &&
            name.asText() !== '_' &&
            !grammar.reserved.includes(
              name.asText()! as (typeof grammar.reserved)[number],
            )
              ? this.lookupOffer(name.asText()!)
              : { frames: 0 };
          this.pay('offer-lookup', { frames: found.frames });
          frame.stack.length -= n;
          frame.stack.push(bool(!!('offer' in found && found.offer)));
          frame.pc++;
          return;
        }
        const out = builtin(a as string, args);
        m.result = out.result;
        m.scanned = out.scanned;
        m.steps = out.steps;
        return this.replace(n, key);
      }
      case 'call-value':
      case 'call-value-wait': {
        const n = a as number;
        const fn = this.peek(n);
        const args = this.frame.stack.slice(
          this.frame.stack.length - n,
        ) as Value[];
        const ref = fn.asFunction();
        if (!ref) {
          throw wrongKind('function', fn);
        }
        if (!(ref.code as FunctionCode).home.live) {
          throw new ScriptError('function gone');
        }
        const foreign = (ref.code as FunctionCode).home !== this.script;
        if (ins.op === 'call-value' && (foreign || ref.maySuspend)) {
          throw new ScriptError('would suspend');
        }
        const { code: home, body } = ref.code as FunctionCode;
        const arity = arityOf(body);
        if (n < arity.min || n > arity.max) {
          throw new ScriptError('wrong arity');
        }
        if (foreign) {
          this.checkScopeBoundary();
          this.pay(key);
          const id = `${this.id}.c${this.calls + 1}`;
          const to = this.host!.callValue(fn, args, id);
          this.calls++;
          frame.stack.length -= n + 1;
          this.records.push({ kind: 'send', id, to, fn, args });
          this.suspend({ k: 'call-value', id, to, fn, args });
          return;
        }
        const filled =
          body.kind === 'lambda' ? args : this.fillDefaults(home, body, args);
        this.callBody(home, body, filled);
        frame.stack.length -= n + 1;
        const callee = this.frame;
        ref.captures.forEach(([, v], i) => {
          callee.locals[body.captureStart + i] = v;
        });
        return;
      }
      case 'return': {
        const value = this.peek();
        if (this.frames.length === 1) {
          this.checkState();
        }
        this.pay(key);
        return this.returnFrom(value);
      }
      case 'clause-fail': {
        if (this.frames.length === 1 && !Run.more(frame.dispatch)) {
          this.checkState();
        }
        this.pay(key);
        const failed = this.frames.pop()!;
        const d = failed.dispatch!;
        if (this.dispatch(d)) {
          return;
        }
        if (!this.frames.length) {
          this.outcome = { kind: 'unhandled' };
          return;
        }
        // A `call-handler` whose clauses all failed raises at the call.
        const call = this.frame.code.unit.code[this.frame.pc]!;
        return this.unwind(this.errorMap('no match', [], call), call);
      }

      // Destructuring
      case 'test-constant': {
        const fold = b === 'fold';
        const target = (fold ? c : b) as number;
        const ok = equals(this.peek(), code.constant(a as number), fold).equal;
        this.pay(key);
        this.pop();
        return ok ? next() : jump(target);
      }
      case 'test-equal': {
        const ok = equals(this.peek(1), this.peek(), false).equal;
        this.pay(key);
        this.popN(2);
        return ok ? next() : jump(a as number);
      }
      case 'test-list':
      case 'test-list-at-least': {
        const v = this.peek();
        const n = a as number;
        const ok =
          v.kind === 'list' &&
          (ins.op === 'test-list' ? v.length === n : v.length >= n);
        this.pay(key);
        this.pop();
        return ok ? next() : jump(b as number);
      }
      case 'list-item':
        m.result = this.peek().index(a as number);
        return this.replace(1, key);
      case 'list-rest': {
        const v = this.peek();
        const from = a as number;
        m.result = listValues(
          Array.from({ length: Math.max(0, v.length - from + 1) }, (_, i) =>
            v.index(from + i),
          ),
        );
        return this.replace(1, key);
      }
      case 'test-map': {
        const ok = this.peek().kind === 'map';
        this.pay(key);
        this.pop();
        return ok ? next() : jump(a as number);
      }
      case 'map-get': {
        const v = this.peek();
        const there = hasKey(v, a as string);
        this.pay(key);
        this.pop();
        if (!there) {
          return jump(b as number);
        }
        frame.stack.push(v.get(a as string));
        return next();
      }
      case 'match-whole':
      case 'match-search': {
        const fold = a === 'fold';
        const target = (fold ? b : a) as number;
        const out = matchCaptures(
          ins.op === 'match-whole',
          this.peek(1),
          this.peek(),
          fold,
        );
        m.steps = out.steps;
        m.result = out.result ?? undefined;
        this.pay(key);
        this.popN(2);
        if (!out.result) {
          return jump(target);
        }
        frame.stack.push(out.result);
        return next();
      }

      // Loops
      case 'iterate': {
        const v = this.peek();
        let iterator: Iterator;
        if (v.kind === 'list') {
          iterator = {
            k: 'iterator',
            source: v,
            at: 0,
            count: v.length,
          };
        } else if (v.kind === 'range') {
          const { from, to } = v.asRange()!;
          const whole = (x: Value) => isKind(x, 'integer').asBool();
          if (!whole(from) || !whole(to)) {
            throw wrongKind('integer', whole(from) ? to : from);
          }
          const items = property('length', v);
          iterator = {
            k: 'iterator',
            source: v,
            at: 0,
            count: Number(items.asDecimal()!.toString()),
          };
        } else {
          throw wrongKind('list', v);
        }
        this.pay(key);
        this.pop();
        frame.stack.push(iterator);
        return next();
      }
      case 'iterate-times': {
        const v = this.peek();
        if (v.kind !== 'number' || !isKind(v, 'integer').asBool()) {
          throw wrongKind('integer', v);
        }
        const n = BigInt(v.asDecimal()!.toString().split('.')[0]!);
        if (n < 0n) {
          throw new ScriptError('out of range', [
            ['field', text('times')],
            ['value', v],
          ]);
        }
        this.pay(key);
        this.pop();
        frame.stack.push({
          k: 'iterator',
          source: null,
          at: 0,
          count: Number(n),
        });
        return next();
      }
      case 'next': {
        const it = frame.stack.at(-1) as Iterator;
        this.pay(key);
        if (it.at >= it.count) {
          return jump(a as number);
        }
        it.at++;
        frame.stack.push(iteratorItem(it.source, it.at));
        return next();
      }

      // Errors
      case 'throw': {
        const v = this.peek();
        let error: Value;
        if (v.kind === 'text') {
          error = map([['code', v]]);
        } else if (v.kind === 'map' && v.get('code').kind === 'text') {
          error = v;
        } else {
          throw new ScriptError('bad throw');
        }
        this.pay(key);
        const code = textForm(error.get('code'));
        if (
          frame.code.stdlib &&
          code in errorMessages &&
          !hasKey(error, 'message') &&
          !hasKey(error, 'at')
        ) {
          // A catalogue error the stdlib throws is Core-raised (ADR 0037).
          error = this.errorMap(
            code,
            error.entries().filter(([k]) => k !== 'code'),
            ins,
          );
        } else if (!hasKey(error, 'at')) {
          error = map([...error.entries(), ['at', this.at(ins)]]);
        }
        this.pop();
        throw new ThrownError(error);
      }
      case 'catch-accept':
        this.pay(key);
        return this.acceptCatch();
      case 'catch-next':
        this.pay(key);
        return this.nextCatch();
      case 'choose-offer':
        return this.chooseOffer(a as string, b as number, ins);
      case 'raise': {
        this.pay(key);
        throw new ThrownError(this.errorMap(a as string, [], ins));
      }
      case 'end-cleanup': {
        this.pay(key);
        if (this.cancelling) {
          this.checkState();
          return this.nextCancellationCleanup();
        }
        const recovery = this.recoveries.at(-1);
        if (recovery?.pending && recovery.cleanup === this.frame) {
          if (recovery.pending.kind === 'error') {
            recovery.at = this.record(recovery.error, ins, false);
          }
          return this.advanceTransfer(recovery);
        }
        const cleanup = this.cleanups.pop()!;
        throw new ThrownError(cleanup.error);
      }
    }
    throw new NotImplementedError(`the instruction ${ins.op}`);
  }

  // Charge, then replace the top `n` values with the measured result.
  private replace(n: number, key: string) {
    this.pay(key);
    const frame = this.frame;
    frame.stack.length -= n;
    frame.stack.push(this.m.result!);
    frame.pc++;
  }
}

// A widths constant, `[4, 4]`, as numbers.
const widthsOf = (v: Value): number[] =>
  Array.from({ length: v.length }, (_, i) =>
    Number(
      v
        .index(i + 1)
        .asDecimal()!
        .toString(),
    ),
  );

class CrossingInterruptedError extends Error {}

const resumptionSize = (r: Resumption): number => {
  switch (r.k) {
    case 'answer':
    case 'reply':
      return sizeOf(r.value);
    case 'event':
      return sizeOf(r.message) + r.binds.reduce((sum, v) => sum + sizeOf(v), 0);
    case 'joined':
      return r.answers.reduce((sum, answer) => sum + resumptionSize(answer), 0);
    case 'join-failed':
      return resumptionSize(r.failure);
    case 'fail':
      return Value.isValue(r.error?.data) ? sizeOf(r.error.data) : 0;
    case 'send failed':
      return r.error ? sizeOf(r.error) : 0;
    default:
      return 0;
  }
};

// An Error already constructed as a Script map.
class ThrownError extends Error {
  constructor(readonly error: Value) {
    super('thrown');
  }
}

const cleanupEnd = (unit: CodeUnit, start: number): number => {
  const starts = new Set(
    unit.unwind.filter(e => e.kind === 'finally').map(e => e.target),
  );
  let depth = 0;
  for (let pc = start; pc < unit.code.length; pc++) {
    if (pc !== start && starts.has(pc)) {
      depth++;
    }
    if (unit.code[pc]!.op === 'end-cleanup') {
      if (!depth) {
        return pc + 1;
      }
      depth--;
    }
  }
  return unit.code.length;
};

/**
 * Start a Run by dispatching a message to a Handler's clauses, and then, for
 * a message that may reach one, to the Script's Fallback Handler's (ADR 0064).
 */
export const deliver = (
  script: Script,
  message: string,
  args: Value[],
  limits?: Partial<Limits>,
  fallback = false,
): Run =>
  new Run(
    script,
    script.clauses.get(message) ?? [],
    args,
    { ...script.limits, ...limits },
    script,
    fallback ? message : undefined,
  );

/** Call a named function of the unit, as a Run on its own. */
export const callFunction = (
  script: Script,
  name: string,
  args: Value[],
): Run => {
  const body = script.unit.bodies.find(
    b => b.kind === 'function' && b.name === name,
  );
  if (!body) {
    throw new Error(`no function ${name}`);
  }
  return new Run(script, body, args);
};
