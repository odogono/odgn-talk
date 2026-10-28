import { deferFault, machineDebug } from './debug';
import { trackOperation } from './operation-promises';
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
import {
  cacheBuild,
  charge,
  fixedRates,
  keysContents,
  partSize,
  rateOf,
  resetMeasured,
  sizeOf,
  type Charge,
  type Measured,
} from './costs';
import { integerOf, isInteger } from './decimal';
import type { Body, CodeUnit, Instruction, UnwindEntry } from './code-unit';
import { arityOf } from './code-unit';
import type { MapLayout } from './map-storage';
import {
  errorMessages,
  limitDefaults,
  reservedErrorKeys,
} from './generated/machine';
// Keep opcode names distinct from runtime helpers while allowing constant inlining.
// eslint-disable-next-line import-x/no-namespace
import * as Op from './generated/opcodes';
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
  prepareConversion,
  type UnitConversion,
  deleteKey,
  equals,
  getKey,
  hasKey,
  integerValue,
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
  waitUs,
  wrongKind,
  randomBound,
  smallArithmetic,
  smallOf,
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
  type ValueOperation,
  type ValueImmediateOp,
  type EffectResult,
  type Shape,
} from './capabilities';
import type { EffectFailure } from './group';
import {
  HostError,
  hostDetail,
  ScriptError as HostScriptError,
} from './errors';
import {
  SegmentParticipant,
  type ParticipantSite,
} from './segment-participant';
import {
  bool,
  dec,
  decimalParts,
  functionValue,
  functionsBelongTo,
  listValues,
  map,
  mapLayout,
  mapOfLayout,
  nothing,
  num,
  quantity,
  text,
  Value,
  type FunctionRef,
} from './values';
import type { PatternElement } from './view';
import { stateOf, type ObjectState } from './objects';
import {
  abandon,
  abandonMembers,
  abandonSuspension,
  suspensionCall,
  type AbandonReason,
} from './waits';

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

// The rates charged outside an instruction's own.
const CALL = rateOf('call');
const RESTRICTED_REFUSAL = rateOf('restricted-refusal');
const COUNT_ELEMENTS = rateOf('count-elements');
const CAPABILITY = rateOf('capability');
const CHOOSE_OFFER = rateOf('choose-offer');
const CLAUSE = rateOf('clause');
const JOIN = rateOf('join');
const OFFER_LOOKUP = rateOf('offer-lookup');
const UNWIND = rateOf('unwind');

/** The error maps the Core raised, which a Trace writes without `message`. */
export const coreRaised = new WeakSet<Value>();

/** A code unit that can't load: a literal pattern past its limit, or a failed initialiser. */
// A map literal's keys are its Code's constant, so they're checked and
// arranged once, not on every build.
const mapLiterals = new WeakMap<Value, { keys: number; layout: MapLayout }>();
const mapLiteralOf = (keys: Value) => {
  let literal = mapLiterals.get(keys);
  if (!literal) {
    const names = Array.from({ length: keys.length }, (_, i) =>
      textForm(keys.index(i + 1)),
    );
    const layout = mapLayout(names);
    literal = { layout, keys: keysContents(layout.keys) };
    mapLiterals.set(keys, literal);
  }
  return literal;
};

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

const builtinContracts = new Map<
  string,
  { required: number; total: number; variadic?: boolean }
>(
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
  /** Static conversion metadata; rebuilt on Load, Reload and Restore. */
  readonly conversions = new Map<Instruction, UnitConversion>();
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
    const targets = new Map<string, UnitConversion | undefined>();
    for (const ins of unit.code) {
      if (ins.opcode === Op.Convert || ins.opcode === Op.CanConvert) {
        const target = ins.operands[0] as string;
        if (!targets.has(target)) {
          targets.set(target, prepareConversion(target));
        }
        const plan = targets.get(target);
        if (plan) {
          this.conversions.set(ins, plan);
        }
      }
    }
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
          ins => ins.opcode === Op.Const && ins.operands[0] === i,
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
type Item = Value | Iterator | Replacement | Reader | Receiver | Deadline;
/**
 * A Timeout Block's mathematical microsecond deadline and its duration
 * (ADR 0073). The count may lie outside the Clock's Instant range.
 */
export type Deadline = { after: Value; at: bigint; k: 'deadline' };
// A duration in microseconds as ms, or s if ms exceeds the number range,
// with no more decimal places than it needs.
const msOf = (us: bigint): Value => {
  const sign = us < 0n ? '-' : '';
  const n = us < 0n ? -us : us;
  const seconds = n / 1000n >= 10n ** 34n;
  const scale = seconds ? 1_000_000n : 1000n;
  const fraction = (n % scale)
    .toString()
    .padStart(seconds ? 6 : 3, '0')
    .replace(/0+$/, '');
  return quantity(
    dec(`${sign}${n / scale}${fraction ? `.${fraction}` : ''}`),
    seconds ? 's' : 'ms',
  );
};
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
  body: Body;
  /** A clause's `clause` charge, added to its first instruction's. */
  clauseCharge: boolean;
  /** The code unit the body is in: the Script's own, or a Library's. */
  code: Code;
  dispatch: Dispatch | null;
  handler: string;
  locals: Value[];
  pc: number;
  /** Inherited by calls, and by the policy and cleanup code it runs. */
  restricted: boolean;
  stack: Item[];
};
/**
 * A search bound: down to `frame`, and in it only the Unwind Table entries
 * before `entry`, which lie inside the policy or `finally` block that bounds
 * it.
 */
type Limit = { entry: number; frame: number };
/**
 * Where a catch search is: the frame and the first entry in it still to test,
 * the top frame's place, its bound, the frames below `position` it has yet to
 * charge for leaving, and the entries `skip` says already ran their `finally`
 * blocks.
 */
type Search = {
  entry: number;
  frame: number;
  limit: Limit | null;
  position: number;
  raised: number;
  skip: Limit | null;
};
/**
 * A catch's tests, or a Recovery policy, running in frame `owner`. The failed
 * frames above it are held aside; the owner's own stack and pc wait in
 * `ownerStack` and `ownerPc`. `search` goes on from the next entry when the
 * catch declines.
 */
type DispatchControl = {
  error: Value;
  held: Frame[];
  k: 'dispatch';
  owner: number;
  ownerPc: number;
  ownerStack: Item[];
  place: number;
  search: Search;
};
/**
 * A `finally` block a cleanup runs: its frame, target, the stack depth it
 * starts at and its entry. `leave` ends the dispatch under the cleanup, once a
 * policy's own `finally` blocks have run.
 */
type CleanupStep = {
  depth: number;
  entry: number;
  frame: number;
  leave: boolean;
  target: number;
};
/** What a cleanup does after its last `finally` block. */
type Then =
  | { frame: number; k: 'accept'; pc: number; stack: Item[] }
  | { k: 'end' }
  | { k: 'cancel' }
  | {
      args: Value[];
      attempt: number;
      frame: number;
      k: 'transfer';
      limit: Limit | null;
      offer: number;
      offerEntry: number;
      record: number;
    }
  | { k: 'search'; search: Search };
/**
 * `finally` blocks running for `error`, then `then`. `failed` is the logical
 * size of the operand stack the running block cut from the failed continuation
 * of frame `failedFrame`, with what each held frame's own block cut; `held`
 * keeps the failed frames above the running block (chapter 8, Pending cleanup
 * state). A cancellation holds none.
 */
type CleanupControl = {
  cleanups: CleanupStep[];
  error: Value;
  failed: number;
  failedFrame: number | null;
  held: Frame[];
  k: 'cleanup';
  /** Whether its `leave` has ended the dispatch under it. */
  left: boolean;
  next: number;
  then: Then;
};
/** A Run's error control, innermost last (chapter 8, The Unwind Table). */
type Control = DispatchControl | CleanupControl;
const LEAVE: CleanupStep = {
  depth: 0,
  entry: 0,
  frame: 0,
  leave: true,
  target: 0,
};
const requireSnapshot = (ok: unknown): void => {
  if (!ok) {
    throw new HostError('invalid save');
  }
};
const snapshotCounter = (n: number) => Number.isSafeInteger(n) && n >= 0;

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
      op: 'get' | 'set' | 'count' | 'at' | 'find';
      selector?: Value;
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
  /** A suspending Standard Capability call's arguments, for its answer rules. */
  args?: readonly Value[];
  declared: number;
  id: string;
  named: [string, Value][];
  op: ValueOperation<unknown>;
  /** As the Trace names it, `<granted name>.<operation>`. */
  opName: string;
  /** The rate the call is charged by. */
  rate: number;
};
/** Why a Run suspended, which its Group waits on (chapter 5, Suspension Points). */
export type Suspension = (
  | { k: 'wait'; us: bigint }
  | { abort: AbortController; call: CallContext; k: 'ask'; ms: number }
  | { args: Value[]; id: string; k: 'send'; message: string; to: string }
  | { args: Value[]; fn: Value; id: string; k: 'call-value'; to: string }
  | { k: 'join'; members: Member[] }
  | WaitFor
) & {
  /** The Timeout Block deadline it is written in, if any (ADR 0073). */
  deadline?: Deadline;
};
/**
 * A `wait for`, one-line or block: its `when` branches with their `from`
 * Scripts or objects and captures, its `after` branches' durations and its timeout,
 * each branch numbered from 1 in source order.
 */
export type WaitFor = {
  afters: { branch: number; us: bigint }[];
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
  /** Its deadline: the Clock of the Pump that started it, plus `ms`. */
  at: bigint;
  call: CallContext | null;
  id: string;
  ms: number;
  /** A Script reply received before its preempted Join closes. */
  reply?: Resumption;
  /** The checked member instruction retains its destination and owning frame. */
  site: { frame: Frame; pc: number };
};
/** What resumes a suspended Run. */
export type Resumption =
  | { k: 'wake' }
  | { code: 'call lost' | 'capability revoked'; k: 'restore-fail' }
  | { fuel: number; k: 'answer'; value: Value }
  | { detail?: string; error: HostScriptError | null; k: 'fail' }
  /** With `deadline`, a Timeout Block's deadline ended it, after that long. */
  | { after: number; deadline?: Value; k: 'timeout' }
  /** A Timeout Block's deadline ended a wait or Join, abandoning these. */
  | { abandon: string[]; after: Value; k: 'deadline' }
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
  /** The id of the Host Delivery that started the Run, if one did (ADR 0125). */
  readonly delivery?: string;
  disableGrant(name: string): void;
  /**
   * The next `random(n)` draw from the Group's generator; `commit` advances
   * the generator past it (chapter 7, Random numbers).
   */
  drawRandom(n: bigint): { commit(): void; value: bigint };
  expose?(tree: unknown): void;
  /**
   * Queues its failure, as `fail`; null fails with what isn't a Script error,
   * which `detail` describes for the `call failed` report.
   */
  fail(id: string, error: HostScriptError | null, detail?: string): void;
  readonly grants: ReadonlyMap<string, Grant<unknown>>;
  /** The Group, as the Calls and Segment contexts the Run makes see it. */
  readonly group: import('./embedding').Group;
  /** Whether a Value refers only to objects of this Group. */
  holdsObject(v: Value): boolean;
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
    case 'deadline':
      return partSize('deadline', 0, 0);
  }
};

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
// The sends that pop a computed message name (ADR 0057).
// A spreading send pops its name, as text, and its arguments as one list
// (ADR 0064).
const spreadSends = new Set<number>([
  Op.SendSpread,
  Op.SendSpreadWait,
  Op.JoinSendSpread,
]);
const namedSends = new Set<number>([
  Op.SendNamed,
  Op.SendNamedWait,
  Op.JoinSendNamed,
  ...spreadSends,
]);
// The keys a Host `Fail`'s Data may not use (chapter 6, the catalogue).
const reservedKeys = new Set<string>(reservedErrorKeys);

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
// Derived from immutable range Values, never part of the saved iterator or
// its logical size. Restored sources rebuild this cache on their first Next.
const rangeStarts = new WeakMap<Value, bigint>();
const iteratorItem = (source: Value | null, at: number): Value => {
  if (!source) {
    return nothing;
  }
  if (source.kind === 'list') {
    return source.index(at);
  }
  let start = rangeStarts.get(source);
  if (start === undefined) {
    start = integerOf(decimalParts(source.asRange()!.from.asDecimal()!));
    rangeStarts.set(source, start);
  }
  return integerValue(start + BigInt(at - 1));
};

// An iterator over a List or a whole-number range, else the error `iterate`
// raises.
const iteratorOver = (v: Value): Iterator => {
  if (v.kind === 'list') {
    return { k: 'iterator', source: v, at: 0, count: v.length };
  }
  if (v.kind !== 'range') {
    throw wrongKind('list', v);
  }
  const { from, to } = v.asRange()!;
  const whole = (x: Value) => isKind(x, 'integer').asBool();
  if (!whole(from) || !whole(to)) {
    throw wrongKind('integer', whole(from) ? to : from);
  }
  const items = property('length', v);
  return {
    k: 'iterator',
    source: v,
    at: 0,
    count: Number(items.asDecimal()!.toString()),
  };
};

const isValue = (item: Item | undefined): item is Value => Value.isValue(item);
const isBoolean = (item: Item | undefined): boolean =>
  isValue(item) && item.kind === 'boolean';
// A stack item's small integer (see `smallInteger`), or NaN.
const smallAt = (item: Item | undefined): number =>
  isValue(item) ? smallOf(item) : Number.NaN;

// Shrinking length is expensive on JavaScriptCore, even for a single operand.
const drop = (stack: Item[], n: number): void => {
  for (let i = 0; i < n; i++) {
    stack.pop();
  }
};
// A retained frame's size: its header, its locals and its operand stack.
const frameSize = (f: Frame): number =>
  partSize(
    'frame',
    f.locals.length,
    stackSize(f.stack) + f.locals.reduce((t, v) => t + sizeOf(v), 0),
  );
// A frame's size without its operand stack.
const frameHeader = (f: Frame): number =>
  partSize(
    'frame',
    f.locals.length,
    f.locals.reduce((t, v) => t + sizeOf(v), 0),
  );
const stackSize = (stack: Item[]): number =>
  stack.reduce((total, item) => total + itemSize(item), 0);
const next = (frame: Frame): void => {
  frame.pc++;
};
const jump = (frame: Frame, pc: number): void => {
  frame.pc = pc;
};

// Scheduler callbacks last only for one step and are never saved with a Run.
const clauseChargeCallbacks = new WeakMap<Run, () => void>();

/** Internal: tests turn `Run.fastSteps` and `stepMany` off to compare them with `step`. */
export const fastPath = { enabled: true };

