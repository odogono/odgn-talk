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
import type { Body, CodeUnit, Instruction } from './code-unit';
import { instructionSpec } from './code-unit';
import { errorMessages, limitDefaults } from './generated/machine';
import { builtins } from './generated/syntax';
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
  wrongKind,
} from './operations';
import { readDisplay } from './readers';
import { LimitReached, mismatch, type Call, type Grant } from './capabilities';
import { ScriptError as HostScriptError } from './errors';
import {
  bool,
  dec,
  functionValue,
  listValues,
  map,
  nothing,
  text,
  Value,
  type FunctionRef,
} from './values';
import type { PatternElement } from './view';

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
  /** The Libraries it imports, by name. */
  readonly libraries = new Map<string, Code>();
  /** Whether it is a stdlib Library's, whose errors name the caller (ADR 0037). */
  stdlib = false;

  constructor(readonly unit: CodeUnit) {
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
  link(libraries: ReadonlyMap<string, Code>) {
    for (const [name, code] of libraries) {
      this.libraries.set(name, code);
    }
    this.unit.definitions.forEach((name, i) => {
      if (/^[^.]*:/.test(name)) {
        const { code, name: constant } = this.library(name);
        this.definitions[i] =
          code.definitions[code.unit.definitions.indexOf(constant)]!;
      }
    });
  }
}

/** A loaded Script: its code, and its Script Variables. */
export class Script extends Code {
  variables: Value[];

  constructor(
    unit: CodeUnit,
    readonly limits: Limits = defaultLimits,
  ) {
    super(unit);
    this.variables = unit.variables.map(() => nothing);
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
): Script => {
  const script = new Script(unit, { ...defaultLimits, ...limits });
  script.link(libraries);
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
): Code => loadScript(unit, {}, libraries);

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

type Iterator = {
  at: number;
  count: number;
  item: (i: number) => Value;
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
// A Function Value's code: the code unit its body is in, and the body.
type FunctionCode = { body: Body; code: Code };
type Dispatch = { args: Value[]; clauses: Body[]; code: Code; next: number };
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
  stack: Item[];
};
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
      charged: number;
      error?: Value;
      id: string;
      kind: 'call';
      op: string;
      result?: Value;
    }
  | { id: string; kind: 'call-failed'; op: string }
  | { args: Value[]; kind: 'send'; message: string; to: string };

/**
 * What a Run reaches outside its Script through, which its Group gives it:
 * the Script's Grants, the Pump's Clock reading, and other Scripts' mailboxes.
 */
export type RunHost = {
  readonly grants: ReadonlyMap<string, Grant<unknown>>;
  /** Whether a name is a well-known Host Object the Host bound at load. */
  isObject(name: string): boolean;
  /** Whether a name is a Script of the Group. */
  isScript(name: string): boolean;
  readonly now: bigint;
  /** Puts a message in a Script's mailbox, or throws ScriptError `mailbox full`. */
  send(to: string, message: string, args: Value[]): void;
};
// A path's step: a map key, or a 1-based list index.
const keyValue = (k: string | number): Value =>
  typeof k === 'number' ? dec(String(k)) : text(k);
// The keys a Host `Fail`'s Data may not use (chapter 6, the catalogue).
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
export type Outcome =
  | { kind: 'completed'; result: Value }
  | { error: Value; kind: 'errored' }
  | {
      col: number;
      kind: 'limit fault';
      limit: LimitName;
      line: number;
      pc: number;
      /** The Script Variables the rollback changed back, in declaration order. */
      rollback: string[];
      /** The code unit the faulting instruction is in. */
      unit: string;
    }
  | { kind: 'unhandled' };

class LimitFaultError extends Error {
  constructor(
    readonly limit: LimitName,
    readonly pc: number,
  ) {
    super(limit);
  }
}
const isValue = (item: Item | undefined): item is Value => Value.isValue(item);

export class Run {
  /** Its id in the Trace, such as `orders/r2`, which its call ids extend. */
  id = '';
  host: RunHost | null = null;
  private calls = 0;
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
  readonly segmentBase: Value[];
  private cleanups: Cleanup[] = [];
  private outcome: Outcome | null = null;
  private m: Measured = {};
  private clause = 0;