// Each rate's charge when its formula measures nothing, else undefined.
const fixedCharges: readonly (Charge | undefined)[] = fixedRates();
// Compare rates' charges for two numbers, which scan nothing.
const compareCharges: Charge[] = [];
// Arithmetic rates' charges by the result's digits, which with its constant
// size are all a number result's measures.
const numberCharges: Charge[][] = [];
const numberCharge = (rate: number, result: Value): Charge => {
  const n = Math.abs(smallOf(result));
  let digits = 1;
  for (let ten = 10; n >= ten; ten *= 10) {
    digits++;
  }
  return ((numberCharges[rate] ??= [])[digits] ??= charge(rate, { result }));
};
const ordered = (opcode: number, x: number, y: number): boolean => {
  switch (opcode) {
    case Op.Less:
      return x < y;
    case Op.Greater:
      return x > y;
    case Op.LessOrEqual:
      return x <= y;
    case Op.GreaterOrEqual:
      return x >= y;
    case Op.Equal:
      return x === y;
  }
  return x !== y;
};

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
    op: ValueImmediateOp<unknown>;
  }[] = [];

  // Never saved: the Group refuses a save while a participant is active or
  // its effect state is unknown, so a restored Run starts a fresh one.
  private participant = new SegmentParticipant();

  private get participantSite(): ParticipantSite {
    return {
      group: this.host!.group,
      now: this.host!.now,
      records: this.records,
      runId: this.id,
      scriptName: this.script.name,
      segmentId: this.segmentId,
    };
  }

  get hasParticipant(): boolean {
    return this.participant.active;
  }

  get effectStateUnknown(): boolean {
    return this.participant.effectStateUnknown;
  }

  /** After charges/state checks, before any Segment outcome becomes visible. */
  finalizeEffects(rollback = false) {
    const ending = this.participant.end(
      rollback ||
        this.outcome?.kind === 'limit fault' ||
        (this.outcome?.kind === 'cancelled' &&
          this.outcome.cleanupFailed &&
          'limit' in this.outcome.cleanupFailed)
        ? 'rollback'
        : 'commit',
      () => this.participantSite,
      () => {
        if (rollback || this.done) {
          this.abandonScopes();
        }
      },
    );
    if (ending.kind === 'rolled back' || ending.kind === 'effect failed') {
      this.script.variables = [...this.segmentBase];
    }
    if (ending.kind === 'effect failed') {
      const pending = this.discard('effect-failed');
      this.records.push(
        ...pending.map(id => ({ kind: 'abandon' as const, id })),
      );
      this.outcome = { kind: 'effect failed', effect: ending.failure };
    }
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
  abandonScopes(only?: (grantName: string) => boolean) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (only && !only(this.scopes[i]!.grantName)) {
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
        ...(this.host!.delivery ? { delivery: this.host!.delivery } : {}),
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
        this.host?.expose?.(listValues([]));
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
        this.host!.disableGrant(scope.grantName);
        this.participant.abandonFailed({
          script: this.script.name,
          run: this.id,
          grant: scope.grantName,
          segment: this.segmentId,
          phase: 'abandon',
          scope: scope.name,
          status,
          detail: hostDetail(error),
        });
      }
    }
  }
  private crossingCall: { abort: AbortController; id: string } | null = null;
  frames: Frame[] = [];
  fuel = 0;
  alloc = 0;
  charging = true;
  /**
   * A `set` through a property's value is between its `hold` and its
   * `set-property` or raise: crossings there don't land queued inputs, and no
   * Fuel Slice preempts it (ADR 0135).
   */
  holding = false;
  records: RunRecord[] = [];
  /**
   * The Script's Persistent State, measured at the Segment's end without this
   * Run, since a Run that is ending keeps nothing (chapter 6, Limits). The
   * Group adds what else the Script holds, such as its mailbox.
   */
  persistentState: () => number = () => this.script.variablesSize();
  /** The Script Variables when the Segment began, for rollback (ADR 0006). */
  segmentBase: Value[];
  private controls: Control[] = [];
  /** Where its current error was raised, for an errored outcome. */
  private raisedAt: CodePosition | null = null;
  private offerAttempt = 0;
  private outcome: Outcome | null = null;
  private entryError: 'wrong arity' | null = null;
  private m: Measured = {};
  private instructionCharge: Charge = { alloc: 0, fuel: 0 };
  private clause = 0;
  /** Its entry dispatch reached the Fallback Handler's clauses (ADR 0064). */
  private viaFallback = false;
  private during: Value = nothing;
  /** Its Fuel when its cancellation cleanup began, if it has been cancelled. */
  private cleanupFrom: number | null = null;
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
      ...(this.host!.delivery ? { delivery: this.host!.delivery } : {}),
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
        this.host?.expose?.(listValues(args));
        op.start(call, ...args);
      } else {
        this.host?.expose?.(listValues(args));
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
      // It faults at the call: a Join member at its own site (#1413).
      const site = 'site' in pending ? (pending as Member).site : undefined;
      this.fault(
        'fuelPerRun',
        site
          ? site.frame.code.unit.code[site.pc]!
          : this.frame.code.unit.code[this.frame.pc]!,
      );
      if (suspension?.k === 'ask') {
        abandon(abort, 'limit');
        this.faultAbandons.push(id);
      }
      failure = { k: 'wake' };
    }
    return { call, ...(failure ? { failure } : {}) };
  }

  /** The plain machine state, without its Group's Host functions. */
  snapshot(): Record<string, unknown> {
    const {
      host: _host,
      participant: _participant,
      persistentState: _state,
      ...state
    } = this;
    return state;
  }

  /** Allocate before linking shared frames and Join state from a save. */
  static empty(): Run {
    return Object.create(Run.prototype) as Run;
  }

  restore(state: Record<string, unknown>): void {
    Object.assign(this, state);
    this.host = null;
    this.participant = new SegmentParticipant();
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

  /**
   * The error control's records: each refers to the frames, Unwind Table
   * entries and offers it names, and they nest as the machine makes them.
   */
  private validateControls(): void {
    const cancel = this.controls.findIndex(
      c => c.k === 'cleanup' && c.then?.k === 'cancel',
    );
    requireSnapshot(
      this.cancelling
        ? cancel < 0
          ? this.done
          : cancel === this.controls.length - 1 &&
            this.controls.every((c, i) => i === cancel || c.k === 'dispatch')
        : cancel < 0,
    );
    requireSnapshot(
      this.raisedAt === null ||
        (this.raisedAt &&
          typeof this.raisedAt.unit === 'string' &&
          typeof this.raisedAt.handler === 'string' &&
          [this.raisedAt.pc, this.raisedAt.line, this.raisedAt.col].every(
            snapshotCounter,
          )),
    );
    const limit = (l: Limit | null) =>
      l === null || (l && snapshotCounter(l.frame) && snapshotCounter(l.entry));
    const search = (x: Search) =>
      requireSnapshot(
        x &&
          [x.frame, x.entry, x.raised, x.position].every(snapshotCounter) &&
          limit(x.limit) &&
          limit(x.skip),
      );
    const entryOf = (frame: Frame | undefined, ei: number, kind: string) => {
      const e = frame?.code.unit.unwind[ei];
      requireSnapshot(
        snapshotCounter(ei) &&
          e &&
          e.kind === kind &&
          e.start >= frame!.body.start &&
          e.end <= frame!.body.end,
      );
      return e!;
    };
    let owner = -1;
    for (const [i, c] of this.controls.entries()) {
      requireSnapshot(Value.isValue(c.error));
      // The frames as this control had them, and their places.
      const { frames, pcs } = this.framesAt(i);
      if (c.k === 'dispatch') {
        requireSnapshot(c.error.kind === 'map');
        requireSnapshot(
          snapshotCounter(c.owner) &&
            c.owner >= owner &&
            c.owner < frames.length,
        );
        owner = c.owner;
        requireSnapshot(
          snapshotCounter(c.place) &&
            snapshotCounter(c.ownerPc) &&
            Array.isArray(c.ownerStack),
        );
        search(c.search);
        const f = frames[c.owner]!;
        requireSnapshot(c.ownerPc >= f.body.start && c.ownerPc < f.body.end);
        requireSnapshot(c.search.entry > 0);
        const e = entryOf(f, c.search.entry - 1, 'catch');
        requireSnapshot(c.place >= e.start && c.place < e.end);
        requireSnapshot(c.search.frame === c.owner);
        continue;
      }
      requireSnapshot(c.k === 'cleanup');
      requireSnapshot(
        Array.isArray(c.cleanups) &&
          snapshotCounter(c.next) &&
          c.next <= c.cleanups.length &&
          typeof c.left === 'boolean' &&
          snapshotCounter(c.failed) &&
          (c.failedFrame === null || snapshotCounter(c.failedFrame)),
      );
      // A frame by its index once the dispatch under a transfer has left:
      // the live frames, then those the cleanup holds above them.
      const levels = frames.length + c.held.length;
      const at = (index: number) =>
        index < frames.length ? frames[index] : c.held[index - frames.length];
      const steps = new Set<string>();
      for (const step of c.cleanups) {
        requireSnapshot(step && typeof step.leave === 'boolean');
        if (step.leave) {
          continue;
        }
        requireSnapshot(snapshotCounter(step.frame) && step.frame < levels);
        const e = entryOf(at(step.frame), step.entry, 'finally');
        requireSnapshot(step.target === e.target && step.depth === e.depth);
        const key = `${step.frame}:${step.entry}`;
        requireSnapshot(!steps.has(key));
        steps.add(key);
      }
      const running = c.cleanups[c.next - 1];
      if (running && !running.leave) {
        const f = frames[running.frame];
        const pc = f && (pcs.get(f) ?? f.pc);
        requireSnapshot(
          f &&
            pc! >= running.target &&
            pc! < cleanupEnd(f.code.unit, running.target),
        );
      }
      const t = c.then;
      requireSnapshot(t && typeof t === 'object');
      switch (t.k) {
        case 'end':
        case 'cancel':
          break;
        case 'accept': {
          requireSnapshot(
            snapshotCounter(t.frame) &&
              t.frame < frames.length &&
              snapshotCounter(t.pc) &&
              Array.isArray(t.stack),
          );
          const f = frames[t.frame]!;
          requireSnapshot(
            t.pc > f.body.start &&
              t.pc < f.body.end &&
              f.code.unit.code[t.pc - 1]?.opcode === Op.CatchAccept,
          );
          break;
        }
        case 'search':
          search(t.search);
          requireSnapshot(t.search.frame < frames.length);
          break;
        case 'transfer': {
          requireSnapshot(
            snapshotCounter(t.frame) &&
              snapshotCounter(t.attempt) &&
              t.attempt > 0 &&
              t.attempt <= this.offerAttempt &&
              limit(t.limit) &&
              Array.isArray(t.args) &&
              t.args.every(Value.isValue),
          );
          // Until its `leave`, the dispatch under it holds the failed frames
          // above its owner, which the offer's frame is counted among.
          const d = this.controls[i - 1];
          const frame = c.left
            ? at(t.frame)
            : d?.k === 'dispatch'
              ? t.frame <= d.owner
                ? frames[t.frame]
                : d.held[t.frame - d.owner - 1]
              : undefined;
          const e = entryOf(frame, t.offerEntry, 'offer');
          const offer = frame!.code.unit.offers?.[t.record]?.offers[t.offer];
          requireSnapshot(
            t.record === e.target &&
              snapshotCounter(t.offer) &&
              offer &&
              offer.binds.length === t.args.length,
          );
          break;
        }
        default:
          requireSnapshot(false);
      }
    }
  }

  /**
   * The frames as control `i` had them, before the controls after it held
   * some aside: each later dispatch gives back the frames it holds above its
   * owner, whose place is its own pc again, and each later cleanup those it
   * holds above its running block. `pcs` has the places that differ.
   */
  private framesAt(i: number): { frames: Frame[]; pcs: Map<Frame, number> } {
    let frames = this.frames;
    const pcs = new Map<Frame, number>();
    for (let j = this.controls.length - 1; j > i; j--) {
      const c = this.controls[j]!;
      if (c.k === 'dispatch') {
        const owner = frames[c.owner];
        requireSnapshot(owner);
        pcs.set(owner!, c.ownerPc);
        frames = [...frames.slice(0, c.owner + 1), ...c.held];
        continue;
      }
      const step = c.cleanups[c.next - 1];
      if (step && !step.leave && c.held.length) {
        requireSnapshot(step.frame < frames.length);
        frames = [...frames.slice(0, step.frame + 1), ...c.held];
      }
    }
    return { frames, pcs };
  }

  private validateControl(knownCode: ReadonlySet<object>): void {
    requireSnapshot(
      snapshotCounter(this.offerAttempt) &&
        snapshotCounter(this.fuel) &&
        snapshotCounter(this.alloc),
    );
    requireSnapshot(Array.isArray(this.frames) && Array.isArray(this.controls));
    requireSnapshot(
      Array.isArray(this.segmentBase) &&
        this.segmentBase.length === this.script.variables.length,
    );
    requireSnapshot(
      this.cleanupFrom === null ||
        (snapshotCounter(this.cleanupFrom) && this.cleanupFrom <= this.fuel),
    );
    requireSnapshot(this.done || this.frames.length > 0);
    const frames = new Set<Frame>();
    const add = (f: Frame) => {
      requireSnapshot(f && typeof f === 'object');
      requireSnapshot(!frames.has(f));
      frames.add(f);
    };
    this.frames.forEach(add);
    for (const c of this.controls) {
      requireSnapshot(c && Array.isArray(c.held));
      c.held.forEach(add);
    }
    if (this.suspended?.k === 'join') {
      requireSnapshot(
        this.join && this.suspended.members === this.join.members,
      );
    }
    if (this.join) {
      requireSnapshot(Array.isArray(this.join.members));
      requireSnapshot(this.frames.includes(this.join.frame));
      for (const m of this.join.members) {
        requireSnapshot(
          m.site &&
            m.site.frame === this.join.frame &&
            snapshotCounter(m.site.pc),
        );
        const f = m.site.frame;
        requireSnapshot(
          knownCode.has(f.code) && f.code.unit.bodies.includes(f.body),
        );
        let end = this.join.start;
        while (
          end < f.body.end &&
          f.code.unit.code[end]!.opcode !== Op.JoinEnd
        ) {
          end++;
        }
        requireSnapshot(m.site.pc > this.join.start && m.site.pc < end);
        const ins = f.code.unit.code[m.site.pc];
        requireSnapshot(
          ins &&
            [
              Op.JoinAsk,
              Op.JoinSend,
              Op.JoinSendNamed,
              Op.JoinSendSpread,
            ].includes(ins.opcode),
        );
        requireSnapshot(m.site.pc >= f.body.start && m.site.pc < f.body.end);
        const t = this.memberTarget(m);
        requireSnapshot(
          !t ||
            ((t.kind === 'local' || t.kind === 'variable') &&
              snapshotCounter(t.index) &&
              (t.kind === 'local'
                ? t.index > 0 && t.index < f.locals.length
                : t.index < this.script.variables.length)),
        );
      }
    }
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
      requireSnapshot(typeof f.restricted === 'boolean');
    }
    this.validateControls();
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
    return this.cleanupFrom !== null;
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
  discard(reason: AbandonReason, betweenSegments = false): string[] {
    const debug = machineDebug.get(this);
    if (debug) {
      debug.pending = null;
      debug.fault = null;
    }
    if (!betweenSegments && !this.suspended && !this.resumption && !this.done) {
      this.script.variables = [...this.segmentBase];
    }
    const join = this.resumption ? null : this.join;
    this.join = null;
    const members = abandonMembers(join?.members ?? [], reason);
    // Fail-fast abandonment happened at input drain, but its records would
    // normally wait for resume. Keep them when that resume is discarded.
    const ids = [
      ...this.cancellationAbandons,
      ...(this.resumption?.k === 'join-failed'
        ? this.resumption.abandon
        : members),
    ];
    this.cancellationAbandons = [];
    if (this.crossingCall) {
      abandon(this.crossingCall.abort, reason);
      ids.push(this.crossingCall.id);
      this.crossingCall = null;
    }
    const own = abandonSuspension(this.suspended, reason);
    if (own !== undefined) {
      ids.push(own);
    }
    this.suspended = null;
    this.resumption = null;
    this.waitedOn = null;
    this.frames = [];
    this.controls = [];
    this.cleanupFrom = null;
    return ids;
  }

  /**
   * Cancellation lands here: its Segment rolls back, and its `finally`
   * blocks run, once, innermost first, on the Cleanup Budget; nothing is
   * unwound (chapter 6, Cancellation and Stop).
   */
  cancel(betweenSegments = false) {
    if (this.cancelling || this.done) {
      return;
    }
    const ending = this.participant.end(
      'rollback',
      () => this.participantSite,
      () => this.abandonScopes(name => this.participant.enrolled(name)),
    );
    if (ending.kind === 'rolled back') {
      this.script.variables = [...this.segmentBase];
    }
    const { frames, controls } = this;
    this.cancellationAbandons = this.discard('cancelled', betweenSegments);
    this.segment++;
    this.frames = frames;
    this.controls = controls;
    this.cleanupFrom = this.fuel;
    this.beginCleanupSegment();
    // A cleanup it was preempted in ends. A catch dispatch it was preempted
    // in runs its policy's own `finally` blocks, then leaves, bringing its
    // failed frames back with theirs.
    while (this.controls.at(-1)?.k === 'cleanup') {
      this.controls.pop();
    }
    const place = this.frame.pc;
    const d = this.controls.at(-1) as DispatchControl | undefined;
    const cleanups = d
      ? [...this.collect(d.owner, d.search.entry - 1, null, place), LEAVE]
      : this.collect(0, null, null, place);
    this.startCleanup(nothing, cleanups, { k: 'cancel' });
  }

  /** The index of a cancellation's cleanup among the controls, if it has one. */
  private cancelControl(): number | undefined {
    const i = this.controls.findIndex(
      c => c.k === 'cleanup' && c.then.k === 'cancel',
    );
    return i < 0 ? undefined : i;
  }

  /**
   * Each frame and held frame a cancellation's remaining cleanup needs, with
   * the size it keeps, or null for a frame it no longer needs (chapter 8,
   * Pending cleanup state). The running cleanup, and what it calls, keep
   * their whole stacks; each interrupted stack keeps only the prefix its
   * `finally` entries need, and an owner or activation none of them needs is
   * gone. The interrupted dispatch contexts count nothing.
   */
  private cancelKept(each: (size: number | null) => void) {
    const k = this.cancelControl()!;
    const u = this.controls[k] as CleanupControl;
    const step = u.cleanups[u.next - 1];
    const running = step && !step.leave ? step.frame : this.frames.length;
    const dispatches = this.controls
      .slice(0, k)
      .filter((c): c is DispatchControl => c.k === 'dispatch');
    this.frames.forEach((f, i) => {
      if (i > running) {
        each(frameSize(f));
        return;
      }
      let kept = false;
      let part = 0;
      // The owner's own continuation is under its first dispatch; each
      // activation's under the next, the last's in the frame.
      let ownStack = f.stack;
      let ownPlace = f.pc;
      let previous: DispatchControl | undefined;
      for (const d of dispatches) {
        if (d.owner !== i) {
          continue;
        }
        if (previous) {
          const n = this.finallyPrefix(f, d.place, previous.search.entry - 1);
          if (n !== null) {
            part += 48 + stackSize(d.ownerStack.slice(0, n));
            kept = true;
          }
        } else {
          ownStack = d.ownerStack;
          ownPlace = d.place;
        }
        previous = d;
        d.held.forEach((h, hi) => {
          const n = this.finallyPrefix(
            h,
            hi === d.held.length - 1 ? d.search.raised : h.pc,
            null,
          );
          if (n !== null) {
            each(frameHeader(h) + stackSize(h.stack.slice(0, n)));
          }
        });
      }
      if (previous) {
        const n =
          i === running
            ? null
            : this.finallyPrefix(f, f.pc, previous.search.entry - 1);
        if (i === running) {
          part += 48 + stackSize(f.stack);
          kept = true;
        } else if (n !== null) {
          part += 48 + stackSize(f.stack.slice(0, n));
          kept = true;
        }
      }
      const n =
        i === running && !previous
          ? null
          : this.finallyPrefix(f, ownPlace, null);
      if (i === running && !previous) {
        part += stackSize(f.stack);
        kept = true;
      } else if (n !== null) {
        part += stackSize(ownStack.slice(0, n));
        kept = true;
      }
      each(kept ? frameHeader(f) + part : null);
    });
  }

  /**
   * The stack prefix the `finally` entries of frame `f` covering `place`
   * need, only those before entry `before` if given, or null when none does.
   */
  private finallyPrefix(f: Frame, place: number, before: number | null) {
    let depth: number | null = null;
    f.code.unit.unwind.forEach((e, ei) => {
      if (
        e.kind === 'finally' &&
        place >= e.start &&
        place < e.end &&
        e.start >= f.body.start &&
        e.end <= f.body.end &&
        (before === null || ei < before)
      ) {
        depth = Math.max(depth ?? 0, e.depth);
      }
    });
    return depth;
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
        code,
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
        const fuel = charge(CLAUSE).fuel;
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
      restricted: this.frames.at(-1)?.restricted ?? false,
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

  /**
   * Tooling-only control views; never part of Inspect or saved state. The
   * frames each control retains come first, a dispatch's owner at its own
   * place, then those it holds aside; then the frames running, where a
   * policy or a `finally` block runs in a view of its retained owner.
   */
  debugFrames(): {
    frame: Frame;
    owner?: number;
    role?: 'retained' | 'dispatch';
  }[] {
    const views: {
      frame: Frame;
      owner?: number;
      role?: 'retained' | 'dispatch';
    }[] = [];
    const index = new Map<Frame, number>();
    const retain = (f: Frame, view: Frame) => {
      if (!index.has(f)) {
        index.set(f, views.length);
        views.push({ frame: view, role: 'retained' });
      }
    };
    const running = new Set<Frame>();
    this.controls.forEach((c, i) => {
      if (c.k === 'cleanup' && c.then.k === 'cancel') {
        return;
      }
      const { frames, pcs } = this.framesAt(i);
      const step = c.k === 'cleanup' ? c.cleanups[c.next - 1] : undefined;
      const top =
        c.k === 'dispatch'
          ? c.owner
          : step && !step.leave
            ? step.frame
            : frames.length - 1;
      frames.slice(0, top + 1).forEach((f, j) => {
        const parked = c.k === 'dispatch' && j === c.owner;
        const pc = parked ? c.ownerPc : pcs.get(f);
        retain(
          f,
          parked
            ? { ...f, pc: c.ownerPc, stack: c.ownerStack }
            : pc === undefined
              ? f
              : { ...f, pc },
        );
      });
      for (const f of c.held) {
        retain(f, f);
      }
      const at = frames[top];
      if (at && (c.k === 'dispatch' || (step && !step.leave))) {
        running.add(at);
      }
    });
    for (const frame of this.frames) {
      const owner = index.get(frame);
      if (owner === undefined) {
        views.push({ frame });
      } else if (running.has(frame)) {
        views.push({ frame, owner, role: 'dispatch' });
      }
    }
    return views;
  }

  // ------------------------------------------------------------- charging

  /** Charge an instruction, faulting before it does anything if it can't pay. */
  private pay(rate: number, measured: Measured = this.m, allocation = 0) {
    if (!this.charging) {
      return;
    }
    const frame = this.frame;
    const own =
      fixedCharges[rate] ?? charge(rate, measured, this.instructionCharge);
    this.payAmount(
      own.fuel + (frame.clauseCharge ? fixedCharges[CLAUSE]!.fuel : 0),
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
        ? this.fuel - this.cleanupFrom! + fuel > this.limits.cleanupBudget
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
    const rate = ins.rate;
    // Counts and subjects are instruction-local, including after a resumption.
    const m = this.m;
    resetMeasured(m);
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
        this.execute(ins, rate);
      }
    } catch (error) {
      if (error instanceof CrossingInterruptedError) {
        // Cancellation has already installed cleanup, or Stop discarded the Run.
      } else if (error instanceof ScriptError) {
        // A raise closes a hold, and what it held lands before the raise.
        const held = this.holding;
        this.holding = false;
        if (!held || !this.host?.crossing?.()) {
          this.raiseCore(error, ins, rate);
        }
      } else if (error instanceof ThrownError) {
        this.unwind(error.error, ins);
      } else if (error instanceof LimitFaultError) {
        this.holding = false;
        this.fault(error.limit, ins);
      } else {
        throw error;
      }
    } finally {
      if (clausePaid) {
        clauseChargeCallbacks.delete(this);
      }
    }
    this.finishInstruction();
  }

  /**
   * Execute the simple instructions ahead, while they spend less than `room`
   * Fuel, without the general step's machinery. These instructions cannot
   * raise, fault, suspend or write a record; anything else, or a charge the
   * Run can't pay, is left for `step`, as is every Run with something due.
   * The Group calls this only when no tooling observes the steps.
   */
  fastSteps(room: number) {
    if (
      !fastPath.enabled ||
      !this.charging ||
      this.cancelling ||
      this.resumption ||
      this.entryError ||
      this.suspended ||
      this.outcome ||
      !this.frames.length
    ) {
      return;
    }
    let frame = this.frame;
    if (frame.restricted || frame.clauseCharge) {
      return;
    }
    let { locals, stack, code } = frame;
    let instructions = code.unit.code;
    const m = this.m;
    const fuelLimit = this.limits.fuelPerRun;
    const allocLimit = this.limits.allocPerRun;
    const end = this.fuel + room;
    let fuel = this.fuel;
    let alloc = this.alloc;
    let pc = frame.pc;
    for (;;) {
      if (fuel >= end) {
        break;
      }
      const ins = instructions[pc]!;
      const opcode = ins.opcode;
      let cost: Charge | undefined;
      let result: Value | undefined;
      let iterator: Iterator | undefined;
      switch (opcode) {
        case Op.Const:
        case Op.Pop:
        case Op.Load:
        case Op.Move:
        case Op.Jump:
          cost = fixedCharges[ins.rate];
          break;
        case Op.Store:
          if (isValue(stack.at(-1))) {
            cost = fixedCharges[ins.rate];
          }
          break;
        case Op.BranchFalse:
        case Op.BranchTrue:
          if (!isBoolean(stack.at(-1))) {
            break;
          }
          cost = fixedCharges[ins.rate];
          break;
        case Op.Less:
        case Op.Greater:
        case Op.LessOrEqual:
        case Op.GreaterOrEqual:
        case Op.Equal:
        case Op.NotEqual: {
          const x = smallAt(stack.at(-2));
          const y = smallAt(stack.at(-1));
          if (Number.isNaN(x) || Number.isNaN(y)) {
            break;
          }
          cost = compareCharges[ins.rate] ??= charge(ins.rate, {
            result: bool(true),
            scanned: 0,
          });
          const holds = ordered(opcode, x, y);
          // A branch that follows takes the outcome without a Boolean,
          // when it too has room and can be paid.
          const following = instructions[pc + 1]!;
          const branch = fixedCharges[following.rate];
          if (
            (following.opcode === Op.BranchFalse ||
              following.opcode === Op.BranchTrue) &&
            branch &&
            fuel + cost.fuel < end &&
            fuel + cost.fuel + branch.fuel <= fuelLimit &&
            alloc + cost.alloc + branch.alloc <= allocLimit
          ) {
            fuel += cost.fuel + branch.fuel;
            alloc += cost.alloc + branch.alloc;
            drop(stack, 2);
            pc =
              holds === (following.opcode === Op.BranchTrue)
                ? (following.operands[0] as number)
                : pc + 2;
            continue;
          }
          result = bool(holds);
          break;
        }
        case Op.Iterate: {
          const v = stack.at(-1);
          if (isValue(v) && (v.kind === 'list' || v.kind === 'range')) {
            try {
              iterator = iteratorOver(v);
            } catch {
              break;
            }
            cost = fixedCharges[ins.rate];
          }
          break;
        }
        case Op.Next:
          cost = fixedCharges[ins.rate];
          break;
        case Op.GetKey: {
          const receiver = stack.at(-1);
          if (isValue(receiver) && receiver.kind === 'map') {
            cost = fixedCharges[ins.rate];
          }
          break;
        }
        case Op.Append: {
          const current = stack.at(-2);
          const input = stack.at(-1);
          if (
            isValue(current) &&
            isValue(input) &&
            (current.kind === 'list' || current.kind === 'text')
          ) {
            result = appendTo(current, input, 'append');
            resetMeasured(m);
            m.input = input;
            m.result = result;
            cost = charge(ins.rate, m, this.instructionCharge);
          }
          break;
        }
        case Op.Call:
          if (!this.callWouldExceedDepth()) {
            cost = fixedCharges[CALL];
          }
          break;
        case Op.Return:
          // The entry frame's return ends a Segment, which `step` checks.
          if (this.frames.length > 1 && isValue(stack.at(-1))) {
            cost = fixedCharges[ins.rate];
          }
          break;
        case Op.Add:
        case Op.Subtract:
        case Op.Multiply: {
          result = smallArithmetic(
            ins.op,
            smallAt(stack.at(-2)),
            smallAt(stack.at(-1)),
          );
          if (result) {
            cost = numberCharge(ins.rate, result);
          }
          break;
        }
      }
      if (
        !cost ||
        fuel + cost.fuel > fuelLimit ||
        alloc + cost.alloc > allocLimit
      ) {
        break;
      }
      fuel += cost.fuel;
      alloc += cost.alloc;
      const [a, b] = ins.operands;
      switch (opcode) {
        case Op.Const:
          stack.push(code.constant(a as number));
          break;
        case Op.Pop:
          stack.pop();
          break;
        case Op.Load:
          stack.push(locals[a as number]!);
          break;
        case Op.Store:
          locals[a as number] = stack.pop() as Value;
          break;
        case Op.Move:
          locals[b as number] = locals[a as number]!;
          break;
        case Op.Jump:
          pc = a as number;
          continue;
        case Op.BranchFalse:
        case Op.BranchTrue:
          if ((stack.pop() as Value).asBool() === (opcode === Op.BranchTrue)) {
            pc = a as number;
            continue;
          }
          break;
        case Op.Iterate:
          stack[stack.length - 1] = iterator!;
          break;
        case Op.Next: {
          const it = stack.at(-1) as Iterator;
          if (it.at >= it.count) {
            pc = a as number;
            continue;
          }
          it.at++;
          stack.push(iteratorItem(it.source, it.at));
          break;
        }
        case Op.GetKey:
          stack[stack.length - 1] = (stack.at(-1) as Value).get(a as string);
          break;
        case Op.Call:
        case Op.Return: {
          frame.pc = pc;
          if (opcode === Op.Call) {
            const body = code.unit.bodies[a as number]!;
            const args = stack.slice(stack.length - (b as number)) as Value[];
            this.push(code, body, this.fillDefaults(code, body, args), null);
            drop(stack, b as number);
          } else {
            const value = stack.at(-1) as Value;
            this.frames.pop();
            const caller = this.frame;
            caller.stack.push(value);
            caller.pc++;
          }
          frame = this.frame;
          ({ locals, stack, code } = frame);
          instructions = code.unit.code;
          pc = frame.pc;
          continue;
        }
        default:
          stack.pop();
          stack[stack.length - 1] = result!;
      }
      pc++;
    }
    frame.pc = pc;
    this.fuel = fuel;
    this.alloc = alloc;
  }

  /**
   * Run instructions, fast and general, while they spend less than `room`
   * Fuel and the Group has nothing to do between them: none writes a record
   * or ends, suspends or cancels the Run. Returns whether any took the
   * general step, whose aftermath the Group then handles. Like `fastSteps`,
   * only for a Run whose clause is selected and that no tooling observes.
   */
  stepMany(room: number): boolean {
    if (!fastPath.enabled) {
      return false;
    }
    const end = this.fuel + room;
    let stepped = false;
    for (;;) {
      this.fastSteps(end - this.fuel);
      const records = this.records.length;
      if (
        this.fuel >= end ||
        this.outcome ||
        this.suspended ||
        this.cancelling ||
        this.clauseChargePending ||
        this.effectStateUnknown ||
        !this.frames.length
      ) {
        return stepped;
      }
      this.step();
      stepped = true;
      if (this.records.length !== records || this.abandoning.length) {
        return stepped;
      }
    }
  }

  /** Internal: also called after a debug-deferred unwind. */
  finishInstruction() {
    if (machineDebug.get(this)?.pending) {
      return;
    }
    // An abandoned call is written after the raise that reports it.
    if (this.abandoning.length) {
      for (const id of this.abandoning) {
        this.records.push({ kind: 'abandon', id });
      }
      this.abandoning = [];
    }
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
      const own = abandonSuspension(s, 'limit');
      if (own !== undefined) {
        this.faultAbandons.push(own);
      }
      throw new LimitFaultError('persistentState', this.frame.pc);
    }
    const deadline = this.blockDeadline();
    this.suspended = deadline ? { ...s, deadline } : s;
  }

  // The deadline of the innermost Timeout Block a Suspension Point is written
  // in: the topmost on its frame's stack (chapter 8, Waiting).
  private blockDeadline(): Deadline | undefined {
    const stack = this.frame.stack;
    for (let i = stack.length - 1; i >= 0; i--) {
      const item = stack[i]!;
      if (!isValue(item) && item.k === 'deadline') {
        return item;
      }
    }
    return undefined;
  }

  // A Suspension Point reached after its block's deadline raises `timeout`
  // at once, starting nothing (chapter 5, Timeout Blocks).
  private checkDeadline(named: [string, Value][] = []) {
    const deadline = this.blockDeadline();
    if (deadline && deadline.at <= this.host!.now) {
      throw new ScriptError(
        'timeout',
        [['after', deadline.after], ...named, ['deadline', bool(true)]],
        true,
      );
    }
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
    if (r.k === 'deadline') {
      // What it waited on is abandoned, as a timeout's is (ADR 0073).
      if (s.k === 'join') {
        this.join = null;
      }
      this.abandoning = r.abandon;
      throw new ScriptError(
        'timeout',
        [
          ['after', r.after],
          ['deadline', bool(true)],
        ],
        true,
      );
    }
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
      const targets = s.members.map(m => this.memberTarget(m));
      const steps = targets.reduce(
        (sum, t) => sum + (t ? (t.kind === 'local' ? 1 : 3) : 0),
        0,
      );
      const all = charge(JOIN, { result, steps });
      const before = charge(JOIN, {});
      this.payAmount(all.fuel - before.fuel, all.alloc - before.alloc);
      for (const [i, target] of targets.entries()) {
        if (!target) {
          continue;
        }
        if (target.kind === 'local') {
          s.members[i]!.site.frame.locals[target.index] = values[i]!;
        } else {
          this.script.variables[target.index] = values[i]!;
        }
      }
      frame.stack.push(result);
      frame.pc++;
      return;
    }
    if (r.k === 'timeout') {
      const own = suspensionCall(s);
      this.abandoning = own === undefined ? [] : [own];
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
        throw new ScriptError(
          r.code,
          r.code === 'call lost' ? [] : (call?.named ?? []),
          true,
        );
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
            ['after', r.deadline ?? quantity(dec(String(r.after)), 'ms')],
            ...(call?.named ?? []),
            ...(r.deadline
              ? [['deadline', bool(true)] as [string, Value]]
              : []),
          ],
          true,
        );
      case 'fail':
        throw this.failure(call!, r.error, () => {}, r.detail);
      case 'answer':
        if (
          !functionsBelongTo([r.value], this.script.functionGroup) ||
          (call!.op.result && mismatch(r.value, call!.op.result)) ||
          (call!.args !== undefined &&
            standardChecks(call!.op)?.result?.(r.value, call!.args) === false)
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

  private memberTarget(
    m: Member,
  ): { index: number; kind: 'local' | 'variable' } | undefined {
    const { frame, pc } = m.site;
    const ins = frame.code.unit.code[pc]!;
    const offset =
      ins.opcode === Op.JoinAsk
        ? 3
        : ins.opcode === Op.JoinSend
          ? 2
          : ins.opcode === Op.JoinSendNamed
            ? 1
            : 0;
    const kind = ins.operands[offset];
    return kind === undefined
      ? undefined
      : {
          kind: kind as 'local' | 'variable',
          index: ins.operands[offset + 1] as number,
        };
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
        // As a one-clause dispatch, so a failed test ends `unhandled`. The
        // body is in the waiting frame's code unit, maybe a Library's.
        const test = new Run(
          this.script,
          [body],
          args,
          { ...this.limits, fuelPerRun: Infinity, allocPerRun: Infinity },
          s.code,
        );
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
  private getProperty(v: Value, name: string, rate: number): Value {
    const o = stateOf(v)!;
    if (name === 'id') {
      const id = text(o.handle.id);
      this.pay(rate, { result: id });
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
      this.pay(rate);
      return nothing;
    }
    const ctx = this.propContext(o, name, prop.getCost);
    this.pay(rate);
    this.payAmount(ctx.declared, prop.getCost?.alloc ?? 0);
    let result: unknown;
    try {
      result = prop.get(o.handle);
    } catch (error) {
      throw this.failure(
        ctx,
        error instanceof HostScriptError ? error : null,
        failed =>
          this.hostCrossing({
            kind: 'prop',
            object: v,
            name,
            op: 'get',
            error: failed,
          }),
        hostDetail(error),
      );
    }
    if (
      !Value.isValue(result) ||
      !functionsBelongTo([result], this.script.functionGroup) ||
      (prop.shape && mismatch(result, prop.shape))
    ) {
      this.hostCrossing({
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
    this.hostCrossing({
      kind: 'prop',
      object: v,
      name,
      op: 'get',
      value: result,
    });
    this.payConversion(ctx, result, 0);
    return result;
  }

  // The receiver of `element s of o` or `the number of elements of o`, after
  // its selector's checks: a live object whose kind has a collection.
  private collectionOf(v: Value, fn: string) {
    const o = stateOf(v);
    if (!o) {
      throw wrongKind('object', v);
    }
    if (o.disposed) {
      throw new ScriptError('object gone', [['object', v]]);
    }
    const elements = o.handle.kind.elements;
    if (!elements) {
      throw new ScriptError('out of domain', [
        ['function', text(fn)],
        ['value', v],
      ]);
    }
    return { o, elements };
  }

  /**
   * `element s of o` (#1143): the selector is checked, then the receiver,
   * and one Host callback answers, charged and recorded as a property
   * getter is. Zero and positions past 2^53 - 1 select nothing.
   */
  private getElement(selector: Value, v: Value, rate: number): Value {
    this.m.input = selector;
    this.pay(rate);
    return paidOnce(() => this.selectElement(selector, v));
  }

  private selectElement(selector: Value, v: Value): Value {
    let index: number | null = null;
    if (selector.kind === 'number') {
      const d = decimalParts(selector.asDecimal()!);
      if (!isInteger(d)) {
        throw wrongKind('integer', selector);
      }
      const n = integerOf(d);
      const bound = BigInt(Number.MAX_SAFE_INTEGER);
      index = n === 0n || n > bound || n < -bound ? 0 : Number(n);
    } else if (selector.kind !== 'text') {
      throw wrongKind('number or text', selector);
    }
    const { o, elements } = this.collectionOf(v, 'element');
    if (index === 0) {
      return nothing;
    }
    return index === null
      ? this.elementCall(o, v, 'find', selector, elements.findCost, () =>
          elements.find(o.handle, selector.asText()!),
        )
      : this.elementCall(o, v, 'at', selector, elements.atCost, () =>
          elements.at(o.handle, index),
        );
  }

  /** `the number of elements of o` (#1143): the Host's count, one callback. */
  private countElements(v: Value, rate: number): Value {
    this.pay(rate);
    return paidOnce(() => {
      const { o, elements } = this.collectionOf(v, 'number of elements');
      return this.elementCall(o, v, 'count', null, elements.countCost, () =>
        elements.count(o.handle),
      );
    });
  }

  /**
   * `the elements of o` (#1627): the 3-Fuel base, the receiver's checks,
   * one `Count`, one `At` per position, then the list's own charge.
   */
  private listElements(v: Value, rate: number): Value {
    this.pay(COUNT_ELEMENTS);
    const members = paidOnce(() => {
      const { o, elements } = this.collectionOf(v, 'elements');
      const count = this.elementCall(
        o,
        v,
        'count',
        null,
        elements.countCost,
        () => elements.count(o.handle),
      );
      const n = Number(count.asDecimal()!.toString());
      const items: Value[] = [];
      for (let i = 1; i <= n; i++) {
        items.push(
          this.elementCall(
            o,
            v,
            'at',
            num(i),
            elements.atCost,
            () => elements.at(o.handle, i),
            true,
          ),
        );
      }
      return listValues(items);
    });
    this.m.result = members;
    if (this.charging) {
      const own = charge(rate, this.m);
      const base = fixedCharges[COUNT_ELEMENTS]!;
      this.payAmount(own.fuel - base.fuel, own.alloc - base.alloc);
    }
    return members;
  }

  // One collection callback: its declared cost first, then the call, its
  // `prop` crossing and its result's checks and conversion.
  private elementCall(
    o: ObjectState,
    v: Value,
    op: 'count' | 'at' | 'find',
    selector: Value | null,
    cost: { alloc?: number; fuel: number },
    call: () => unknown,
    required = false,
  ): Value {
    const ctx = this.propContext(o, `elements.${op}`, cost);
    this.payAmount(ctx.declared, cost.alloc ?? 0);
    const record = (extra: { error?: Value; value?: Value }) =>
      this.hostCrossing({
        kind: 'prop',
        object: v,
        name: 'elements',
        op,
        ...(selector ? { selector } : {}),
        ...extra,
      });
    let result: unknown;
    try {
      result = call();
    } catch (error) {
      throw this.failure(
        ctx,
        error instanceof HostScriptError ? error : null,
        failed => record({ error: failed }),
        hostDetail(error),
      );
    }
    const detail =
      required && Value.isValue(result) && result.kind === 'nothing'
        ? 'its member is missing below its count'
        : this.elementResultDetail(o, op, result);
    if (detail) {
      record({ error: map([]) });
      throw this.hostError(ctx, detail);
    }
    record({ value: result as Value });
    this.payConversion(ctx, result as Value, 0);
    return result as Value;
  }

  // What is wrong with a collection callback's result, or null.
  private elementResultDetail(
    o: ObjectState,
    op: 'count' | 'at' | 'find',
    result: unknown,
  ): string | null {
    if (!Value.isValue(result)) {
      return 'its result is not a Value';
    }
    if (op === 'count') {
      if (result.kind !== 'number') {
        return 'its count is not a number';
      }
      const d = decimalParts(result.asDecimal()!);
      const n = isInteger(d) ? integerOf(d) : -1n;
      return n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)
        ? 'its count is not an integer from 0 to 2^53 - 1'
        : null;
    }
    if (result.kind === 'nothing') {
      return null;
    }
    const shape = o.handle.kind.elements!.shape;
    if (mismatch(result, shape)) {
      return resultDetail(result, shape, this.script.functionGroup);
    }
    const member = stateOf(result)!;
    if (member.disposed) {
      return 'its member is disposed';
    }
    if (this.host && !this.host.holdsObject(result)) {
      return 'its member belongs to another Group';
    }
    return null;
  }

  /** `set the p of o to v`: the Host's `Set`, after the value's Shape check. */
  private setProperty(v: Value, name: string, value: Value, rate: number) {
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
    this.pay(rate, { input: value });
    this.payAmount(ctx.declared, prop.setCost?.alloc ?? 0);
    try {
      prop.set(o.handle, value);
    } catch (error) {
      throw this.failure(
        ctx,
        error instanceof HostScriptError ? error : null,
        failed =>
          this.hostCrossing({
            kind: 'prop',
            object: v,
            name,
            op: 'set',
            value,
            error: failed,
          }),
        hostDetail(error),
      );
    }
    this.hostCrossing({ kind: 'prop', object: v, name, op: 'set', value });
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
      rate: CAPABILITY,
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
    // A cancellation's cleanup keeps only the frames and activations it still
    // needs; the dispatches it interrupted are gone.
    const cancel = this.cancelControl();
    if (cancel === undefined) {
      for (const f of this.frames) {
        frames += frameSize(f);
      }
    } else {
      this.cancelKept(n => {
        frames += n ?? 0;
      });
    }
    // Each catch dispatch: its Error, its activation, the owner's own stack
    // and the failed frames it holds aside. A pending cleanup has no size of
    // its own; it keeps its Error's context, an acceptance's activation, a
    // transfer's arguments, the failed frames it holds aside and the failed
    // continuation's operands (chapter 8, Pending cleanup state).
    this.controls.forEach((c, i) => {
      if (c.k === 'dispatch' && cancel !== undefined && i < cancel) {
        return;
      }
      for (const f of c.held) {
        frames += frameSize(f);
      }
      if (c.k === 'dispatch') {
        frames += 96 + sizeOf(c.error) + 48 + stackSize(c.ownerStack);
        return;
      }
      const t = c.then;
      if (t.k === 'accept') {
        frames += 96 + sizeOf(c.error) + 48 + stackSize(t.stack) + c.failed;
      } else if (t.k === 'end' || t.k === 'search') {
        frames += 96 + sizeOf(c.error) + c.failed;
      } else if (t.k === 'transfer') {
        // Until its `leave`, the dispatch under it holds the context.
        if (c.left) {
          frames += 96 + sizeOf(c.error);
        }
        frames +=
          8 * t.args.length +
          c.failed +
          t.args.reduce((total, v) => total + sizeOf(v), 0);
      }
    });
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
  private leaveJoin(
    handler: number,
    target: number | undefined,
    copied?: number,
  ) {
    const join = this.join;
    if (!join) {
      return;
    }
    const found = this.frames.indexOf(join.frame);
    const at = found === copied ? -1 : found;
    if (handler > at) {
      return;
    }
    if (handler === at && target !== undefined) {
      const code = join.frame.code.unit.code;
      let end = join.start;
      while (end < code.length && code[end]!.opcode !== Op.JoinEnd) {
        end++;
      }
      if (target > join.start && target <= end) {
        return;
      }
    }
    for (const id of this.abandonJoin('join-ended')) {
      this.records.push({ kind: 'abandon', id });
    }
  }

  // Abandon the open Join's members, signalling their Capability calls.
  private abandonJoin(reason: AbandonReason): string[] {
    const join = this.join;
    this.join = null;
    return abandonMembers(join?.members ?? [], reason);
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
    this.controls = [];
    // A Join's members are abandoned, after the fault (chapter 5, Joins).
    this.faultAbandons.push(...this.abandonJoin('limit'));
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
  private raiseCore(error: ScriptError, ins: Instruction, rate: number) {
    try {
      if (!error.uncharged) {
        this.pay(rate, { ...this.m, result: undefined });
      } else if (this.frame.clauseCharge) {
        // Validation and lifecycle guards skip the instruction's charge,
        // but dispatch still pays for trying this Handler Clause.
        this.payAmount(charge(CLAUSE).fuel, 0);
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
      (ins.opcode === Op.BranchFalse || ins.opcode === Op.BranchTrue) &&
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
    if (!skip) {
      this.raisedAt = at;
    }
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
      this.controls = [];
      this.outcome = {
        kind: 'cancelled',
        cleanupFailed: { code: textForm(error.get('code')) },
      };
      return;
    }
    const guard = this.activeEntries(this.frame).find(e => e.kind !== 'offer');
    this.record(error, ins, guard?.kind === 'guard');
    if (guard?.kind === 'guard') {
      drop(this.frame.stack, this.frame.stack.length - guard.depth);
      this.frame.pc = guard.target;
      return;
    }
    const top = this.frames.length - 1;
    this.search(error, {
      frame: top,
      entry: 0,
      raised: this.frame.pc,
      limit: this.limitOf(),
      position: top + 1,
      skip: null,
    });
  }

  private activeEntries(frame: Frame) {
    return frame.code.unit.unwind.filter(
      e => frame.pc >= e.start && frame.pc < e.end,
    );
  }

  // The failed frames the Run's controls hold aside, which count toward its
  // call depth, as do a cancellation's frames only while its cleanup needs
  // them (chapter 8, Pending cleanup state).
  private callWouldExceedDepth() {
    // A Run with no error control has only its frames.
    const depth = this.controls.length ? this.depth() : this.frames.length;
    return depth + 1 > this.limits.callDepth;
  }

  private depth() {
    const cancel = this.cancelControl();
    if (cancel === undefined) {
      let n = this.frames.length;
      for (const c of this.controls) {
        n += c.held.length;
      }
      return n;
    }
    let n = 0;
    this.cancelKept(kept => {
      n += kept === null ? 0 : 1;
    });
    return n;
  }

  // ------------------------------------------------------------ unwinding

  /** The place frame `index` is at: `raised` for the top frame. */
  private framePc(index: number, raised: number) {
    return index === this.frames.length - 1 ? raised : this.frames[index]!.pc;
  }

  /**
   * Whether entry `ei` of frame `index` is one a search or a cleanup may use:
   * in the frame's own body, inside `limit` at its frame, and not one `skip`
   * has already done.
   */
  private usable(
    frame: Frame,
    index: number,
    e: UnwindEntry,
    ei: number,
    limit: Limit | null,
    skip: Limit | null,
  ) {
    if (e.start < frame.body.start || e.end > frame.body.end) {
      return false;
    }
    if (limit && index === limit.frame && ei >= limit.entry) {
      return false;
    }
    return !(skip && index === skip.frame && ei < skip.entry);
  }

  /**
   * The innermost control bounding an error raised now: a dispatch's policy,
   * or the `finally` block a cleanup is running.
   */
  private limitOf(): Limit | null {
    const c = this.controls.at(-1);
    if (!c) {
      return null;
    }
    if (c.k === 'dispatch') {
      return { frame: c.owner, entry: c.search.entry - 1 };
    }
    const step = c.cleanups[c.next - 1];
    return step && !step.leave
      ? { frame: step.frame, entry: step.entry }
      : null;
  }

  /**
   * Searches for a catch from `s`'s frame and entry outward, within its
   * limit. A covering catch starts its dispatch; an error that escapes its
   * bound goes on outward from it (chapter 6, Catching).
   */
  private search(error: Value, s: Search) {
    let position = s.position;
    const lowest = s.limit ? s.limit.frame : 0;
    for (let index = s.frame; index >= lowest; index--) {
      const frame = this.frames[index]!;
      const pc = this.framePc(index, s.raised);
      const unwind = frame.code.unit.unwind;
      for (let ei = index === s.frame ? s.entry : 0; ei < unwind.length; ei++) {
        const e = unwind[ei]!;
        if (
          e.kind !== 'catch' ||
          pc < e.start ||
          pc >= e.end ||
          !this.usable(frame, index, e, ei, s.limit, null)
        ) {
          continue;
        }
        // Each search step charges the frames it leaves.
        this.pay(UNWIND, { frames: Math.max(0, position - (index + 1)) });
        position = index + 1;
        this.beginDispatch(error, index, e, {
          frame: index,
          entry: ei + 1,
          raised: s.raised,
          limit: s.limit,
          position,
          skip: s.skip,
        });
        return;
      }
    }
    if (!s.limit) {
      this.leaveJoin(-1, undefined);
      this.pay(UNWIND, { frames: position });
      this.startCleanup(error, this.collect(0, null, s.skip, s.raised), {
        k: 'end',
      });
      return;
    }
    // It escapes the control that bounds it.
    const bound = this.controls.at(-1)!;
    if (bound.k === 'dispatch') {
      return this.abortRecovery(error, s.raised, position, s.skip);
    }
    const at = bound.cleanups[bound.next - 1]!;
    // An aborted policy's own `finally` blocks run in its activation, which
    // this search leaves as a frame.
    if (bound.then.k === 'search' && !bound.left) {
      this.pay(UNWIND, { frames: 1 });
    }
    const replaced = this.addDuring(error, bound.error);
    this.controls.pop();
    this.search(replaced, {
      frame: at.frame,
      entry: at.entry,
      raised: s.raised,
      limit: this.limitOf(),
      position,
      skip: null,
    });
  }

  /**
   * Starts a catch's tests in frame `owner`: its own operand stack, the
   * owner's iterator prefix and the error, over the owner's locals. The
   * failed frames above it are held aside until the dispatch ends.
   */
  private beginDispatch(
    error: Value,
    owner: number,
    entry: UnwindEntry,
    search: Search,
  ) {
    const held = this.frames.splice(owner + 1);
    const f = this.frames[owner]!;
    this.controls.push({
      k: 'dispatch',
      error,
      owner,
      place: held.length ? f.pc : search.raised,
      held,
      ownerStack: f.stack,
      ownerPc: f.pc,
      search,
    });
    f.stack = [...f.stack.slice(0, entry.depth), error];
    f.pc = entry.target;
    f.clauseCharge = false;
  }

  /**
   * Ends the top dispatch: the owner gets its own stack and place back, and
   * the held frames return.
   */
  private endDispatch(): DispatchControl {
    const d = this.controls.pop() as DispatchControl;
    const f = this.frames[d.owner]!;
    f.stack = d.ownerStack;
    f.pc = d.ownerPc;
    this.frames.length = d.owner + 1;
    this.frames.push(...d.held);
    return d;
  }

  /** `catch-next`: the search goes on outward from the next entry. */
  private nextCatch() {
    const d = this.endDispatch();
    this.search(d.error, d.search);
  }

  /**
   * `catch-accept`: the exited `finally` blocks run, innermost first, then
   * the owner goes on after the instruction with the activation's stack.
   */
  private acceptCatch() {
    const d = this.controls.at(-1) as DispatchControl;
    const f = this.frames[d.owner]!;
    const then: Then = {
      k: 'accept',
      frame: d.owner,
      pc: f.pc + 1,
      stack: f.stack,
    };
    const ended = this.endDispatch();
    this.startCleanup(
      ended.error,
      this.collect(
        ended.owner,
        ended.search.entry - 1,
        ended.search.skip,
        ended.search.raised,
      ),
      then,
    );
  }

  /**
   * An error escaping a Recovery policy: its original error becomes the new
   * one's `during`, the policy's exited `finally` blocks and then the
   * failure's run, and the search goes on outward from the catching `try`,
   * past its other catches (chapter 6, Catching).
   */
  private abortRecovery(
    error: Value,
    raised: number,
    position: number,
    skip: Limit | null,
  ) {
    const d = this.controls.at(-1) as DispatchControl;
    const replaced = this.addDuring(error, d.error);
    const cleanups = this.collect(d.owner, d.search.entry - 1, skip, raised);
    cleanups.push(LEAVE);
    // The search goes on from where the policy failed, which is outside the
    // catching `try`'s own offers.
    const search: Search = {
      ...d.search,
      position,
      raised:
        this.frames.length - 1 === d.owner ? raised : this.frames[d.owner]!.pc,
    };
    this.startCleanup(replaced, cleanups, { k: 'search', search });
  }

  /**
   * The `finally` entries covering each frame's place from the top down to
   * `low`, innermost first: in `low`, only those before `before`, and none
   * `skip` has run.
   */
  private collect(
    low: number,
    before: number | null,
    skip: Limit | null,
    raised: number,
  ): CleanupStep[] {
    const list: CleanupStep[] = [];
    const limit = before === null ? null : { frame: low, entry: before };
    for (let index = this.frames.length - 1; index >= low; index--) {
      const frame = this.frames[index]!;
      const pc = this.framePc(index, raised);
      frame.code.unit.unwind.forEach((e, ei) => {
        if (
          e.kind === 'finally' &&
          pc >= e.start &&
          pc < e.end &&
          this.usable(frame, index, e, ei, limit, skip)
        ) {
          list.push({
            frame: index,
            target: e.target,
            depth: e.depth,
            entry: ei,
            leave: false,
          });
        }
      });
    }
    return list;
  }

  /** Pushes a cleanup, then runs its first `finally` block or what follows. */
  private startCleanup(error: Value, cleanups: CleanupStep[], then: Then) {
    this.controls.push({
      k: 'cleanup',
      error,
      cleanups,
      next: 0,
      then,
      left: false,
      failed: 0,
      failedFrame: null,
      held: [],
    });
    this.nextCleanup();
  }

  /** Runs the next scheduled `finally` block, or what follows the last. */
  private nextCleanup() {
    for (;;) {
      const u = this.controls.at(-1);
      if (u?.k !== 'cleanup') {
        return;
      }
      if (u.next < u.cleanups.length) {
        const c = u.cleanups[u.next++]!;
        if (c.leave) {
          this.leaveDispatch();
          continue;
        }
        // Entering cleanup doesn't replace the failed continuation's
        // operands; a cancellation keeps only the prefix.
        if (u.then.k !== 'cancel' && u.failedFrame !== c.frame) {
          // A held frame keeps what its own cleanup cut.
          const k = u.failedFrame;
          const carried =
            k !== null && k > c.frame && k < this.frames.length
              ? Math.max(0, u.failed - stackSize(this.frames[k]!.stack))
              : 0;
          u.failed = carried + stackSize(this.frames[c.frame]!.stack);
          u.failedFrame = c.frame;
        }
        // The failed frames above stay retained until the cleanup ends; a
        // cancellation's are gone.
        const above = this.frames.splice(c.frame + 1);
        if (u.then.k !== 'cancel') {
          u.held.unshift(...above);
        }
        const f = this.frames[c.frame]!;
        drop(f.stack, f.stack.length - c.depth);
        f.pc = c.target;
        f.clauseCharge = false;
        return;
      }
      const copied = this.copiedFrame(u);
      this.controls.pop();
      const then = u.then;
      switch (then.k) {
        case 'accept': {
          this.leaveJoin(then.frame, then.pc, copied);
          this.frames.length = then.frame + 1;
          const f = this.frames[then.frame]!;
          f.stack = then.stack;
          f.pc = then.pc;
          return;
        }
        case 'end':
          this.leaveJoin(-1, undefined);
          this.checkState();
          this.frames = [];
          this.outcome = {
            kind: 'errored',
            error: u.error,
            at: this.raisedAt!,
          };
          return;
        case 'cancel':
          this.frames = [];
          this.outcome = { kind: 'cancelled' };
          return;
        case 'transfer':
          return this.enterOffer(then, copied);
        case 'search':
          // The frames above the catching one are gone; it goes on from its
          // own place.
          this.frames.length = then.search.frame + 1;
          return this.search(u.error, {
            ...then.search,
            skip: { frame: then.search.frame, entry: then.search.entry },
          });
      }
    }
  }

  /**
   * The frame a failure's last `finally` block ran in, if one did after the
   * dispatch under it ended. `leaveJoin` doesn't find a Join's frame there,
   * as before these records, when that block's copy stood in for it; #1742
   * tracks abandoning the Join then.
   */
  private copiedFrame(u: CleanupControl): number | undefined {
    const step = u.cleanups[u.next - 1];
    return step && !step.leave ? step.frame : undefined;
  }

  /**
   * Ends the dispatch under the running cleanup once its policy's own
   * `finally` blocks have run, and schedules the failure's: down to the
   * offering frame for a transfer, or to the catching one for an abort.
   */
  private leaveDispatch() {
    const u = this.controls.pop() as CleanupControl;
    const ended = this.endDispatch();
    this.controls.push(u);
    u.left = true;
    const raised = ended.search.raised;
    let more: CleanupStep[];
    if (u.then.k === 'transfer') {
      more = this.collect(u.then.frame, u.then.offerEntry, null, raised);
    } else if (u.then.k === 'cancel') {
      // A cancellation's cleanup goes on to the next dispatch's policy, which
      // it leaves in turn, or to the Run's first frame.
      const outer = this.controls.at(-2);
      if (outer?.k === 'dispatch') {
        more = this.collect(outer.owner, outer.search.entry - 1, null, raised);
        more.push(LEAVE);
      } else {
        more = this.collect(0, null, null, raised);
      }
    } else {
      more = this.collect(ended.owner, ended.search.entry - 1, null, raised);
    }
    u.cleanups.splice(u.next, 0, ...more);
  }

  private addDuring(error: Value, original: Value) {
    return hasKey(error, 'during') ? error : this.withDuring(error, original);
  }

  private withDuring(error: Value, original: Value) {
    const replacement = map([...error.entries(), ['during', original]]);
    if (coreRaised.has(error)) {
      coreRaised.add(replacement);
    }
    return replacement;
  }

  // ------------------------------------------------------------ offers

  /** The innermost dispatch, whose failure chain offers are chosen from. */
  private recovery(): DispatchControl | undefined {
    for (let i = this.controls.length - 1; i >= 0; i--) {
      const c = this.controls[i]!;
      if (c.k === 'dispatch') {
        return c;
      }
    }
    return undefined;
  }

  /**
   * The current recovery's failure chain: the innermost dispatch's, or once
   * a transfer's dispatch has ended, the frames its cleanup is leaving, whose
   * offers stay eligible until the action is entered.
   */
  private chain():
    { d: DispatchControl } | { frames: Limit | null } | undefined {
    for (let i = this.controls.length - 1; i >= 0; i--) {
      const c = this.controls[i]!;
      if (c.k === 'dispatch') {
        return { d: c };
      }
      if (c.left && c.then.k === 'transfer') {
        return { frames: c.then.limit };
      }
    }
    return undefined;
  }

  /**
   * Looks `name` up in a failure chain: a dispatch's held frames, its owner at
   * its place, then the frames below it within its limit; or the Run's
   * frames. Innermost first, each try's offers in source order; `frames`
   * counts the frames scanned.
   */
  private lookupOffer(
    name: string,
    chain = this.chain(),
  ): {
    entry?: number;
    frame?: Frame;
    frames: number;
    index?: number;
    offer?: { binds: number[]; name: string; target: number };
    position?: number;
    record?: number;
  } {
    if (!chain) {
      return { frames: 0 };
    }
    const d = 'd' in chain ? chain.d : undefined;
    const limit = d
      ? d.search.limit
      : (chain as { frames: Limit | null }).frames;
    const lowest = limit ? limit.frame : 0;
    let frames = 0;
    const top = d ? d.owner + d.held.length : this.frames.length - 1;
    for (let level = top; level >= lowest; level--) {
      frames++;
      const frame =
        d && level > d.owner
          ? d.held[level - d.owner - 1]!
          : this.frames[level]!;
      const place = !d
        ? frame.pc
        : level === top
          ? d.search.raised
          : level === d.owner
            ? d.place
            : frame.pc;
      const unwind = frame.code.unit.unwind;
      for (let ei = 0; ei < unwind.length; ei++) {
        const e = unwind[ei]!;
        if (
          e.kind !== 'offer' ||
          place < e.start ||
          place >= e.end ||
          e.start < frame.body.start ||
          e.end > frame.body.end ||
          (limit && level === limit.frame && ei >= limit.entry)
        ) {
          continue;
        }
        const offers = frame.code.unit.offers![e.target]!.offers;
        const position = offers.findIndex(o => o.name === name);
        if (position >= 0) {
          return {
            frames,
            frame,
            index: level,
            entry: ei,
            record: e.target,
            position,
            offer: offers[position]!,
          };
        }
      }
    }
    return { frames };
  }

  /**
   * `choose-offer`: the nearest offer named `name` in the failure chain, with
   * exactly `count` arguments. Its policy's own `finally` blocks run, then
   * the failure's down to the offering `try`, then the action is entered.
   */
  private chooseOffer(name: string, count: number, ins: Instruction) {
    const d = this.recovery();
    const found = d ? this.lookupOffer(name, { d }) : { frames: 0 };
    this.m.count = count;
    this.pay(CHOOSE_OFFER);
    this.pay(OFFER_LOOKUP, { frames: found.frames });
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
    drop(this.frame.stack, count);
    const attempt = ++this.offerAttempt;
    this.records.push({
      kind: 'offer-chosen',
      attempt,
      name,
      at: { unit: this.frame.code.name, pc: this.frame.pc },
      target: { unit: found.frame!.code.name, pc: found.offer.target },
      args,
    });
    const cleanups = this.collect(
      d!.owner,
      d!.search.entry - 1,
      null,
      this.frame.pc,
    );
    cleanups.push(LEAVE);
    this.startCleanup(d!.error, cleanups, {
      k: 'transfer',
      frame: found.index!,
      offerEntry: found.entry!,
      record: found.record!,
      offer: found.position!,
      args,
      attempt,
      limit: d!.search.limit,
    });
  }

  /**
   * Enters a chosen action: the frames above its `try` are gone, its
   * parameters bind at once, and it starts at its entry.
   */
  private enterOffer(t: Then & { k: 'transfer' }, copied?: number) {
    const frame = this.frames[t.frame]!;
    const offer = frame.code.unit.offers![t.record]!.offers[t.offer]!;
    this.leaveJoin(t.frame, offer.target, copied);
    this.frames.length = t.frame + 1;
    frame.stack = frame.stack.slice(
      0,
      frame.code.unit.unwind[t.offerEntry]!.depth,
    );
    frame.pc = offer.target;
    offer.binds.forEach((slot, i) => {
      frame.locals[slot] = t.args[i]!;
    });
    this.records.push({
      kind: 'offer-entered',
      attempt: t.attempt,
      target: { unit: frame.code.name, pc: offer.target },
    });
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
    if (this.callWouldExceedDepth()) {
      throw new LimitFaultError('callDepth', this.frame.pc);
    }
    this.pay(CALL);
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
    rate: number,
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
    standardChecks(op)?.arguments?.(args, grant.binding, named);
    if (op.mode === 'suspending') {
      if (!member) {
        this.checkDeadline(named);
      }
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
    const segmentBound = op.mode === 'immediate' && op.segmentBound;
    const conflict =
      segmentBound && this.participant.conflict(grantName, grant);
    if (conflict) {
      throw new ScriptError(
        'segment participant conflict',
        [...named, ['participant', text(conflict)]],
        true,
      );
    }
    const declared = op.cost.fuel;
    this.pay(rate, { declared }, op.cost.alloc ?? 0);
    const begun = segmentBound
      ? this.participant.enroll(grantName, grant, this.participantSite)
      : 'ok';
    if (begun === 'failed') {
      throw new ScriptError('host error', named, true);
    }
    if (begun === 'unknown') {
      throw new CrossingInterruptedError();
    }
    const id = `${this.id}.c${++this.calls}`;
    const ctx: CallContext = {
      id,
      op,
      rate,
      named,
      declared,
      opName: `${grantName}.${opName}`,
      adoptable: op.mode === 'suspending' && !!op.start,
      ...(op.mode === 'suspending' && standardChecks(op)?.result
        ? { args: [...args] }
        : {}),
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
      ...(host.delivery ? { delivery: host.delivery } : {}),
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
            ? this.fuel - this.cleanupFrom! + fuel > this.limits.cleanupBudget
            : this.fuel + fuel > this.limits.fuelPerRun)
        ) {
          reached = true;
          throw new LimitReached('the Run can’t cover this charge');
        }
        this.fuel += fuel;
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
    this.host?.expose?.(listValues(args));
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
        this.hostCrossing({ ...record, charged });
        throw new LimitFaultError(
          this.cancelling ? 'cleanupBudget' : 'fuelPerRun',
          this.frame.pc,
        );
      }
      throw this.failure(
        ctx,
        error instanceof HostScriptError ? error : null,
        failed => this.hostCrossing({ ...record, charged, error: failed }),
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
          )! as ValueImmediateOp<unknown>,
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
      this.hostCrossing({ ...record, charged }, acknowledgement);
      throw new LimitFaultError(
        this.cancelling ? 'cleanupBudget' : 'fuelPerRun',
        this.frame.pc,
      );
    }
    if (op.mode === 'suspending') {
      this.hostCrossing({ ...record, charged });
      const ms = op.maxPendingMs ?? this.limits.maxWaitMs;
      if (member) {
        this.join!.members.push({
          site: { frame: this.frame, pc: this.frame.pc },
          id,
          call: ctx,
          abort,
          ms,
          at: this.host!.now + BigInt(ms) * 1000n,
        });
      } else {
        // The Host has consumed the operands. Retain the call, not another
        // copy of its arguments on the frame's operand stack.
        drop(this.frame.stack, args.length);
        this.suspend({ k: 'ask', call: ctx, abort, ms });
      }
      return nothing;
    }
    if (op.mode === 'fire-and-forget') {
      this.hostCrossing({ ...record, charged });
      return nothing;
    }
    if (
      !Value.isValue(result) ||
      !functionsBelongTo([result], this.script.functionGroup) ||
      (op.result && mismatch(result, op.result)) ||
      standardChecks(op)?.result?.(result, args) === false
    ) {
      this.hostCrossing(
        { ...record, charged, error: map([]) },
        acknowledgement,
      );
      throw this.hostError(
        ctx,
        resultDetail(result, op.result, this.script.functionGroup),
      );
    }
    this.hostCrossing({ ...record, charged, result }, acknowledgement);
    this.payConversion(ctx, result, 0);
    return result;
  }

  // Promise-returning Operations automatically forward their result. A refused
  // answer or failure must settle the wait, rather than reject an unobserved Promise.
  private forwardResult(result: Promise<Value>, call: Call<unknown>) {
    const forwarded = result
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
    trackOperation(call.group, call, forwarded);
  }

  // A Host Crossing records the call/property and acknowledgement before
  // landing queued inputs and checking whether they interrupted the Run.
  private hostCrossing(
    record: Extract<RunRecord, { kind: 'call' | 'prop' }>,
    acknowledgement?: Extract<RunRecord, { kind: 'scope' }>,
  ) {
    this.records.push(record);
    if (acknowledgement) {
      this.records.push(acknowledgement);
    }
    if (!this.holding && this.host?.crossing?.()) {
      throw new CrossingInterruptedError();
    }
    this.crossingCall = null;
  }

  // `host error` for a call, with its `call-failed` record, which carries the
  // Host-side detail the Script never sees (chapter 6).
  private hostError(ctx: CallContext, detail: string): ScriptError {
    // Property failures have no call id and no additional Trace record, but
    // their Host-only detail still belongs in the public failure report.
    this.records.push({
      kind: 'call-failed',
      id: ctx.id,
      op: ctx.opName,
      detail,
    });
    return new ScriptError('host error', ctx.named, true);
  }

  // A result's conversion, and any late cost, charged at the call.
  private payConversion(ctx: CallContext, result: Value, late: number) {
    const conversion = charge(ctx.rate, { declared: ctx.declared, result });
    const before = charge(ctx.rate, { declared: ctx.declared });
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
    if (
      !Value.isValue(error.data) ||
      (error.data.kind !== 'map' && error.data.kind !== 'nothing')
    ) {
      record(map([]));
      return this.hostError(ctx, 'failure Data is neither a map nor Nothing');
    }
    const data = error.data.kind === 'map' ? error.data : map([]);
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

  private restrictedOperation(ins: Instruction): boolean {
    switch (ins.opcode) {
      case Op.LoadVar:
      case Op.StoreVar:
      case Op.StoreDefinition:
      case Op.LoadObject:
      case Op.Me:
      case Op.Target:
      case Op.SetProperty:
      case Op.SetPropertyComputed:
      case Op.Ask:
      case Op.AskWait:
      case Op.Tell:
      case Op.Send:
      case Op.SendWait:
      case Op.SendNamed:
      case Op.SendNamedWait:
      case Op.SendSpread:
      case Op.SendSpreadWait:
      case Op.SendUp:
      case Op.SendUpWait:
      case Op.Wait:
      case Op.WaitFor:
      case Op.WaitForAny:
      case Op.JoinStart:
      case Op.JoinAsk:
      case Op.JoinSend:
      case Op.JoinSendNamed:
      case Op.JoinSendSpread:
      case Op.JoinEnd:
      case Op.TimeoutStart:
      case Op.TimeoutEnd:
      case Op.CallValueWait:
      case Op.CallHandlerWait:
      case Op.Veto:
      case Op.Pass:
      case Op.ChooseOffer:
        return true;
      case Op.CallBuiltin:
        return (
          ins.operands[0] === 'isDisposed' ||
          ins.operands[0] === 'offerAvailable' ||
          ins.operands[0] === 'random'
        );
      case Op.GetElement:
      case Op.CountElements:
      case Op.ListElements:
        return true;
      case Op.GetKey:
      case Op.GetKeyComputed:
        return (
          this.peek().kind === 'object' &&
          (ins.opcode === Op.GetKey
            ? ins.operands[0] !== 'id'
            : this.peek(1).asText() !== 'id')
        );
      default:
        return false;
    }
  }

  private execute(ins: Instruction, rate: number) {
    const frame = this.frame;
    if (frame.restricted && this.restrictedOperation(ins)) {
      this.pay(RESTRICTED_REFUSAL);
      throw new ThrownError(
        this.errorMap(
          'restricted operation',
          [['instruction', text(ins.op)]],
          ins,
        ),
      );
    }
    const [a, b, c] = ins.operands;
    const m = this.m;
    const code = frame.code;
    const unit = code.unit;
    switch (ins.opcode) {
      // Values and slots
      case Op.Const: {
        const value = code.constant(a as number);
        this.pay(rate);
        frame.stack.push(value);
        return next(frame);
      }
      case Op.Pop:
        this.pay(rate);
        frame.stack.pop();
        return next(frame);
      case Op.Load:
        this.pay(rate);
        frame.stack.push(frame.locals[a as number]!);
        return next(frame);
      case Op.Store:
        this.pay(rate);
        frame.locals[a as number] = this.pop();
        return next(frame);
      case Op.Move:
        this.pay(rate);
        frame.locals[b as number] = frame.locals[a as number]!;
        return next(frame);
      case Op.LoadVar:
        this.pay(rate);
        frame.stack.push(this.script.variables[a as number]!);
        return next(frame);
      case Op.StoreVar:
        this.pay(rate);
        this.script.variables[a as number] = this.pop();
        return next(frame);
      case Op.LoadDefinition:
        this.pay(rate);
        frame.stack.push(
          homeConstant(
            code.definitions[a as number]!,
            this.script.home ?? this.script,
          ),
        );
        return next(frame);
      case Op.StoreDefinition:
        this.pay(rate);
        code.definitions[a as number] = this.pop();
        return next(frame);

      // Control
      case Op.Jump:
        this.pay(rate);
        return jump(frame, a as number);
      case Op.Hold:
        this.pay(rate);
        this.holding = true;
        return next(frame);
      case Op.BranchNotNothing:
        this.pay(rate);
        return this.peek().kind !== 'nothing'
          ? jump(frame, a as number)
          : next(frame);
      case Op.BranchFalse:
      case Op.BranchTrue:
      case Op.CheckBoolean: {
        const v = this.peek();
        if (v.kind !== 'boolean') {
          throw wrongKind('boolean', v);
        }
        this.pay(rate);
        if (ins.opcode === Op.CheckBoolean) {
          return next(frame);
        }
        this.pop();
        return v.asBool() === (ins.opcode === Op.BranchTrue)
          ? jump(frame, a as number)
          : next(frame);
      }
      case Op.Not: {
        const v = this.peek();
        if (v.kind !== 'boolean') {
          throw wrongKind('boolean', v);
        }
        m.result = bool(!v.asBool());
        return this.replace(1, rate);
      }

      // Operators
      case Op.Add:
      case Op.Subtract:
      case Op.Multiply:
      case Op.Divide:
      case Op.Div:
      case Op.Mod:
      case Op.Power:
        m.result = arithmetic(ins.op, this.peek(1), this.peek());
        return this.replace(2, rate);
      case Op.Negate:
        m.result = negated(this.peek());
        return this.replace(1, rate);
      case Op.Concat:
        m.result = concat(this.peek(1), this.peek());
        return this.replace(2, rate);
      case Op.Range:
        m.result = makeRange(this.peek(1), this.peek());
        return this.replace(2, rate);
      case Op.Equal:
      case Op.NotEqual:
      case Op.Less:
      case Op.Greater:
      case Op.LessOrEqual:
      case Op.GreaterOrEqual: {
        const out = comparison(ins.op, this.peek(1), this.peek(), a === 'fold');
        m.scanned = out.scanned;
        m.result = out.result;
        return this.replace(2, rate);
      }
      case Op.Member: {
        const out = member(this.peek(1), this.peek(), a === 'fold');
        m.scanned = out.scanned;
        m.result = out.result;
        return this.replace(2, rate);
      }
      case Op.IsKind:
        m.result = isKind(this.peek(), a as string);
        return this.replace(1, rate);
      case Op.IsEmpty:
        m.result = isEmpty(this.peek());
        return this.replace(1, rate);
      case Op.CanConvert:
      case Op.Convert:
        m.input = this.peek();
        m.result =
          ins.opcode === Op.Convert
            ? convert(m.input, a as string, code.conversions.get(ins))
            : canConvert(m.input, a as string, code.conversions.get(ins));
        return this.replace(1, rate);
      case Op.Contains:
      case Op.BeginsWith:
      case Op.EndsWith:
      case Op.Matches: {
        m.input = this.peek(1);
        const out = search(ins.op, m.input, this.peek(), a === 'fold');
        m.steps = out.steps;
        m.result = out.result;
        return this.replace(2, rate);
      }

      // Keys, properties and chunks
      case Op.GetOptionalKey:
      case Op.GetOptionalKeyComputed: {
        const computed = ins.opcode === Op.GetOptionalKeyComputed;
        const key = computed ? keyText(this.peek(1)) : (a as string);
        const receiver = this.peek();
        m.result =
          receiver.kind === 'nothing' ? receiver : getKey(receiver, key);
        return this.replace(computed ? 2 : 1, rate);
      }
      case Op.GetKey:
        if (this.peek().kind === 'object') {
          m.result = this.getProperty(this.peek(), a as string, rate);
          frame.stack.pop();
          frame.stack.push(m.result);
          return next(frame);
        }
        m.result = getKey(this.peek(), a as string);
        return this.replace(1, rate);
      case Op.SetProperty:
      case Op.SetPropertyComputed: {
        const computed = ins.opcode === Op.SetPropertyComputed;
        // Deepest first: the key, if computed, the object, then the value.
        const o = this.peek(1);
        const v = this.peek();
        const name = computed ? keyText(this.peek(2)) : (a as string);
        this.holding = false;
        this.setProperty(o, name, v, rate);
        this.popN(computed ? 3 : 2);
        return next(frame);
      }
      case Op.GetKeyComputed:
        if (this.peek().kind === 'object') {
          m.result = this.getProperty(this.peek(), keyText(this.peek(1)), rate);
          drop(frame.stack, 2);
          frame.stack.push(m.result);
          return next(frame);
        }
        m.result = getKey(this.peek(), keyText(this.peek(1)));
        return this.replace(2, rate);
      case Op.GetElement:
        m.result = this.getElement(this.peek(1), this.peek(), rate);
        drop(frame.stack, 2);
        frame.stack.push(m.result);
        return next(frame);
      case Op.CountElements:
        m.result = this.countElements(this.peek(), rate);
        frame.stack.pop();
        frame.stack.push(m.result);
        return next(frame);
      case Op.ListElements:
        m.result = this.listElements(this.peek(), rate);
        frame.stack.pop();
        frame.stack.push(m.result);
        return next(frame);
      case Op.Property:
        m.input = this.peek();
        m.result = property(a as string, m.input);
        return this.replace(1, rate);
      case Op.PropertyDelimited:
        m.input = this.peek(1);
        m.result = property(a as string, m.input, this.peek());
        return this.replace(2, rate);
      case Op.ChunkGet:
      case Op.ChunkGetDelimited: {
        const delimited = ins.opcode === Op.ChunkGetDelimited;
        const d = delimited ? this.peek() : null;
        const whole = this.peek(delimited ? 1 : 0);
        const index = this.peek(delimited ? 2 : 1);
        m.input = whole;
        const out = chunkGet(a as string, index, whole, d);
        m.scanned = out.scanned;
        m.result = out.result;
        return this.replace(delimited ? 3 : 2, rate);
      }
      case Op.ChunkSet:
      case Op.ChunkSetDelimited: {
        const delimited = ins.opcode === Op.ChunkSetDelimited;
        const d = delimited ? this.peek() : null;
        const part = this.peek(delimited ? 1 : 0);
        const whole = this.peek(delimited ? 2 : 1);
        const index = this.peek(delimited ? 3 : 2);
        m.input = part;
        m.result = chunkSet(a as string, index, whole, part, d);
        return this.replace(delimited ? 4 : 3, rate);
      }
      case Op.ChunkDelete:
      case Op.ChunkDeleteDelimited: {
        const delimited = ins.opcode === Op.ChunkDeleteDelimited;
        const d = delimited ? this.peek() : null;
        const whole = this.peek(delimited ? 1 : 0);
        const index = this.peek(delimited ? 2 : 1);
        m.result = chunkDelete(a as string, index, whole, d);
        return this.replace(delimited ? 3 : 2, rate);
      }
      case Op.TestChunk:
      case Op.TestChunkDelimited: {
        const delimited = ins.opcode === Op.TestChunkDelimited;
        const d = delimited ? this.peek() : null;
        const whole = this.peek(delimited ? 1 : 0);
        const index = this.peek(delimited ? 2 : 1);
        m.input = whole;
        const there = chunkThere(a as string, index, whole, d);
        m.scanned = chunkGet(a as string, index, whole, d).scanned;
        this.pay(rate);
        this.popN(delimited ? 3 : 2);
        return there ? next(frame) : jump(frame, b as number);
      }
      case Op.TestKey:
      case Op.TestKeyComputed: {
        const computed = ins.opcode === Op.TestKeyComputed;
        const there = hasKey(
          this.peek(),
          computed ? keyText(this.peek(1)) : (a as string),
        );
        this.pay(rate);
        this.popN(computed ? 2 : 1);
        return there ? next(frame) : jump(frame, (computed ? a : b) as number);
      }
      case Op.SetKey:
        m.input = this.peek();
        m.result = setKey(this.peek(1), a as string, m.input);
        return this.replace(2, rate);
      case Op.SetKeyComputed:
        m.input = this.peek();
        m.result = setKey(this.peek(1), keyText(this.peek(2)), m.input);
        return this.replace(3, rate);
      case Op.DeleteKey:
        m.result = deleteKey(this.peek(), a as string);
        return this.replace(1, rate);
      case Op.DeleteKeyComputed:
        m.result = deleteKey(this.peek(), keyText(this.peek(1)));
        return this.replace(2, rate);
      case Op.Append:
      case Op.Prepend:
      case Op.AppendAll:
      case Op.PrependAll:
        m.input = this.peek();
        m.result = appendTo(
          this.peek(1),
          m.input,
          ins.op as Parameters<typeof appendTo>[2],
        );
        return this.replace(2, rate);

      // Building values
      case Op.List: {
        const n = a as number;
        m.count = n;
        const items = this.frame.stack.slice(
          this.frame.stack.length - n,
        ) as Value[];
        m.result = listValues(items);
        cacheBuild(m.result, items, 0);
        return this.replace(n, rate);
      }
      case Op.ListAppend:
        m.result = appendTo(this.peek(1), this.peek(), 'append');
        return this.replace(2, rate);
      case Op.ListExtend: {
        const e = this.peek();
        if (e.kind !== 'list') {
          throw wrongKind('list', e);
        }
        m.result = appendTo(this.peek(1), e, 'append-all');
        return this.replace(2, rate);
      }
      case Op.Map: {
        const keys = code.constant(a as number);
        const n = b as number;
        m.count = n;
        const values = this.frame.stack.slice(
          this.frame.stack.length - n,
        ) as Value[];
        const literal = mapLiteralOf(keys);
        m.result = mapOfLayout(literal.layout, values);
        cacheBuild(m.result, values, literal.keys);
        return this.replace(n, rate);
      }
      // Building Bytes
      case Op.BytesField:
        m.input = this.peek();
        m.result = buildField(this.peek(1), m.input, a as string);
        return this.replace(2, rate);
      case Op.BytesSized:
        m.input = this.peek(1);
        m.result = buildSized(this.peek(2), m.input, this.peek(), a as string);
        return this.replace(3, rate);
      case Op.BytesBits: {
        const n = b as number;
        const values = this.frame.stack.slice(-n) as Value[];
        m.result = buildBits(
          this.peek(n),
          values,
          widthsOf(code.constant(a as number)),
        );
        return this.replace(n + 1, rate);
      }

      // Binary Patterns: a jump pops the reader, and the subject or size.
      case Op.BinStart: {
        const v = this.peek();
        this.pay(rate);
        this.pop();
        if (v.kind !== 'bytes') {
          return jump(frame, a as number);
        }
        frame.stack.push({ k: 'reader', bytes: v.bytesView()!, at: 0 });
        return next(frame);
      }
      case Op.BinLiteral: {
        const r = this.reader();
        this.pay(rate);
        if (!readLiteral(r, code.constant(a as number))) {
          frame.stack.pop();
          return jump(frame, b as number);
        }
        return next(frame);
      }
      case Op.BinInt: {
        const r = this.reader();
        m.result = readInt({ ...r }, a as string);
        this.pay(rate);
        if (!m.result) {
          frame.stack.pop();
          return jump(frame, b as number);
        }
        readInt(r, a as string);
        frame.stack.push(m.result);
        return next(frame);
      }
      case Op.BinBits: {
        const r = this.reader();
        const widths = widthsOf(code.constant(a as number));
        const values = readBits({ ...r }, widths);
        m.resultSize = values?.reduce((t, v) => t + sizeOf(v), 0) ?? 0;
        this.pay(rate);
        if (!values) {
          frame.stack.pop();
          return jump(frame, c as number);
        }
        readBits(r, widths);
        frame.stack.push(...values);
        return next(frame);
      }
      case Op.BinBytes: {
        const size = this.peek();
        const r = this.frame.stack.at(-2) as Reader;
        const probe = { ...r };
        m.result = readBytes(probe, size, a as string);
        this.pay(rate);
        frame.stack.pop();
        if (!m.result) {
          frame.stack.pop();
          return jump(frame, b as number);
        }
        r.at = probe.at;
        frame.stack.push(m.result);
        return next(frame);
      }
      case Op.BinRest: {
        const r = this.reader();
        m.result = readRest(r, a as string);
        this.pay(rate);
        frame.stack.pop();
        if (!m.result) {
          return jump(frame, b as number);
        }
        frame.stack.push(m.result);
        return next(frame);
      }
      case Op.BinEnd: {
        const r = this.reader();
        this.pay(rate);
        frame.stack.pop();
        return r.at === r.bytes.length ? next(frame) : jump(frame, a as number);
      }

      case Op.MakePattern: {
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
        return this.replace(n, rate);
      }
      case Op.MatchAll: {
        const out = matchesOf(this.peek(1), this.peek());
        m.steps = out.steps;
        m.result = listValues(out.matches);
        return this.replace(2, rate);
      }
      case Op.ReplaceStart: {
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
        this.pay(rate);
        this.popN(2);
        frame.stack.push(replacement);
        return next(frame);
      }
      case Op.ReplaceNext: {
        const r = frame.stack.at(-1) as Replacement;
        this.pay(rate);
        if (r.at >= r.matches.length) {
          return jump(frame, a as number);
        }
        frame.stack.push(r.matches[r.at]!);
        return next(frame);
      }
      case Op.ReplacePut: {
        const piece = this.peek();
        const r = frame.stack.at(-2) as Replacement;
        this.pay(rate);
        this.pop();
        r.pieces.push(textForm(piece));
        r.at++;
        return next(frame);
      }
      case Op.ReplaceEnd: {
        const r = frame.stack.at(-1) as Replacement;
        const out: string[] = [];
        let from = 0;
        r.found.forEach((f, i) => {
          out.push(r.cs.slice(from, f.start).join(''), r.pieces[i] ?? '');
          from = f.end;
        });
        out.push(r.cs.slice(from).join(''));
        m.result = text(out.join(''));
        this.pay(rate);
        frame.stack.pop();
        frame.stack.push(m.result);
        return next(frame);
      }
      case Op.MakeClosure: {
        const body = unit.bodies[a as number]!;
        const n = b as number;
        m.count = n;
        m.result = this.functionValue(
          code,
          body,
          this.frame.stack.slice(this.frame.stack.length - n) as Value[],
          ins,
        );
        return this.replace(n, rate);
      }
      case Op.MakeFunction:
        m.result = this.functionValue(code, unit.bodies[a as number]!, [], ins);
        return this.replace(0, rate);
      case Op.MakeImportedFunction: {
        const target = code.library(a as string);
        m.result = this.functionValue(
          target.code,
          target.code.function(target.name),
          [],
          ins,
        );
        return this.replace(0, rate);
      }

      // Effects
      case Op.LoadObject: {
        const name = unit.objects[a as number]!;
        const object = this.host?.object(name);
        if (object) {
          this.pay(rate);
          frame.stack.push(object);
          return next(frame);
        }
        // A Script is named, and its send checks the Group holds it
        // (chapter 5, Naming a Script).
        this.pay(rate);
        frame.stack.push({ k: 'receiver', name });
        return next(frame);
      }
      case Op.Me: {
        // The object the Script owns, or Nothing (chapter 5, `me`). A Script
        // that owns none is its own receiver in `send … to me`.
        this.pay(rate);
        const me = this.host?.me ?? nothing;
        const then = unit.code[frame.pc + 1]?.opcode ?? -1;
        frame.stack.push(
          me.kind === 'nothing' &&
            (then === Op.Send ||
              then === Op.SendWait ||
              then === Op.JoinSend ||
              namedSends.has(then))
            ? { k: 'receiver', name: this.script.name }
            : me,
        );
        return next(frame);
      }
      case Op.Ask:
      case Op.Tell: {
        const n = c as number;
        const args = this.popArgs(n);
        const result = this.capability(a as string, b as string, args, rate);
        drop(frame.stack, n);
        if (ins.opcode === Op.Ask) {
          frame.stack.push(result);
        }
        return next(frame);
      }
      case Op.Wait: {
        const us = waitUs(this.peek());
        this.checkDeadline();
        this.checkScopeBoundary();
        this.pay(rate);
        this.pop();
        this.suspend({ k: 'wait', us });
        return;
      }
      case Op.AskWait: {
        const n = c as number;
        const args = this.popArgs(n);
        this.capability(a as string, b as string, args, rate);
        return;
      }
      case Op.WaitFor:
      case Op.WaitForAny: {
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
          any: ins.opcode === Op.WaitForAny,
          whens: [],
          afters: [],
          timeout: null,
        };
        entry.branches.forEach((br, n) => {
          if (br.kind === 'after') {
            sus.afters.push({ branch: n + 1, us: waitUs(items[i++] as Value) });
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
          sus.timeout = waitUs(items[i++] as Value);
        }
        this.checkDeadline();
        this.checkScopeBoundary();
        this.pay(rate);
        drop(frame.stack, count);
        this.suspend(sus);
        return;
      }
      case Op.JoinStart:
        this.checkScopeBoundary();
        this.pay(rate);
        this.join = { frame, members: [], replies: [], start: frame.pc };
        return next(frame);
      case Op.JoinAsk: {
        this.joinWidth();
        const n = c as number;
        this.capability(a as string, b as string, this.popArgs(n), rate, true);
        drop(frame.stack, n);
        return next(frame);
      }
      case Op.JoinEnd: {
        const members = this.join!.members;
        if (!members.length) {
          // No members: `[]` at once, with no Segment boundary.
          m.result = listValues([]);
          this.pay(rate);
          this.join = null;
          frame.stack.push(m.result);
          return next(frame);
        }
        // Raising here, with the Join open, abandons its members.
        this.checkDeadline();
        this.pay(rate);
        this.suspend({ k: 'join', members });
        return;
      }
      case Op.Send:
      case Op.SendWait:
      case Op.JoinSend:
      case Op.SendNamed:
      case Op.SendNamedWait:
      case Op.JoinSendNamed:
      case Op.SendSpread:
      case Op.SendSpreadWait:
      case Op.JoinSendSpread:
      case Op.SendUp:
      case Op.SendUpWait: {
        const join =
          ins.opcode === Op.JoinSend ||
          ins.opcode === Op.JoinSendNamed ||
          ins.opcode === Op.JoinSendSpread;
        if (join) {
          this.joinWidth();
        }
        const up = ins.opcode === Op.SendUp || ins.opcode === Op.SendUpWait;
        const named = namedSends.has(ins.opcode);
        // A spread's arguments are one list, below the receiver (ADR 0064).
        const spread = spreadSends.has(ins.opcode)
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
          if (!this.host?.isScript(to.name)) {
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
          ins.opcode !== Op.Send &&
          ins.opcode !== Op.SendNamed &&
          ins.opcode !== Op.SendSpread &&
          ins.opcode !== Op.SendUp;
        if (waits) {
          if (!join) {
            this.checkDeadline();
          }
          this.checkScopeBoundary();
        }
        this.pay(rate);
        const id = waits ? `${this.id}.c${this.calls + 1}` : null;
        const reached = up
          ? this.host!.sendUp(message, args, id)
          : this.host!.send(target!, message, args, id);
        drop(frame.stack, spread ? 3 : n + (up ? 0 : 1) + (named ? 1 : 0));
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
          return next(frame);
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
          return next(frame);
        }
        this.calls++;
        if (join) {
          this.join!.members.push({
            site: { frame, pc: frame.pc },
            id,
            call: null,
            abort: null,
            ms: this.limits.maxWaitMs,
            at: this.host!.now + BigInt(this.limits.maxWaitMs) * 1000n,
          });
          return next(frame);
        }
        this.suspend({ k: 'send', id, to: reached, message, args });
        return;
      }
      case Op.Veto: {
        const reason = this.peek();
        this.checkState();
        this.pay(rate);
        this.frames = [];
        this.outcome = { kind: 'completed', result: nothing, veto: reason };
        return;
      }
      case Op.Pass:
        // Ends the Run as `completed`; its Group sends the message on up.
        this.checkState();
        this.pay(rate);
        this.frames = [];
        this.outcome = { kind: 'completed', result: nothing, passed: true };
        return;
      case Op.Target:
        this.pay(rate);
        frame.stack.push(this.target);
        return next(frame);

      // Calls
      case Op.Call: {
        const body = unit.bodies[a as number]!;
        const args = this.frame.stack.slice(
          this.frame.stack.length - (b as number),
        ) as Value[];
        this.callBody(code, body, this.fillDefaults(code, body, args));
        drop(frame.stack, b as number);
        return;
      }
      case Op.CallImport: {
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
        drop(frame.stack, b as number);
        return;
      }
      case Op.CallHandler:
      case Op.CallHandlerWait: {
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
        if (this.callWouldExceedDepth()) {
          throw new LimitFaultError('callDepth', frame.pc);
        }
        this.pay(CALL);
        drop(frame.stack, n);
        this.dispatch({ clauses, code: target.code, next: 0, args });
        return;
      }
      case Op.CallBuiltin: {
        const n = b as number;
        const given = this.frame.stack.slice(
          this.frame.stack.length - n,
        ) as Value[];
        // Missing trailing arguments take the Built-in's defaults.
        const defaults = builtinDefaults[a as string] ?? [];
        const required =
          (builtinContracts.get(a as string)?.total ?? n) - defaults.length;
        // A variadic call past `total` slices past the defaults: none apply.
        const args = [...given, ...defaults.slice(given.length - required)];
        m.x = args;
        if (a === 'offerAvailable') {
          const name = args[0]!;
          if (name.kind !== 'text') {
            throw wrongKind('text', name);
          }
          this.pay(rate);
          const found =
            /^[A-Z_a-z]\w*$/.test(name.asText()!) &&
            name.asText() !== '_' &&
            !grammar.reserved.includes(
              name.asText()! as (typeof grammar.reserved)[number],
            )
              ? this.lookupOffer(name.asText()!)
              : { frames: 0 };
          this.pay(OFFER_LOOKUP, { frames: found.frames });
          drop(frame.stack, n);
          frame.stack.push(bool(!!('offer' in found && found.offer)));
          frame.pc++;
          return;
        }
        if (a === 'random') {
          // The draw is kept only once its Fuel is paid.
          const draw = this.host!.drawRandom(randomBound(args[0]!));
          m.result = integerValue(draw.value);
          this.replace(n, rate);
          draw.commit();
          return;
        }
        const out = builtin(a as string, args, m);
        m.result = out.result;
        m.scanned = out.scanned;
        m.steps = out.steps;
        return this.replace(n, rate);
      }
      case Op.CallValue:
      case Op.CallRestricted:
      case Op.CallValueWait: {
        const n = ins.opcode === Op.CallRestricted ? 1 : (a as number);
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
        if (ins.opcode !== Op.CallValueWait && (foreign || ref.maySuspend)) {
          throw new ScriptError('would suspend');
        }
        const { code: home, body } = ref.code as FunctionCode;
        const arity = arityOf(body);
        if (n < arity.min || n > arity.max) {
          throw new ScriptError('wrong arity');
        }
        if (foreign) {
          this.checkScopeBoundary();
          this.pay(rate);
          const id = `${this.id}.c${this.calls + 1}`;
          const to = this.host!.callValue(fn, args, id);
          this.calls++;
          drop(frame.stack, n + 1);
          this.records.push({ kind: 'send', id, to, fn, args });
          this.suspend({ k: 'call-value', id, to, fn, args });
          return;
        }
        const filled =
          body.kind === 'lambda' ? args : this.fillDefaults(home, body, args);
        this.callBody(home, body, filled);
        drop(frame.stack, n + 1);
        const callee = this.frame;
        callee.restricted ||= ins.opcode === Op.CallRestricted;
        ref.captures.forEach(([, v], i) => {
          callee.locals[body.captureStart + i] = v;
        });
        return;
      }
      case Op.Return: {
        const value = this.peek();
        if (this.frames.length === 1) {
          this.checkState();
        }
        this.pay(rate);
        return this.returnFrom(value);
      }
      case Op.ClauseFail: {
        if (this.frames.length === 1 && !Run.more(frame.dispatch)) {
          this.checkState();
        }
        this.pay(rate);
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
      case Op.TestConstant: {
        const fold = b === 'fold';
        const target = (fold ? c : b) as number;
        const ok = equals(this.peek(), code.constant(a as number), fold).equal;
        this.pay(rate);
        this.pop();
        return ok ? next(frame) : jump(frame, target);
      }
      case Op.TestEqual: {
        const ok = equals(this.peek(1), this.peek(), false).equal;
        this.pay(rate);
        this.popN(2);
        return ok ? next(frame) : jump(frame, a as number);
      }
      case Op.TestList:
      case Op.TestListAtLeast: {
        const v = this.peek();
        const n = a as number;
        const ok =
          v.kind === 'list' &&
          (ins.opcode === Op.TestList ? v.length === n : v.length >= n);
        this.pay(rate);
        this.pop();
        return ok ? next(frame) : jump(frame, b as number);
      }
      case Op.ListItem:
        m.result = this.peek().index(a as number);
        return this.replace(1, rate);
      case Op.ListRest: {
        const v = this.peek();
        const from = a as number;
        m.result = listValues(
          Array.from({ length: Math.max(0, v.length - from + 1) }, (_, i) =>
            v.index(from + i),
          ),
        );
        return this.replace(1, rate);
      }
      case Op.TestMap: {
        const ok = this.peek().kind === 'map';
        this.pay(rate);
        this.pop();
        return ok ? next(frame) : jump(frame, a as number);
      }
      case Op.MapGet: {
        const v = this.peek();
        const there = hasKey(v, a as string);
        this.pay(rate);
        this.pop();
        if (!there) {
          return jump(frame, b as number);
        }
        frame.stack.push(v.get(a as string));
        return next(frame);
      }
      case Op.MatchWhole:
      case Op.MatchSearch: {
        const fold = a === 'fold';
        const target = (fold ? b : a) as number;
        const out = matchCaptures(
          ins.opcode === Op.MatchWhole,
          this.peek(1),
          this.peek(),
          fold,
        );
        m.steps = out.steps;
        m.result = out.result ?? undefined;
        this.pay(rate);
        this.popN(2);
        if (!out.result) {
          return jump(frame, target);
        }
        frame.stack.push(out.result);
        return next(frame);
      }

      // Loops
      case Op.TimeoutStart: {
        // The Pump's Clock reading plus `d`, unless an enclosing block's
        // deadline is no later (ADR 0073).
        const us = waitUs(this.peek());
        const enclosing = this.blockDeadline();
        const at = this.host!.now + us;
        this.pay(rate);
        this.pop();
        frame.stack.push(
          enclosing && enclosing.at <= at
            ? { ...enclosing }
            : { k: 'deadline', at, after: msOf(us) },
        );
        return next(frame);
      }
      case Op.TimeoutEnd:
        this.pay(rate);
        frame.stack.pop();
        return next(frame);
      case Op.Iterate: {
        const iterator = iteratorOver(this.peek());
        this.pay(rate);
        this.pop();
        frame.stack.push(iterator);
        return next(frame);
      }
      case Op.IterateTimes: {
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
        this.pay(rate);
        this.pop();
        frame.stack.push({
          k: 'iterator',
          source: null,
          at: 0,
          count: Number(n),
        });
        return next(frame);
      }
      case Op.Next: {
        const it = frame.stack.at(-1) as Iterator;
        this.pay(rate);
        if (it.at >= it.count) {
          return jump(frame, a as number);
        }
        it.at++;
        frame.stack.push(iteratorItem(it.source, it.at));
        return next(frame);
      }

      // Errors
      case Op.Throw: {
        const v = this.peek();
        let error: Value;
        if (v.kind === 'text') {
          error = map([['code', v]]);
        } else if (v.kind === 'map' && v.get('code').kind === 'text') {
          error = v;
        } else {
          throw new ScriptError('bad throw');
        }
        this.pay(rate);
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
      case Op.CatchAccept:
        this.pay(rate);
        return this.acceptCatch();
      case Op.CatchNext:
        this.pay(rate);
        return this.nextCatch();
      case Op.ChooseOffer:
        return this.chooseOffer(a as string, b as number, ins);
      case Op.Raise: {
        this.pay(rate);
        throw new ThrownError(this.errorMap(a as string, [], ins));
      }
      case Op.EndCleanup: {
        this.pay(rate);
        if (this.cancelling) {
          this.checkState();
          return this.nextCleanup();
        }
        // A `finally` block an uncaught error ran raises it again as it goes
        // on.
        const u = this.controls.at(-1);
        if (u?.k === 'cleanup' && u.then.k === 'end') {
          this.record(u.error, ins, false);
        }
        return this.nextCleanup();
      }
    }
    throw new NotImplementedError(`the instruction ${ins.op}`);
  }

  // Charge, then replace the top `n` values with the measured result.
  private replace(n: number, rate: number) {
    this.pay(rate);
    const frame = this.frame;
    const stack = frame.stack;
    if (n) {
      drop(stack, n - 1);
      stack[stack.length - 1] = this.m.result!;
    } else {
      stack.push(this.m.result!);
    }
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
    if (unit.code[pc]!.opcode === Op.EndCleanup) {
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

// The element instructions pay their base rate before validation, so an
// error they raise must not be charged the rate again (#1143).
const paidOnce = (body: () => Value): Value => {
  try {
    return body();
  } catch (error) {
    if (error instanceof ScriptError && !error.uncharged) {
      throw new ScriptError(error.code, error.fields, true);
    }
    throw error;
  }
};