  constructor(
    readonly script: Script,
    entry: Body | Body[],
    args: Value[],
    readonly limits: Limits = script.limits,
  ) {
    this.segmentBase = [...script.variables];
    const clauses = Array.isArray(entry) ? entry : [entry];
    if (!Array.isArray(entry)) {
      this.push(script, entry, args, null);
    } else if (!this.dispatch({ clauses, code: script, next: 0, args })) {
      this.outcome = { kind: 'unhandled' };
    }
  }

  /** The clause number the Run's dispatch chose, or is trying. */
  get clauseNumber(): number {
    return this.clause;
  }

  /** Run to the end of the Run. */
  finish(): Outcome {
    while (!this.outcome) {
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
    this.frames.push({
      body,
      code,
      pc: body.start,
      locals,
      stack: [],
      dispatch,
      clauseCharge: dispatch !== null,
      handler: body.kind === 'lambda' ? body.name.split(':')[0]! : body.name,
    });
  }

  // Push the next clause whose parameter count matches, or report none.
  private dispatch(d: Dispatch): boolean {
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
    return false;
  }

  private get frame(): Frame {
    return this.frames.at(-1)!;
  }

  // ------------------------------------------------------------- charging

  /** Charge an instruction, faulting before it does anything if it can't pay. */
  private pay(key: string, measured: Measured = this.m) {
    if (!this.charging) {
      return;
    }
    const frame = this.frame;
    const own = charge(key, measured);
    this.payAmount(
      own.fuel + (frame.clauseCharge ? charge('clause').fuel : 0),
      own.alloc,
    );
  }

  // Charge an amount, faulting at the current instruction if it can't pay.
  private payAmount(fuel: number, alloc: number) {
    if (!this.charging) {
      return;
    }
    const frame = this.frame;
    if (this.fuel + fuel > this.limits.fuelPerRun) {
      throw new LimitFaultError('fuelPerRun', frame.pc);
    }
    if (this.alloc + alloc > this.limits.allocPerRun) {
      throw new LimitFaultError('allocPerRun', frame.pc);
    }
    frame.clauseCharge = false;
    this.fuel += fuel;
    this.alloc += alloc;
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

  step() {
    const frame = this.frame;
    const ins = frame.code.unit.code[frame.pc]!;
    // A Built-in call is charged by that Built-in's rate, when it raises too.
    const key =
      ins.op === 'call-builtin'
        ? `builtin.${ins.operands[0]}`
        : instructionSpec.get(ins.op)!.cost;
    this.m = {};
    try {
      this.execute(ins, key);
    } catch (error) {
      if (error instanceof ScriptError) {
        this.raiseCore(error, ins, key);
      } else if (error instanceof ThrownError) {
        this.unwind(error.error, ins);
      } else if (error instanceof LimitFaultError) {
        this.fault(error.limit, ins);
      } else {
        throw error;
      }
    }
  }

  private fault(limit: LimitName, ins: Instruction) {
    const code = this.frame.code;
    const rollback = this.script.unit.variables.filter(
      (_, i) => !this.script.variables[i]!.equals(this.segmentBase[i]!),
    );
    this.script.variables = [...this.segmentBase];
    this.frames = [];
    this.outcome = {
      kind: 'limit fault',
      limit,
      rollback,
      unit: code.name,
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
  // in the nearest frame that isn't stdlib code (ADR 0037).
  private at(ins: Instruction): Value {
    let i = this.frames.length - 1;
    while (i > 0 && this.frames[i]!.code.stdlib) {
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

  private record(error: Value, ins: Instruction, skip: boolean) {
    // A Guard that gives something other than a boolean is a skip with its value.
    const notBoolean =
      skip &&
      (ins.op === 'branch-false' || ins.op === 'branch-true') &&
      textForm(error.get('code')) === 'wrong kind';
    this.records.push({
      kind: skip ? 'guard-skip' : 'raise',
      ...(notBoolean
        ? { value: error.get('value') }
        : { code: textForm(error.get('code')) }),
      unit: this.frame.code.name,
      pc: this.frame.code.unit.code.indexOf(ins),
      line: ins.line,
      col: ins.col,
    });
  }

  /**
   * Unwind an error from the current instruction (chapter 8, The Unwind
   * Table): find the first entry that holds a frame's place, charge `unwind`
   * for the frames popped, then continue there.
   */
  private unwind(error: Value, ins: Instruction) {
    let popped = 0;
    let found: CodeUnit['unwind'][number] | undefined;
    // Each frame unwinds through its own code unit's Unwind Table.
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const { code, pc } = this.frames[i]!;
      found = code.unit.unwind.find(e => pc >= e.start && pc < e.end);
      if (found) {
        break;
      }
      popped++;
    }
    this.record(error, ins, found?.kind === 'guard');
    if (popped) {
      try {
        this.pay('unwind', { frames: popped });
      } catch (error_) {
        if (error_ instanceof LimitFaultError) {
          return this.fault(error_.limit, ins);
        }
        throw error_;
      }
    }
    // An error raised in a `finally` copy replaces the one in flight, which
    // becomes its `during` (chapter 6).
    const handler = found ? this.frames.length - 1 - popped : -1;
    const inside = (c: Cleanup) =>
      found !== undefined &&
      this.frames.indexOf(c.frame) === handler &&
      found.start >= c.start &&
      found.end <= cleanupEnd(c.frame.code.unit, c);
    while (this.cleanups.length) {
      const c = this.cleanups.at(-1)!;
      if (this.frames.indexOf(c.frame) < handler || inside(c)) {
        break;
      }
      this.cleanups.pop();
      if (!hasKey(error, 'during')) {
        const core = coreRaised.has(error);
        error = map([...error.entries(), ['during', c.error]]);
        if (core) {
          coreRaised.add(error);
        }
      }
    }
    if (!found) {
      try {
        this.checkState();
      } catch (error_) {
        if (error_ instanceof LimitFaultError) {
          return this.fault(error_.limit, ins);
        }
        throw error_;
      }
      this.frames = [];
      this.outcome = { kind: 'errored', error };
      return;
    }
    this.frames.length = handler + 1;
    const frame = this.frame;
    frame.stack.length = found.depth;
    frame.pc = found.target;
    if (found.kind === 'catch') {
      frame.stack.push(error);
    } else if (found.kind === 'finally') {
      this.cleanups.push({ frame, error, start: found.target });
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
    if (this.frames.length + 1 > this.limits.callDepth) {
      throw new LimitFaultError('callDepth', this.frame.pc);
    }
    this.pay('call');
    this.push(code, body, args, null);
  }

  // A function's defaults are its own code unit's definitions.
  private fillDefaults(code: Code, body: Body, args: Value[]): Value[] {
    const filled = [...args];
    for (let i = args.length; i < body.params.length; i++) {
      filled.push(code.definitions[body.defaults[i]!]!);
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
    const own = code === this.script;
    const where = own ? '' : `${code.name}:`;
    const ref: FunctionRef = {
      home: this.script.name,
      place: where + (lambda ? `${ins.line}:${ins.col}` : body.name),
      identity: `${this.script.name}#${where}${body.index}`,
      maySuspend: body.maySuspend,
      captures: captures.map((v, i) => [
        body.locals[body.captureStart + i]!,
        v,
      ]),
      code: { code, body } satisfies FunctionCode,
    };
    return functionValue(ref);
  }

  private popArgs(n: number): Value[] {
    return this.frame.stack.slice(this.frame.stack.length - n) as Value[];
  }

  /**
   * An immediate or fire-and-forget Capability call (chapter 9): the
   * arguments checked against their Shapes, uncharged; the declared cost;
   * the Host function, which may `Charge` more; then its result checked and
   * its conversion charged. A `Fail` raises its code, and anything else the
   * Host does wrong is `host error`.
   */
  private capability(
    grantName: string,
    opName: string,
    args: Value[],
    key: string,
  ): Value {
    const host = this.host;
    if (!host) {
      throw new NotImplementedError('a Capability call outside a Group');
    }
    const grant = host.grants.get(grantName);
    const op = grant?.ops.has(opName)
      ? grant.capability.operations.get(opName)
      : undefined;
    if (!grant || !op || (op.args ?? []).length !== args.length) {
      // Only Library code gets here: its `needs` aren't checked at load yet.
      throw new NotImplementedError("checking a Library's needs");
    }
    if (op.mode === 'suspending') {
      throw new NotImplementedError('a suspending Operation');
    }
    const named: [string, Value][] = [
      ['capability', text(grantName)],
      ['operation', text(opName)],
    ];
    (op.args ?? []).forEach((shape, i) => {
      const bad = mismatch(args[i]!, shape);
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
    const declared = { fuel: op.cost.fuel, alloc: op.cost.alloc ?? 0 };
    this.pay(key, { declared: declared.fuel });
    this.payAmount(0, declared.alloc);
    const id = `${this.id}.c${++this.calls}`;
    let charged = 0;
    let reached = false;
    const call: Call<unknown> = {
      id,
      scriptName: this.script.name,
      binding: grant.binding,
      now: host.now,
      signal: new AbortController().signal,
      charge: (fuel: number) => {
        if (this.charging && this.fuel + fuel > this.limits.fuelPerRun) {
          reached = true;
          throw new LimitReached('the Run can’t cover this charge');
        }
        this.fuel += fuel;
        charged += fuel;
      },
    };
    const record = {
      kind: 'call' as const,
      id,
      op: `${grantName}.${opName}`,
      args,
      charged,
    };
    const hostError = (error: Value) => {
      this.records.push(
        { ...record, charged, error },
        { kind: 'call-failed', id, op: record.op },
      );
      return new ScriptError('host error', named, true);
    };
    let result: unknown;
    try {
      result =
        op.mode === 'immediate'
          ? op.do(call, ...args)
          : (op.fire(call, ...args), nothing);
    } catch (error) {
      if (reached) {
        // Cut off by its own `Charge`: neither a result nor a failure.
        this.records.push({ ...record, charged });
        throw new LimitFaultError('fuelPerRun', this.frame.pc);
      }
      if (!(error instanceof HostScriptError)) {
        throw hostError(map([]));
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
      const declaredCodes = op.errors?.map(e => e.code);
      if (
        error.code in errorMessages ||
        data.entries().some(([k]) => reservedKeys.has(k)) ||
        (declaredCodes && !declaredCodes.includes(error.code))
      ) {
        throw hostError(failed);
      }
      this.records.push({ ...record, charged, error: failed });
      // Its Data is converted, and charged, as a result is.
      const conversion = charge(key, { declared: declared.fuel, result: data });
      const before = charge(key, { declared: declared.fuel });
      this.payAmount(
        conversion.fuel - before.fuel,
        conversion.alloc - before.alloc,
      );
      throw new ThrownError(
        map([
          ...failed.entries(),
          ...named,
          ['at', this.at(this.frame.code.unit.code[this.frame.pc]!)],
        ]),
      );
    }
    if (reached) {
      this.records.push({ ...record, charged });
      throw new LimitFaultError('fuelPerRun', this.frame.pc);
    }
    if (op.mode === 'fire-and-forget') {
      this.records.push({ ...record, charged });
      return nothing;
    }
    if (!Value.isValue(result) || (op.result && mismatch(result, op.result))) {
      throw hostError(map([]));
    }
    this.records.push({ ...record, charged, result });
    const conversion = charge(key, { declared: declared.fuel, result });
    const before = charge(key, { declared: declared.fuel });
    this.payAmount(
      conversion.fuel - before.fuel,
      conversion.alloc - before.alloc,
    );
    return result;
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
        frame.stack.push(code.definitions[a as number]!);
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
        m.result = getKey(this.peek(), a as string);
        return this.replace(1, key);
      case 'get-key-computed':
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
        if (!this.host?.isScript(name)) {
          if (!this.host || this.host.isObject(name)) {
            throw new NotImplementedError(`the Host Object ${name}`);
          }
          // A receiver that names no Script of the Group (chapter 5, Sending).
          throw new ScriptError('object gone', [['object', text(name)]]);
        }
        this.pay(key);
        frame.stack.push({ k: 'receiver', name });
        return next();
      }
      case 'me':
        // Without Host Objects, no Script owns one (chapter 5, `me`).
        this.pay(key);
        frame.stack.push(nothing);
        return next();
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
      case 'send': {
        const n = b as number;
        const to = frame.stack.at(-1);
        if (isValue(to) || to?.k !== 'receiver') {
          throw new NotImplementedError('a send to a Host Object');
        }
        const args = this.frame.stack.slice(
          this.frame.stack.length - n - 1,
          -1,
        ) as Value[];
        const size = partSize(
          'message',
          0,
          args.reduce((sum, v) => sum + sizeOf(v), 0),
        );
        m.inputSize = size;
        this.pay(key);
        this.host!.send(to.name, a as string, args);
        this.records.push({
          kind: 'send',
          to: to.name,
          message: a as string,
          args,
        });
        frame.stack.length -= n + 1;
        return next();
      }

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
      case 'call-handler': {
        // An imported Handler's clauses are its Library's.
        const target = (a as string).includes(':')
          ? code.library(a as string)
          : { code, name: a as string };
        const clauses = target.code.clauses.get(target.name)!;
        const n = b as number;
        const args = this.frame.stack.slice(
          this.frame.stack.length - n,
        ) as Value[];
        if (!clauses.some(body => body.params.length === n)) {
          throw new ScriptError('no match');
        }
        if (this.frames.length + 1 > this.limits.callDepth) {
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
        if (
          ref.home !== this.script.name ||
          (ref.maySuspend && ins.op === 'call-value')
        ) {
          if (ins.op === 'call-value') {
            throw new ScriptError('would suspend');
          }
          throw new NotImplementedError(
            'a call that may suspend, or to another Script',
          );
        }
        const { code: home, body } = ref.code as FunctionCode;
        const required = body.defaults.filter(
          d => d === null || d === undefined,
        ).length;
        const ok =
          body.kind === 'lambda'
            ? n === body.params.length
            : n >= required && n <= body.params.length;
        if (!ok) {
          throw new ScriptError('wrong arity');
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
        if (
          this.frames.length === 1 &&
          !frame.dispatch?.clauses
            .slice(frame.dispatch.next)
            .some(b => b.params.length === frame.dispatch!.args.length)
        ) {
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
            item: i => v.index(i),
          };
        } else if (v.kind === 'range') {
          const { from, to } = v.asRange()!;
          const whole = (x: Value) => isKind(x, 'integer').asBool();
          if (!whole(from) || !whole(to)) {
            throw wrongKind('integer', whole(from) ? to : from);
          }
          const start = BigInt(from.asDecimal()!.toString().split('.')[0]!);
          const items = property('length', v);
          iterator = {
            k: 'iterator',
            source: v,
            at: 0,
            count: Number(items.asDecimal()!.toString()),
            item: i => dec(String(start + BigInt(i - 1))),
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
          item: () => nothing,
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
        frame.stack.push(it.item(it.at));
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
      case 'rethrow': {
        const error = this.peek();
        this.pay(key);
        this.pop();
        throw new ThrownError(error);
      }
      case 'raise': {
        this.pay(key);
        throw new ThrownError(this.errorMap(a as string, [], ins));
      }
      case 'end-cleanup': {
        this.pay(key);
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

// An error a `throw`, `rethrow`, `raise` or `end-cleanup` raises, already a map.
class ThrownError extends Error {
  constructor(readonly error: Value) {
    super('thrown');
  }
}

// A cleanup copy runs from its `finally` entry's target to its `end-cleanup`,
// past the cleanup copies of any `try` inside it.
const cleanupEnd = (unit: CodeUnit, c: Cleanup): number => {
  const starts = new Set(
    unit.unwind.filter(e => e.kind === 'finally').map(e => e.target),
  );
  let depth = 0;
  for (let pc = c.start; pc < unit.code.length; pc++) {
    if (pc !== c.start && starts.has(pc)) {
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

/** Start a Run by dispatching a message to a Handler's clauses. */
export const deliver = (
  script: Script,
  message: string,
  args: Value[],
  limits?: Partial<Limits>,
): Run =>
  new Run(script, script.clauses.get(message) ?? [], args, {
    ...script.limits,
    ...limits,
  });

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
