/* eslint require-yield: "off" -- A lowering that emits no nested construct still runs as a task. */
// Chapter 8's normative lowering: a checked Script or Library becomes one code
// unit, with its constant pool, definitions, variables, objects, body table,
// code, Unwind Table and event table in the order the chapter fixes. Nothing is
// optimised at this level (ADR 0010). Every pass runs on an explicit stack.
import {
  capturesOf,
  numberText,
  patternSource,
  quantityText,
  splicesOf,
  textDisplay,
} from './canonical';
import { checkSource, type CheckOptions, type Diagnostic } from './checker';
import type {
  Body,
  CodeUnit,
  EventBranch,
  EventEntry,
  Instruction,
  Operand,
  OfferEntry,
  UnwindEntry,
} from './code-unit';
import { instructionSpec } from './code-unit';
import { statementStarts } from './debug';
import type { ParseError } from './parser';
import type {
  Binding,
  LibraryExport,
  SemanticName,
  SemanticScope,
  SemanticTree,
} from './semantic';
import { runTask, type Task } from './tasks';
import {
  viewSource,
  type BinaryField,
  type BuildField,
  type Decl,
  type Event,
  type Expr,
  type FieldType,
  type Function,
  type Guard,
  type Handler,
  type Lambda,
  type Literal,
  type Pattern,
  type PatternElement,
  type Pos,
  type Replace,
  type Stmt,
  type TextPattern,
  type Try,
} from './view';

/** A construct whose lowering the Spec leaves unsettled; not a load diagnostic. */
export class LoweringError extends Error {
  constructor(
    readonly line: number,
    readonly col: number,
    message: string,
  ) {
    super(`${line}:${col}: ${message}`);
    this.name = 'LoweringError';
  }
}

// `catch "code"` and `on error "code"` match the error map's code.
const errorPattern = (p: Pattern): Pattern =>
  p.k === 'literal' && p.value.k === 'text'
    ? { k: 'map', pos: p.pos, entries: [{ key: 'code', value: p }] }
    : p;

type Label = { pc: number | null };
const pendingStatements = new WeakSet<Pending>();
type Pending = {
  col: number;
  line: number;
  op: string;
  operands: (Operand | Label)[];
};
type PendingOffer = Omit<OfferEntry, 'end' | 'offers'> & {
  end: Label;
  offers: { binds: number[]; name: string; target: Label }[];
};
type PendingUnwind = Omit<UnwindEntry, 'target'> & { target: Label | number };
type Loop = { exit: Label; finallies: number; top: Label };
// A span of code an Unwind Table entry protects, split around inlined copies.
type Span = { open: number | null; spans: [number, number][] };
type Binds = Map<Binding, number>;

const literalDisplay = (value: Literal): string => {
  switch (value.k) {
    case 'text':
      return textDisplay(value.value);
    case 'word':
      return value.value;
    case 'number': {
      const number = numberText(value.text, value.negative);
      return value.unit ? quantityText(number, value.unit) : number;
    }
  }
};
const fieldText = (type: FieldType | null): string => {
  if (!type) {
    return 'value';
  }
  if (type.k === 'int') {
    return type.order ? `${type.type} ${type.order}` : type.type;
  }
  return type.asText ? `${type.unit} as text` : type.unit;
};
const isBits = (type: FieldType | null) =>
  type?.k === 'sized' && type.unit === 'bits';
const importName = (binding: Binding) =>
  `${binding.importedFrom!.library}:${binding.importedFrom!.name}`;

/** The names a pattern binds, left to right. */
const patternNames = (p: Pattern): SemanticName[] => {
  const out: SemanticName[] = [];
  const work: Pattern[] = [p];
  while (work.length) {
    const q = work.pop()!;
    switch (q.k) {
      case 'bind':
        out.push(q.name);
        break;
      case 'as':
        work.push({ k: 'bind', pos: q.pos, name: q.name }, q.p);
        break;
      case 'list':
        if (q.rest?.name) {
          work.push({ k: 'bind', pos: q.pos, name: q.rest.name });
        }
        work.push(...[...q.items].reverse());
        break;
      case 'map':
        work.push(...q.entries.map(entry => entry.value).reverse());
        break;
      case 'text':
        out.push(...capturesOf(q.pattern));
        break;
      case 'binary':
        for (const field of q.fields) {
          if ((field.k === 'field' || field.k === 'rest') && field.name) {
            out.push(field.name);
          }
        }
        break;
    }
  }
  return out;
};

class UnitLowering {
  bodies: Body[] = [];
  code = new Map<number, Pending[]>();
  unwind = new Map<number, PendingUnwind[]>();
  offers = new Map<number, PendingOffer[]>();
  constants: string[] = [];
  definitions: string[] = [];
  events: EventEntry[] = [];
  objects: string[] = [];
  variables: string[] = [];
  patterns = new Map<number, readonly PatternElement[]>();
  private constantIndex = new Map<string, number>();
  private objectIndex = new Map<string, number>();
  definitionOf = new Map<Binding | string, number>();
  variableOf = new Map<Binding, number>();
  functionOf = new Map<Binding, number>();

  constructor(
    readonly name: string,
    readonly kind: 'script' | 'library',
    readonly scopes: readonly SemanticScope[],
    existingVariables: readonly string[] = [],
  ) {
    this.variables = [...existingVariables];
    for (const binding of scopes[0]!.bindings) {
      if (binding.kind === 'script variable' && binding.span === null) {
        this.variableOf.set(binding, this.variables.indexOf(binding.name));
      } else if (
        binding.kind === 'constant' &&
        binding.importedFrom &&
        binding.span === null
      ) {
        this.definition(binding, importName(binding));
      }
    }
  }

  constant(display: string): number {
    let i = this.constantIndex.get(display);
    if (i === undefined) {
      i = this.constants.length;
      this.constants.push(display);
      this.constantIndex.set(display, i);
    }
    return i;
  }

  object(name: string): number {
    let i = this.objectIndex.get(name);
    if (i === undefined) {
      i = this.objects.length;
      this.objects.push(name);
      this.objectIndex.set(name, i);
    }
    return i;
  }

  definition(key: Binding | string, display: string): number {
    let i = this.definitionOf.get(key);
    if (i === undefined) {
      i = this.definitions.length;
      this.definitions.push(display);
      this.definitionOf.set(key, i);
    }
    return i;
  }

  newBody(
    kind: Body['kind'],
    name: string,
    clause: number | null = null,
  ): Body {
    const body: Body = {
      index: this.bodies.length,
      kind,
      name,
      clause,
      params: [],
      defaults: [],
      captures: 0,
      captureStart: 0,
      locals: [],
      maySuspend: false,
      start: 0,
      end: 0,
    };
    this.bodies.push(body);
    return body;
  }

  *lower(decls: Decl[]): Task {
    // The tables of names, before any body is lowered.
    for (const decl of decls) {
      if (decl.k === 'use') {
        for (const { local } of decl.imports) {
          const binding = local.binding;
          if (binding?.kind === 'constant' && binding.importedFrom) {
            this.definition(binding, importName(binding));
          }
        }
      } else if (decl.k === 'constant') {
        this.definition(decl.name.binding!, decl.name.text);
      } else if (decl.k === 'variable') {
        this.variableOf.set(decl.name.binding!, this.variables.length);
        this.variables.push(decl.name.text);
      }
    }
    const init = this.newBody('init', 'initialiser');
    const clauses = new Map<string, number>();
    const owners: [Function | Handler, Body][] = [];
    for (const decl of decls) {
      if (decl.k === 'function') {
        const body = this.newBody('function', decl.name);
        body.params = decl.params.map(param => param.name.text);
        this.functionOf.set(decl.binding, body.index);
        owners.push([decl, body]);
      } else if (decl.k === 'handler') {
        const clause = (clauses.get(decl.name) ?? 0) + 1;
        clauses.set(decl.name, clause);
        const body = this.newBody('handler', decl.name, clause);
        body.deciding = decl.deciding;
        body.policy = decl.policy;
        body.params = decl.params.map(p =>
          p.k === 'bind' ? p.name.text : '…',
        );
        owners.push([decl, body]);
      }
    }
    // Each default is a Constant the initialiser computes (ADR 0035).
    for (const [decl, body] of owners) {
      if (decl.k === 'function') {
        body.defaults = decl.params.map(param =>
          param.default
            ? this.definition(
                `${decl.name}.${param.name.text}`,
                `${decl.name}.${param.name.text}`,
              )
            : null,
        );
      }
    }
    yield new BodyLowering(this, init, 0).initialiser(decls);
    for (const [decl, body] of owners) {
      const lowering = new BodyLowering(this, body, decl.scope);
      yield decl.k === 'function'
        ? lowering.function(decl)
        : lowering.handler(decl);
    }
  }

  finish(): CodeUnit {
    const code: Instruction[] = [];
    const unwind: UnwindEntry[] = [];
    const offers: OfferEntry[] = [];
    for (const body of this.bodies) {
      body.start = code.length;
      if (body.acceptedAt !== undefined) {
        body.acceptedAt += body.start;
      }
      for (const ins of this.code.get(body.index) ?? []) {
        code.push({
          op: ins.op,
          line: ins.line,
          col: ins.col,
          operands: ins.operands.map(operand => {
            if (typeof operand !== 'object') {
              return operand;
            }
            if (operand.pc === null) {
              throw new Error(`an unplaced label in ${body.name}`);
            }
            return body.start + operand.pc;
          }),
        });
        if (pendingStatements.has(ins)) {
          statementStarts.add(code.at(-1)!);
        }
        if (instructionSpec.get(ins.op)!.suspends) {
          body.maySuspend = true;
        }
      }
      body.end = code.length;
      const offerBase = offers.length;
      for (const entry of this.offers.get(body.index) ?? []) {
        offers.push({
          ...entry,
          end: body.start + entry.end.pc!,
          offers: entry.offers.map(o => ({
            ...o,
            target: body.start + o.target.pc!,
          })),
        });
      }
      for (const entry of this.unwind.get(body.index) ?? []) {
        const target =
          typeof entry.target === 'number' ? entry.target : entry.target.pc!;
        unwind.push({
          ...entry,
          start: body.start + entry.start,
          end: body.start + entry.end,
          target:
            entry.kind === 'offer' ? offerBase + target : body.start + target,
        });
      }
    }
    return {
      name: this.name,
      kind: this.kind,
      constants: this.constants,
      definitions: this.definitions,
      variables: this.variables,
      objects: this.objects,
      bodies: this.bodies,
      code,
      unwind,
      ...(offers.length ? { offers } : {}),
      events: this.events,
      patterns: this.patterns,
    };
  }
}

class BodyLowering {
  code: Pending[] = [];
  unwind: PendingUnwind[] = [];
  offers: PendingOffer[] = [];
  slots = new Map<Binding, number>();
  // Pattern temps a Guard or a later Binary Pattern size reads by name.
  overrides = new Map<Binding, number>();
  locals: string[] = ['it'];
  free: number[] = [];
  loops: Loop[] = [];
  finallies: Stmt[][] = [];
  // The open `try`s, outermost first: their entries' spans and their
  // `finally` block's index in `finallies`.
  tries: {
    catch: Span | null;
    finally: number | null;
    finallySpan: Span | null;
    offer: Span | null;
  }[] = [];
  join = 0;
  iterators = 0;
  private starts = new Set<number>();

  constructor(
    readonly u: UnitLowering,
    readonly body: Body,
    readonly scope: number | null,
  ) {}

  // ------------------------------------------------------------- emission

  emit(at: Pos, op: string, ...operands: (Operand | Label)[]): number {
    const ins = { op, operands, line: at.line, col: at.col };
    if (this.starts.delete(this.code.length)) {
      pendingStatements.add(ins);
    }
    this.code.push(ins);
    return this.code.length - 1;
  }

  label(): Label {
    return { pc: null };
  }

  place(label: Label) {
    label.pc = this.code.length;
  }

  constant(at: Pos, display: string) {
    this.emit(at, 'const', this.u.constant(display));
  }

  finish() {
    this.body.locals = this.locals;
    this.u.code.set(this.body.index, this.code);
    this.u.unwind.set(this.body.index, this.unwind);
    this.u.offers.set(this.body.index, this.offers);
  }

  unsupported(at: Pos, what: string): never {
    throw new LoweringError(at.line, at.col, what);
  }

  // ------------------------------------------------------------- slots

  /** The next slot, for a named local or an unnamed argument. */
  slot(name: string, binding?: Binding): number {
    const slot = this.locals.length;
    this.locals.push(name);
    if (binding) {
      this.slots.set(binding, slot);
    }
    return slot;
  }

  /** The lowest temp released, or a new slot after the others. */
  temp(): number {
    if (this.free.length) {
      this.free.sort((a, b) => a - b);
      return this.free.shift()!;
    }
    return this.slot(`(${this.locals.length})`);
  }

  release(...slots: number[]) {
    this.free.push(...slots);
  }

  /**
   * Chapter 8's slot order, after `it`: the arguments, the names parameter
   * patterns bind, the captures, then the body's other locals by first binding
   * site.
   */
  layout(
    params: Pattern[],
    captures: readonly Binding[],
    locals: readonly Binding[],
  ) {
    // A parameter that isn't a plain name has an argument slot of its own.
    const argSlots = params.map(p =>
      p.k === 'bind'
        ? this.slot(p.name.text, p.name.binding!)
        : this.slot(`(${this.locals.length})`),
    );
    for (const p of params) {
      if (p.k !== 'bind') {
        for (const name of patternNames(p)) {
          if (!this.slots.has(name.binding!)) {
            this.slot(name.text, name.binding!);
          }
        }
      }
    }
    this.body.captureStart = this.locals.length;
    for (const binding of captures) {
      this.slot(binding.name, binding);
    }
    this.body.captures = captures.length;
    for (const binding of locals) {
      if (!this.slots.has(binding)) {
        this.slot(binding.name, binding);
      }
    }
    return argSlots;
  }

  /** The other locals of a checker scope, by first binding site. */
  scopeLocals(): Binding[] {
    const scope = this.u.scopes[this.scope!]!;
    return scope.bindings
      .filter(
        b => (b.kind === 'local' || b.kind === 'parameter') && !this.isIt(b),
      )
      .sort((a, b) => a.span!.start - b.span!.start);
  }

  isIt(binding: Binding): boolean {
    return (
      binding.kind === 'local' && binding.name === 'it' && binding.span === null
    );
  }

  slotOf(binding: Binding): number | undefined {
    if (this.isIt(binding)) {
      return 0;
    }
    return this.overrides.get(binding) ?? this.slots.get(binding);
  }

  // ------------------------------------------------------------- names

  load(name: SemanticName, at: Pos) {
    const binding = name.binding!;
    const slot = this.slotOf(binding);
    if (slot !== undefined) {
      return this.emit(at, 'load', slot);
    }
    switch (binding.kind) {
      case 'script variable':
        return this.emit(at, 'load-var', this.u.variableOf.get(binding)!);
      case 'constant':
        return this.emit(
          at,
          'load-definition',
          this.u.definitionOf.get(binding)!,
        );
      case 'function':
        return binding.importedFrom
          ? this.emit(at, 'make-imported-function', importName(binding))
          : this.emit(at, 'make-function', this.u.functionOf.get(binding)!);
      case 'object':
        return this.emit(at, 'load-object', this.u.object(binding.name));
      case 'builtin constant':
        return this.constant(at, binding.name);
    }
    throw new Error(`${name.text} (${binding.kind}) has no slot here`);
  }

  store(name: SemanticName, at: Pos) {
    const binding = name.binding!;
    const slot = this.slotOf(binding);
    if (slot !== undefined) {
      return this.emit(at, 'store', slot);
    }
    if (binding.kind === 'script variable') {
      return this.emit(at, 'store-var', this.u.variableOf.get(binding)!);
    }
    // Chapter 4 roots a Container in a local or a Script Variable, and doesn't
    // settle a root that names a well-known object.
    return this.unsupported(
      at,
      `a Container rooted in the ${binding.kind} \`${name.text}\``,
    );
  }

  // ------------------------------------------------------------- bodies

  *initialiser(decls: Decl[]): Task {
    for (const decl of decls) {
      if (decl.k === 'variable' && decl.init) {
        yield this.expr(decl.init);
        this.emit(
          decl.pos,
          'store-var',
          this.u.variableOf.get(decl.name.binding!)!,
        );
      } else if (decl.k === 'constant') {
        yield this.expr(decl.value);
        this.emit(
          decl.pos,
          'store-definition',
          this.u.definitionOf.get(decl.name.binding!)!,
        );
      } else if (decl.k === 'function') {
        for (const param of decl.params) {
          if (param.default) {
            yield this.expr(param.default);
            this.emit(
              param.pos,
              'store-definition',
              this.u.definitionOf.get(`${decl.name}.${param.name.text}`)!,
            );
          }
        }
      }
    }
    this.returnNothing({ line: 1, col: 1 });
    this.finish();
  }

  *function(decl: Function): Task {
    for (const param of decl.params) {
      this.slot(param.name.text, param.name.binding!);
    }
    this.layout([], [], this.scopeLocals());
    yield this.block(decl.body);
    this.returnNothing(decl.end);
    this.finish();
  }

  *handler(decl: Handler): Task {
    const params =
      decl.name === 'error' && decl.params.length === 1
        ? decl.params.map(errorPattern)
        : decl.params;
    const args = this.layout(params, [], this.scopeLocals());
    if (decl.during?.binding) {
      this.body.duringSlot = this.slots.get(decl.during.binding);
    }
    const failed = this.label();
    yield this.guarded(
      failed,
      this.parameters(params, args, decl.guard, failed),
    );
    this.body.acceptedAt = this.code.length;
    yield decl.finally
      ? this.tryStatement(
          {
            k: 'try',
            pos: decl.finallyPos!,
            body: decl.body,
            catches: [],
            offers: [],
            finally: decl.finally,
          },
          decl.finallyPos!,
        )
      : this.block(decl.body);
    this.returnNothing(decl.end);
    this.place(failed);
    this.emit(decl.end, 'clause-fail');
    this.finish();
  }

  // The parameter patterns that aren't plain names, tested against their
  // arguments and bound directly, then a Guard, all failing to `failed`.
  *parameters(
    params: Pattern[],
    args: number[],
    guard: Guard | null,
    failed: Label,
  ): Task {
    for (const [i, p] of params.entries()) {
      if (p.k !== 'bind') {
        yield this.pattern(p, args[i]!, failed, null, false);
      }
    }
    if (guard) {
      yield this.guard(guard, failed);
    }
  }

  *guard(guard: Guard, failed: Label): Task {
    yield this.expr(guard.e);
    this.emit(guard.pos, 'branch-false', failed);
  }

  // Code in which any error goes to `failed`: a `guard` entry, made as the
  // region ends.
  *guarded(failed: Label, region: Task): Task {
    const start = this.code.length;
    yield region;
    if (this.code.length > start) {
      this.unwind.push({
        start,
        end: this.code.length,
        kind: 'guard',
        target: failed,
        depth: this.iterators,
      });
    }
  }

  returnNothing(at: Pos) {
    this.constant(at, 'nothing');
    this.emit(at, 'return');
  }

  *lambda(e: Lambda): Task {
    const scope = this.u.scopes[e.scope]!;
    const args = this.layout(e.params, scope.captures, this.scopeLocals());
    const failed = this.label();
    const patterns = e.params.some(p => p.k !== 'bind');
    if (patterns) {
      yield this.parameters(e.params, args, null, failed);
    }
    if (Array.isArray(e.body)) {
      yield this.block(e.body);
      this.returnNothing(e.end!);
    } else {
      yield this.expr(e.body);
      this.emit(e.pos, 'return');
    }
    if (patterns) {
      this.place(failed);
      this.emit(e.pos, 'raise', 'no match');
    }
    this.finish();
  }

  // ------------------------------------------------------------- statements

  *block(stmts: readonly Stmt[]): Task {
    for (const s of stmts) {
      yield this.statement(s);
    }
  }

  *statement(s: Stmt): Task {
    this.starts.add(this.code.length);
    const at = s.pos;
    switch (s.k) {
      case 'put':
        return yield* this.put(s);
      case 'let':
        return yield* this.letStatement(s);
      case 'set': {
        const target = s.target;
        if (target.k === 'computed') {
          yield this.expr(target.key);
        } else if (target.k !== 'key') {
          return this.unsupported(at, '`set` of anything but a key');
        }
        yield this.expr(target.base);
        yield this.expr(s.value);
        return void (target.k === 'key'
          ? this.emit(at, 'set-property', target.key)
          : this.emit(at, 'set-property-computed'));
      }
      case 'arithmetic':
        return yield* this.arithmetic(s);
      case 'delete':
        return yield* this.deleteStatement(s);
      case 'replace-statement':
        return yield* this.replaceStatement(s);
      case 'if':
        return yield* this.ifStatement(s);
      case 'repeat':
        return yield* this.repeat(s);
      case 'match':
        return yield* this.match(s);
      case 'choose-offer':
        for (const arg of s.args) {
          yield this.expr(arg);
        }
        return void this.emit(at, 'choose-offer', s.name, s.args.length);
      case 'try':
        return yield* this.tryStatement(s, s.pos);
      case 'throw':
        yield this.expr(s.value);
        return void this.emit(at, 'throw');
      case 'return':
      case 'veto':
        if (s.value) {
          yield this.expr(s.value);
        } else {
          this.constant(at, 'nothing');
        }
        return yield* this.leaveBody(at, true, s.k);
      case 'pass':
        return yield* this.leaveBody(at, false, 'pass', s.message);
      case 'exit':
      case 'next': {
        const loop = this.loops.at(-1)!;
        return yield* this.leave(loop.finallies, () =>
          this.emit(at, 'jump', s.k === 'exit' ? loop.exit : loop.top),
        );
      }
      case 'command':
        return yield* this.command(s);
      case 'call':
        yield this.call(s.call, s.wait);
        return void this.emit(at, 'store', 0);
      case 'tell-block':
        // Each line is the one-line call the checker chose for it (ADR 0063).
        return yield* this.block(s.lines);
      case 'ask':
      case 'tell': {
        for (const arg of s.args) {
          yield this.expr(arg);
        }
        const n = s.args.length;
        if (s.k === 'tell') {
          return void this.emit(at, 'tell', s.grant, s.operation, n);
        }
        if (s.wait && this.join) {
          return void this.emit(at, 'join-ask', s.grant, s.operation, n);
        }
        this.emit(at, s.wait ? 'ask-wait' : 'ask', s.grant, s.operation, n);
        return void this.emit(at, 'store', 0);
      }
      case 'send': {
        // A computed name is evaluated first, below the arguments (ADR 0057).
        const message = s.message;
        if (typeof message !== 'string') {
          yield this.expr(message);
        }
        for (const arg of s.args) {
          yield this.expr(arg);
        }
        yield this.expr(s.target);
        const n = s.args.length;
        if (typeof message !== 'string') {
          if (s.wait && this.join) {
            return void this.emit(at, 'join-send-named', n);
          }
          this.emit(at, s.wait ? 'send-named-wait' : 'send-named', n);
        } else if (s.wait && this.join) {
          return void this.emit(at, 'join-send', message, n);
        } else {
          this.emit(at, s.wait ? 'send-wait' : 'send', message, n);
        }
        if (s.wait) {
          this.emit(at, 'store', 0);
        }
        return;
      }
      case 'wait':
        yield this.expr(s.duration);
        return void this.emit(at, 'wait');
      case 'wait-for':
        return yield* this.waitFor(s);
      case 'wait-block':
        return yield* this.waitBlock(s);
      case 'join':
        this.emit(at, 'join-start');
        this.join++;
        yield this.block(s.body);
        this.join--;
        this.emit(s.end, 'join-end');
        return void this.emit(at, 'store', 0);
    }
  }

  *command(s: Stmt & { k: 'command' }): Task {
    const at = s.pos;
    for (const arg of s.args) {
      yield this.expr(arg);
    }
    const n = s.args.length;
    if (s.name.text === 'say') {
      return void this.emit(at, 'tell', 'console', 'write', n);
    }
    const binding = s.name.binding;
    if (binding?.kind === 'handler') {
      const name = binding.importedFrom ? importName(binding) : binding.name;
      this.emit(at, s.wait ? 'call-handler-wait' : 'call-handler', name, n);
      return void this.emit(at, 'store', 0);
    }
    if (s.wait) {
      this.emit(at, 'send-up-wait', s.name.text, n);
      return void this.emit(at, 'store', 0);
    }
    this.emit(at, 'send-up', s.name.text, n);
  }

  *letStatement(s: Stmt & { k: 'let' }): Task {
    yield this.expr(s.value);
    const t = this.temp();
    this.emit(s.pos, 'store', t);
    const failed = this.label();
    const done = this.label();
    const binds: Binds = new Map();
    yield this.pattern(s.pat, t, failed, binds, false);
    this.commit(s.pos, binds);
    this.emit(s.pos, 'jump', done);
    this.place(failed);
    this.emit(s.pos, 'raise', 'no match');
    this.place(done);
    this.release(t);
  }

  // Copies a pattern's temp bindings into the names' own slots.
  commit(at: Pos, binds: Binds) {
    for (const [binding, t] of binds) {
      this.emit(at, 'move', t, this.slots.get(binding)!);
      this.release(t);
    }
  }

  *ifStatement(s: Stmt & { k: 'if' }): Task {
    const end = this.label();
    for (const [i, arm] of s.arms.entries()) {
      const next = this.label();
      yield this.expr(arm.cond);
      this.emit(s.pos, 'branch-false', next);
      yield this.block(arm.body);
      if (i < s.arms.length - 1 || s.else) {
        this.emit(s.pos, 'jump', end);
      }
      this.place(next);
    }
    if (s.else) {
      yield this.block(s.else);
    }
    this.place(end);
  }

  *repeat(s: Stmt & { k: 'repeat' }): Task {
    const at = s.pos;
    const { head, collect } = s;
    if (collect) {
      this.emit(collect.pos, 'list', 0);
      this.store(collect.target, collect.pos);
    }
    const loop: Loop = {
      top: this.label(),
      exit: this.label(),
      finallies: this.finallies.length,
    };
    if (head.k === 'each' || head.k === 'times') {
      yield this.expr(head.k === 'each' ? head.src : head.count);
      this.emit(at, head.k === 'each' ? 'iterate' : 'iterate-times');
      this.iterators++;
      this.place(loop.top);
      this.starts.add(this.code.length);
      this.emit(at, 'next', loop.exit);
      if (head.k === 'times') {
        this.emit(at, 'pop');
      } else if (head.pat.k === 'bind') {
        this.store(head.pat.name, at);
      } else {
        const t = this.temp();
        this.emit(at, 'store', t);
        const failed = this.label();
        const ok = this.label();
        const binds: Binds = new Map();
        yield this.pattern(head.pat, t, failed, binds, false);
        this.commit(at, binds);
        this.release(t);
        this.emit(at, 'jump', ok);
        this.place(failed);
        this.emit(at, 'raise', 'no match');
        this.place(ok);
      }
      this.loops.push(loop);
      yield this.block(s.body);
      yield this.appendCollected(s);
      this.loops.pop();
      this.emit(at, 'jump', loop.top);
      this.place(loop.exit);
      this.emit(at, 'pop');
      this.iterators--;
      return;
    }
    this.place(loop.top);
    if (head.k === 'while' || head.k === 'until') {
      yield this.expr(head.cond);
      this.emit(
        at,
        head.k === 'while' ? 'branch-false' : 'branch-true',
        loop.exit,
      );
    }
    this.loops.push(loop);
    yield this.block(s.body);
    yield this.appendCollected(s);
    this.loops.pop();
    this.emit(at, 'jump', loop.top);
    this.place(loop.exit);
  }

  *appendCollected(s: Stmt & { k: 'repeat' }): Task {
    const { collect } = s;
    if (collect) {
      this.load(collect.target, collect.pos);
      yield this.expr(collect.value);
      this.emit(collect.pos, 'list-append');
      this.store(collect.target, collect.pos);
    }
  }

  // `return`, `veto` and `pass` run the open `finally` blocks first.
  *leaveBody(
    at: Pos,
    value: boolean,
    op: 'return' | 'veto' | 'pass',
    message?: string,
  ): Task {
    const tail = () =>
      message === undefined ? this.emit(at, op) : this.emit(at, op, message);
    if (!this.finallies.length) {
      return void tail();
    }
    let t = -1;
    if (value) {
      t = this.temp();
      this.emit(at, 'store', t);
    }
    yield this.leave(0, () => {
      if (value) {
        this.emit(at, 'load', t);
      }
      tail();
    });
    if (value) {
      this.release(t);
    }
  }

  // Leaves the `finally` blocks from `depth` in: lowers a copy of each,
  // innermost first, then `tail`. The copies and the tail are outside the
  // spans of those `try`s and of every `try` inside them (chapter 8).
  *leave(depth: number, tail: () => void): Task {
    if (depth >= this.finallies.length) {
      return void tail();
    }
    const from = this.tries.findIndex(t => t.finally === depth);
    const paused = this.tries
      .slice(from)
      .flatMap(t => [t.catch, t.offer, t.finallySpan])
      .filter((span): span is Span => !!span && span.open !== null);
    for (const span of paused) {
      this.close(span);
    }
    const saved = this.finallies;
    for (let i = saved.length - 1; i >= depth; i--) {
      this.finallies = saved.slice(0, i);
      yield this.block(saved[i]!);
    }
    this.finallies = saved;
    tail();
    for (const span of paused) {
      span.open = this.code.length;
    }
  }

  close(span: Span) {
    if (span.open !== null && span.open < this.code.length) {
      span.spans.push([span.open, this.code.length]);
    }
    span.open = null;
  }

  entries(span: Span, kind: 'catch' | 'finally' | 'offer', target: number) {
    for (const [start, end] of span.spans) {
      this.unwind.push({ start, end, kind, target, depth: this.iterators });
    }
  }

  *match(s: Stmt & { k: 'match' }): Task {
    yield this.expr(s.subject);
    const t = this.temp();
    this.emit(s.pos, 'store', t);
    const end = this.label();
    for (const branch of s.branches) {
      const at = branch.pos;
      const next = this.label();
      const binds: Binds = new Map();
      const self = this;
      yield this.guarded(
        next,
        (function* (): Task {
          if (branch.search) {
            if (branch.pat.k !== 'text') {
              return self.unsupported(
                at,
                '`when contains` without a Text Pattern',
              );
            }
            self.emit(branch.pat.pos, 'load', t);
            yield self.textPatternValue(branch.pat.pattern, branch.pat.pos);
            self.emit(
              branch.pat.pos,
              'match-search',
              ...(s.fold ? ['fold', next] : [next]),
            );
            self.captures(branch.pat.pattern, branch.pat.pos, binds);
          } else {
            yield self.pattern(branch.pat, t, next, binds, s.fold);
          }
          if (branch.guard) {
            yield self.guardWith(branch.guard, next, binds);
          }
        })(),
      );
      this.commit(at, binds);
      yield this.block(branch.body);
      this.emit(at, 'jump', end);
      this.place(next);
    }
    if (s.else) {
      yield this.block(s.else);
    }
    this.place(end);
    this.release(t);
  }

  // A Guard that reads a pattern's temp bindings under their names.
  *guardWith(guard: Guard, failed: Label, binds: Binds): Task {
    const saved = new Map(this.overrides);
    for (const [binding, t] of binds) {
      this.overrides.set(binding, t);
    }
    yield this.guard(guard, failed);
    this.overrides = saved;
  }

  // A `try`: its body, its catch handler and its `finally` (chapter 8).
  *tryStatement(s: Try, at: Pos): Task {
    const end = this.label();
    const hasFinally = s.finally !== null;
    const offerSpan: Span | null = s.offers.length
      ? { spans: [], open: this.code.length }
      : null;
    const catchSpan: Span | null = s.catches.length
      ? { spans: [], open: this.code.length }
      : null;
    const finallySpan: Span | null = hasFinally
      ? { spans: [], open: this.code.length }
      : null;
    if (hasFinally) {
      this.finallies.push(s.finally!);
    }
    const me = {
      finally: hasFinally ? this.finallies.length - 1 : null,
      catch: catchSpan,
      offer: offerSpan,
      finallySpan,
    };
    this.tries.push(me);
    yield this.block(s.body);
    if (catchSpan) {
      this.close(catchSpan);
    }
    if (offerSpan) {
      this.close(offerSpan);
    }
    yield this.leave(hasFinally ? me.finally! : this.finallies.length, () =>
      this.emit(at, 'jump', end),
    );
    if (catchSpan) {
      this.entries(catchSpan, 'catch', this.code.length);
      // Dispatch must not reuse scratch slots still live in retained continuations.
      const retainedFree = this.free;
      this.free = [];
      const error = this.temp();
      // The error is on the stack until it is stored, so the finally spans
      // start after the store.
      if (finallySpan) {
        this.close(finallySpan);
      }
      this.emit(s.catches[0]!.pos, 'store', error);
      if (finallySpan) {
        finallySpan.open = this.code.length;
      }
      for (const clause of s.catches) {
        const next = this.label();
        const binds: Binds = new Map();
        // A text literal head is short for `{code: "…"}`.
        const pat = errorPattern(clause.pat);
        const self = this;
        yield this.guarded(
          next,
          (function* (): Task {
            yield self.pattern(pat, error, next, binds, false);
            if (clause.guard) {
              yield self.guardWith(clause.guard, next, binds);
            }
          })(),
        );
        if (!clause.recovery) {
          this.emit(clause.pos, 'catch-accept');
        }
        this.commit(clause.pos, binds);
        yield this.block(clause.body);
        if (!clause.recovery) {
          yield this.leave(
            hasFinally ? me.finally! : this.finallies.length,
            () => this.emit(clause.pos, 'jump', end),
          );
        }
        this.place(next);
      }
      this.emit(s.catches.at(-1)!.pos, 'catch-next');
      this.release(error);
      this.free = [...retainedFree, ...this.free];
    }
    if (offerSpan) {
      const record: PendingOffer = {
        body: this.body.index,
        depth: this.iterators,
        end,
        offers: [],
      };
      for (const offer of s.offers) {
        const target = this.label();
        this.place(target);
        record.offers.push({
          name: offer.name,
          binds: offer.params.map(p => this.slots.get(p.binding!)!),
          target,
        });
        yield this.block(offer.body);
        yield this.leave(hasFinally ? me.finally! : this.finallies.length, () =>
          this.emit(offer.pos, 'jump', end),
        );
      }
      const index = this.offers.length;
      this.offers.push(record);
      this.entries(offerSpan, 'offer', index);
    }
    this.tries.pop();
    if (finallySpan) {
      this.close(finallySpan);
      this.finallies.pop();
      this.entries(finallySpan, 'finally', this.code.length);
      yield this.block(s.finally!);
      this.emit(at, 'end-cleanup');
    }
    this.place(end);
  }

  // ------------------------------------------------------------- waiting

  // An event test body: the event's patterns and Guard over the message's
  // arguments, as one guard region, giving the list of the values it binds.
  // Its captures are the waiting body's locals it reads.
  *eventBody(event: Event, guard: Guard | null, at: Pos): Task<EventBranch> {
    const names = event.pats.flatMap(patternNames);
    if (!event.pats.length && !guard) {
      return {
        kind: 'when',
        message: event.message,
        from: event.from !== null,
        body: null,
        captures: 0,
        binds: [],
      };
    }
    const body = this.u.newBody('event', event.message);
    body.params = event.pats.map(p => (p.k === 'bind' ? p.name.text : '…'));
    const test = new BodyLowering(this.u, body, null);
    const own = new Set(names.map(name => name.binding!));
    const captures: Binding[] = [];
    for (const name of eventReads(event, guard)) {
      const binding = name.binding!;
      if (
        !own.has(binding) &&
        !captures.includes(binding) &&
        !test.isIt(binding) &&
        this.slotOf(binding) !== undefined
      ) {
        captures.push(binding);
      }
    }
    const args = test.layout(event.pats, captures, []);
    for (const binding of captures) {
      this.emit(at, 'load', this.slotOf(binding)!);
    }
    const failed = test.label();
    yield test.guarded(
      failed,
      test.parameters(event.pats, args, guard, failed),
    );
    for (const name of names) {
      test.emit(at, 'load', test.slotOf(name.binding!)!);
    }
    test.emit(at, 'list', names.length);
    test.emit(at, 'return');
    test.place(failed);
    test.emit(at, 'clause-fail');
    test.finish();
    return {
      kind: 'when',
      message: event.message,
      from: event.from !== null,
      body: body.index,
      captures: captures.length,
      binds: names.map(name => this.slotOf(name.binding!)!),
    };
  }

  *waitFor(s: Stmt & { k: 'wait-for' }): Task {
    const entry: EventEntry = { branches: [], timeout: s.timeout !== null };
    this.u.events.push(entry);
    const index = this.u.events.length - 1;
    if (s.event.from) {
      yield this.expr(s.event.from);
    }
    entry.branches.push(
      (yield this.eventBody(s.event, null, s.pos)) as EventBranch,
    );
    if (s.timeout) {
      yield this.expr(s.timeout);
    }
    this.emit(s.pos, 'wait-for', index);
    this.emit(s.pos, 'store', 0);
  }

  *waitBlock(s: Stmt & { k: 'wait-block' }): Task {
    const entry: EventEntry = { branches: [], timeout: false };
    this.u.events.push(entry);
    const index = this.u.events.length - 1;
    for (const branch of s.branches) {
      if (branch.k === 'when') {
        if (branch.event.from) {
          yield this.expr(branch.event.from);
        }
        entry.branches.push(
          (yield this.eventBody(
            branch.event,
            branch.guard,
            branch.pos,
          )) as EventBranch,
        );
      } else {
        yield this.expr(branch.duration);
        entry.branches.push({ kind: 'after' });
      }
    }
    this.emit(s.pos, 'wait-for-any', index);
    const which = this.temp();
    this.emit(s.pos, 'store', which);
    this.emit(s.pos, 'store', 0);
    const end = this.label();
    for (const [i, branch] of s.branches.entries()) {
      const at = branch.pos;
      const next = this.label();
      this.emit(at, 'load', which);
      this.constant(at, String(i + 1));
      this.emit(at, 'equal');
      this.emit(at, 'branch-false', next);
      yield this.block(branch.body);
      this.emit(at, 'jump', end);
      this.place(next);
    }
    this.place(end);
    this.release(which);
  }

  // ------------------------------------------------------------- Containers

  levels(c: Expr): { levels: Expr[]; root: SemanticName; rootPos: Pos } {
    const levels: Expr[] = [];
    let e = c;
    for (;;) {
      if (e.k === 'name') {
        return { levels, root: e.name, rootPos: e.pos };
      }
      if (e.k !== 'chunk' && e.k !== 'key' && e.k !== 'computed') {
        return this.unsupported(
          e.pos,
          'a Container level that is not a chunk or key',
        );
      }
      levels.unshift(e);
      e = e.base;
    }
  }

  // A read-modify-write of a Container (chapter 8). `before` lowers what the
  // statement evaluates before the Container. `part` lowers the new leaf,
  // given a lowering of its old value. With `skip`, for `delete`, every level
  // is tested before it is read, and a missing one jumps past the store.
  *update(
    at: Pos,
    c: Expr,
    part: (old: () => Task) => Task,
    before: (() => Task) | null,
    delimiter: Expr | null,
    skip: Label | null,
  ): Task {
    const { root, levels } = this.levels(c);
    if (before) {
      yield before();
    }
    if (!levels.length) {
      const self = this;
      yield part(function* () {
        self.load(root, at);
      });
      this.store(root, at);
      return;
    }
    const d = delimiter ?? (c.k === 'chunk' ? c.delimiter : null);
    // The indexes and computed keys, from the leaf back, as the source has them.
    const index: (number | null)[] = [];
    for (let i = levels.length - 1; i >= 0; i--) {
      const level = levels[i]!;
      if (level.k === 'key') {
        index[i] = null;
        continue;
      }
      if (level.k === 'chunk') {
        if (typeof level.index === 'number') {
          this.constant(level.pos, String(level.index));
        } else {
          yield this.expr(level.index);
        }
      } else if (level.k === 'computed') {
        yield this.expr(level.key);
      }
      index[i] = this.temp();
      this.emit(level.pos, 'store', index[i]!);
    }
    let dt: number | null = null;
    if (d) {
      yield this.expr(d);
      dt = this.temp();
      this.emit(levels.at(-1)!.pos, 'store', dt);
    }
    // The wholes, from the root down.
    const whole: number[] = [];
    this.load(root, at);
    whole[0] = this.temp();
    this.emit(at, 'store', whole[0]);
    const read = skip ? levels.length : levels.length - 1;
    for (let i = 0; i < read; i++) {
      const level = levels[i]!;
      if (skip) {
        this.testLevel(level, index[i]!, whole[i]!, dt, skip);
      }
      this.getLevel(level, index[i]!, whole[i]!, dt);
      whole[i + 1] = this.temp();
      this.emit(level.pos, 'store', whole[i + 1]!);
    }
    const leaf = levels.length - 1;
    const self = this;
    const write = function* (i: number): Task {
      const level = levels[i]!;
      if (level.k !== 'key') {
        self.emit(level.pos, 'load', index[i]!);
      }
      self.emit(level.pos, 'load', whole[i]!);
      yield i === leaf
        ? part(function* () {
            if (skip) {
              self.emit(level.pos, 'load', whole[i + 1]!);
            } else {
              self.getLevel(level, index[i]!, whole[i]!, dt);
            }
          })
        : write(i + 1);
      self.setLevel(level, dt);
    };
    yield write(0);
    this.store(root, at);
    this.release(
      ...index.filter((slot): slot is number => slot !== null),
      ...whole,
      ...(dt === null ? [] : [dt]),
    );
  }

  testLevel(
    level: Expr,
    index: number | null,
    whole: number,
    d: number | null,
    skip: Label,
  ) {
    const at = level.pos;
    if (level.k === 'key' || level.k === 'computed') {
      if (level.k === 'computed') {
        this.emit(at, 'load', index!);
      }
      this.emit(at, 'load', whole);
      return void (level.k === 'key'
        ? this.emit(at, 'test-key', level.key, skip)
        : this.emit(at, 'test-key-computed', skip));
    }
    if (level.k !== 'chunk') {
      return;
    }
    this.emit(at, 'load', index!);
    this.emit(at, 'load', whole);
    if (d !== null && level.kind === 'item') {
      this.emit(at, 'load', d);
      this.emit(at, 'test-chunk-delimited', level.kind, skip);
    } else {
      this.emit(at, 'test-chunk', level.kind, skip);
    }
  }

  getLevel(level: Expr, index: number | null, whole: number, d: number | null) {
    const at = level.pos;
    if (level.k === 'key' || level.k === 'computed') {
      if (level.k === 'computed') {
        this.emit(at, 'load', index!);
      }
      this.emit(at, 'load', whole);
      return void (level.k === 'key'
        ? this.emit(at, 'get-key', level.key)
        : this.emit(at, 'get-key-computed'));
    }
    if (level.k !== 'chunk') {
      return;
    }
    this.emit(at, 'load', index!);
    this.emit(at, 'load', whole);
    if (d !== null && level.kind === 'item') {
      this.emit(at, 'load', d);
      this.emit(at, 'chunk-get-delimited', level.kind);
    } else {
      this.emit(at, 'chunk-get', level.kind);
    }
  }

  setLevel(level: Expr, d: number | null) {
    const at = level.pos;
    if (level.k === 'key') {
      return void this.emit(at, 'set-key', level.key);
    }
    if (level.k === 'computed') {
      return void this.emit(at, 'set-key-computed');
    }
    if (level.k !== 'chunk') {
      return;
    }
    if (d !== null && level.kind === 'item') {
      this.emit(at, 'load', d);
      this.emit(at, 'chunk-set-delimited', level.kind);
    } else {
      this.emit(at, 'chunk-set', level.kind);
    }
  }

  *put(s: Stmt & { k: 'put' }): Task {
    const at = s.pos;
    const self = this;
    if (s.prep === 'into' && s.target.k === 'name') {
      yield this.expr(s.value);
      return void this.store(s.target.name, at);
    }
    let v = -1;
    const before = function* (): Task {
      yield self.expr(s.value);
      v = self.temp();
      self.emit(at, 'store', v);
    };
    const op =
      s.prep === 'after'
        ? s.spread
          ? 'append-all'
          : 'append'
        : s.spread
          ? 'prepend-all'
          : 'prepend';
    yield this.update(
      at,
      s.target,
      function* (old) {
        if (s.prep !== 'into') {
          yield old();
        }
        self.emit(at, 'load', v);
        if (s.prep !== 'into') {
          self.emit(at, op);
        }
      },
      before,
      null,
      null,
    );
    this.release(v);
  }

  *arithmetic(s: Stmt & { k: 'arithmetic' }): Task {
    const at = s.pos;
    const self = this;
    let v = -1;
    const value = function* (): Task {
      yield self.expr(s.value);
      v = self.temp();
      self.emit(at, 'store', v);
    };
    // `add e to c` and `subtract e from c` have the value first in the
    // source, and `multiply c by e` and `divide c by e` have it last.
    const first = s.op === 'add' || s.op === 'subtract';
    yield this.update(
      at,
      s.target,
      function* (old) {
        yield old();
        if (!first) {
          yield value();
        }
        self.emit(at, 'load', v);
        self.emit(at, s.op);
      },
      first ? value : null,
      null,
      null,
    );
    this.release(v);
  }

  // `delete` is a write one level up: the leaf's index or computed key comes
  // first, then the write of the level above, whose new part is the whole
  // with the leaf deleted (chapter 8).
  *deleteStatement(s: Stmt & { k: 'delete' }): Task {
    const at = s.pos;
    const { root, levels } = this.levels(s.target);
    if (!levels.length) {
      this.constant(at, 'nothing');
      return void this.store(root, at);
    }
    const leaf = levels.at(-1)!;
    const delimiter = s.target.k === 'chunk' ? s.target.delimiter : null;
    const self = this;
    let i = -1;
    const index = function* (): Task {
      if (leaf.k === 'key') {
        return;
      }
      if (leaf.k === 'chunk') {
        if (typeof leaf.index === 'number') {
          self.constant(leaf.pos, String(leaf.index));
        } else {
          yield self.expr(leaf.index);
        }
      } else if (leaf.k === 'computed') {
        yield self.expr(leaf.key);
      }
      i = self.temp();
      self.emit(leaf.pos, 'store', i);
    };
    const remove = function* (old: () => Task): Task {
      const where = leaf.pos;
      if (i >= 0) {
        self.emit(where, 'load', i);
      }
      yield old();
      if (leaf.k === 'key') {
        return void self.emit(where, 'delete-key', leaf.key);
      }
      if (leaf.k === 'computed') {
        return void self.emit(where, 'delete-key-computed');
      }
      if (leaf.k !== 'chunk') {
        return;
      }
      if (delimiter && leaf.kind === 'item') {
        yield self.expr(delimiter);
        self.emit(where, 'chunk-delete-delimited', leaf.kind);
      } else {
        self.emit(where, 'chunk-delete', leaf.kind);
      }
    };
    const up = (leaf as Expr & { base: Expr }).base;
    const skip = this.label();
    yield this.update(at, up, remove, index, delimiter, skip);
    this.place(skip);
    if (i >= 0) {
      this.release(i);
    }
  }

  *replaceStatement(s: Omit<Replace, 'k'>): Task {
    const at = s.pos;
    const self = this;
    let p = -1;
    yield this.update(
      at,
      s.target,
      function* (old) {
        self.emit(at, 'load', p);
        yield old();
        yield self.replaceLoop(s);
      },
      function* () {
        yield self.expr(s.pat);
        p = self.temp();
        self.emit(at, 'store', p);
      },
      null,
      null,
    );
    this.release(p);
  }

  // With the pattern and the text on the stack.
  *replaceLoop(s: Omit<Replace, 'k'>): Task {
    const at = s.pos;
    this.emit(at, 'replace-start', s.first ? 1 : 0);
    const top = this.label();
    const end = this.label();
    this.place(top);
    this.emit(at, 'replace-next', end);
    const m = this.temp();
    this.emit(at, 'store', m);
    if (s.pat.k === 'pattern') {
      for (const name of capturesOf(s.pat.pattern)) {
        this.emit(at, 'load', m);
        this.emit(at, 'get-key', 'captures');
        this.emit(at, 'get-key', name.text);
        this.store(name, at);
      }
    }
    this.release(m);
    yield this.expr(s.value);
    this.emit(at, 'replace-put');
    this.emit(at, 'jump', top);
    this.place(end);
    this.emit(at, 'replace-end');
  }

  // ------------------------------------------------------------- patterns

  // Tests the value in slot `sub` against a pattern, jumping to `failed`.
  // With `binds`, names bind to temps for `commit`; without, directly.
  *pattern(
    p: Pattern,
    sub: number,
    failed: Label,
    binds: Binds | null,
    fold: boolean,
  ): Task {
    const at = p.pos;
    switch (p.k) {
      case 'bind':
        this.emit(at, 'load', sub);
        return void this.bindName(p.name, at, binds);
      case 'wildcard':
        return;
      case 'as':
        yield this.pattern(p.p, sub, failed, binds, fold);
        this.emit(at, 'load', sub);
        return void this.bindName(p.name, at, binds);
      case 'literal': {
        this.emit(at, 'load', sub);
        const c = this.u.constant(literalDisplay(p.value));
        return void (fold
          ? this.emit(at, 'test-constant', c, 'fold', failed)
          : this.emit(at, 'test-constant', c, failed));
      }
      case 'pin':
        this.emit(at, 'load', sub);
        this.load(p.name, at);
        return void this.emit(at, 'test-equal', failed);
      case 'list': {
        const k = p.items.length;
        this.emit(at, 'load', sub);
        this.emit(at, p.rest ? 'test-list-at-least' : 'test-list', k, failed);
        for (const [i, item] of p.items.entries()) {
          this.emit(at, 'load', sub);
          this.emit(at, 'list-item', i + 1);
          yield this.subPattern(item, failed, binds, fold);
        }
        if (p.rest) {
          this.emit(at, 'load', sub);
          this.emit(at, 'list-rest', k + 1);
          if (p.rest.name) {
            this.bindName(p.rest.name, at, binds);
          } else {
            this.emit(at, 'pop');
          }
        }
        return;
      }
      case 'map':
        this.emit(at, 'load', sub);
        this.emit(at, 'test-map', failed);
        for (const entry of p.entries) {
          this.emit(at, 'load', sub);
          this.emit(at, 'map-get', entry.key, failed);
          yield this.subPattern(entry.value, failed, binds, fold);
        }
        return;
      case 'text':
        this.emit(at, 'load', sub);
        yield this.textPatternValue(p.pattern, at);
        this.emit(at, 'match-whole', ...(fold ? ['fold', failed] : [failed]));
        return void this.captures(p.pattern, at, binds);
      case 'binary':
        return yield* this.binaryPattern(p, sub, failed, binds);
    }
  }

  bindName(name: SemanticName, at: Pos, binds: Binds | null) {
    const binding = name.binding!;
    if (!binds) {
      return void this.emit(at, 'store', this.slots.get(binding)!);
    }
    const t = this.temp();
    binds.set(binding, t);
    this.emit(at, 'store', t);
  }

  // A sub-pattern of the value on the stack: a name binds it straight away,
  // `_` pops it, and anything else goes through a temp.
  *subPattern(
    p: Pattern,
    failed: Label,
    binds: Binds | null,
    fold: boolean,
  ): Task {
    if (p.k === 'bind') {
      return void this.bindName(p.name, p.pos, binds);
    }
    if (p.k === 'wildcard') {
      return void this.emit(p.pos, 'pop');
    }
    const t = this.temp();
    this.emit(p.pos, 'store', t);
    yield this.pattern(p, t, failed, binds, fold);
    this.release(t);
  }

  // The Captures map on the stack: each Capture the literal writes, or `pop`.
  captures(pattern: TextPattern, at: Pos, binds: Binds | null) {
    const names = capturesOf(pattern);
    if (!names.length) {
      return void this.emit(at, 'pop');
    }
    const c = this.temp();
    this.emit(at, 'store', c);
    for (const name of names) {
      this.emit(at, 'load', c);
      this.emit(at, 'get-key', name.text);
      this.bindName(name, at, binds);
    }
    this.release(c);
  }

  *binaryPattern(
    p: Pattern & { k: 'binary' },
    sub: number,
    failed: Label,
    binds: Binds | null,
  ): Task {
    this.emit(p.pos, 'load', sub);
    this.emit(p.pos, 'bin-start', failed);
    const { fields } = p;
    const bind = (field: BinaryField & { k: 'field' }) => {
      if (field.name) {
        this.bindName(field.name, field.pos, binds);
        // A later size reads the name from its temp (chapter 8).
        if (binds) {
          this.overrides.set(
            field.name.binding!,
            binds.get(field.name.binding!)!,
          );
        }
      } else {
        this.emit(field.pos, 'pop');
      }
    };
    const saved = new Map(this.overrides);
    try {
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i]!;
        const at = field.pos;
        if (field.k === 'literal') {
          this.emit(
            at,
            'bin-literal',
            this.u.constant(literalDisplay(field.value)),
            failed,
          );
        } else if (field.k === 'rest') {
          this.emit(
            at,
            'bin-rest',
            field.asText ? 'bytes as text' : 'bytes',
            failed,
          );
          if (field.name) {
            this.bindName(field.name, at, binds);
          } else {
            this.emit(at, 'pop');
          }
          return;
        } else if (field.type.k === 'int') {
          this.emit(at, 'bin-int', fieldText(field.type), failed);
          bind(field);
        } else if (field.type.unit === 'bits') {
          const run: (BinaryField & { k: 'field' })[] = [];
          while (i < fields.length) {
            const next = fields[i]!;
            if (next.k !== 'field' || !isBits(next.type)) {
              break;
            }
            run.push(next);
            i++;
          }
          i--;
          this.emit(
            at,
            'bin-bits',
            this.u.constant(
              this.widths(
                run.map(r => r.type),
                at,
              ),
            ),
            run.length,
            failed,
          );
          for (const r of [...run].reverse()) {
            bind(r);
          }
        } else {
          const { size } = field.type;
          if (size.k === 'pin') {
            const inner = new Map(this.overrides);
            this.overrides = saved;
            this.load(size.name, at);
            this.overrides = inner;
          } else if (size.k === 'number') {
            this.constant(at, numberText(size.text));
          } else if (size.k === 'name') {
            this.load(size.name, at);
          } else {
            yield this.expr(size.e);
          }
          this.emit(at, 'bin-bytes', fieldText(field.type), failed);
          bind(field);
        }
      }
      this.emit(p.pos, 'bin-end', failed);
    } finally {
      this.overrides = saved;
    }
  }

  widths(types: (FieldType | null)[], at: Pos): string {
    return `[${types
      .map(type => {
        if (type?.k !== 'sized' || type.size.k !== 'number') {
          return this.unsupported(
            at,
            'a bit field whose size is not an integer literal',
          );
        }
        return numberText(type.size.text);
      })
      .join(', ')}]`;
  }

  // ------------------------------------------------------------- expressions

  *expr(e: Expr): Task {
    const at = e.pos;
    switch (e.k) {
      case 'number':
        return void this.constant(at, numberText(e.text));
      case 'quantity':
        return void this.constant(
          at,
          quantityText(numberText(e.number), e.unit),
        );
      case 'text':
        return void this.constant(at, textDisplay(e.value));
      case 'literal':
        return void this.constant(at, e.value);
      case 'me':
        return void this.emit(at, 'me');
      case 'target':
        return void this.emit(at, 'target');
      case 'name':
      case 'pin':
        return void this.load(e.name, at);
      case 'binary':
        yield this.expr(e.l);
        yield this.expr(e.r);
        return void (e.fold
          ? this.emit(at, e.op, 'fold')
          : this.emit(at, e.op));
      case 'member':
        yield this.expr(e.l);
        yield this.expr(e.r);
        if (e.fold) {
          this.emit(at, 'member', 'fold');
        } else {
          this.emit(at, 'member');
        }
        return void (e.neg && this.emit(at, 'not'));
      case 'is-kind':
      case 'is-empty':
        yield this.expr(e.l);
        if (e.k === 'is-kind') {
          this.emit(at, 'is-kind', e.kind);
        } else {
          this.emit(at, 'is-empty');
        }
        return void (e.neg && this.emit(at, 'not'));
      case 'convert':
      case 'can-convert':
        yield this.expr(e.e);
        return void this.emit(at, e.k, e.kind);
      case 'not':
      case 'negate':
        yield this.expr(e.e);
        return void this.emit(at, e.k);
      case 'and':
      case 'or': {
        const short = this.label();
        const end = this.label();
        yield this.expr(e.l);
        this.emit(at, e.k === 'and' ? 'branch-false' : 'branch-true', short);
        yield this.expr(e.r);
        this.emit(at, 'check-boolean');
        this.emit(at, 'jump', end);
        this.place(short);
        this.constant(at, e.k === 'and' ? 'false' : 'true');
        return void this.place(end);
      }
      case 'key':
        yield this.expr(e.base);
        return void this.emit(at, 'get-key', e.key);
      case 'computed':
        yield this.expr(e.key);
        yield this.expr(e.base);
        return void this.emit(at, 'get-key-computed');
      case 'property':
        yield this.expr(e.base);
        if (e.delimiter) {
          yield this.expr(e.delimiter);
          return void this.emit(at, 'property-delimited', e.name);
        }
        return void this.emit(at, 'property', e.name);
      case 'chunk':
        return yield* this.chunkRead(e);
      case 'list':
        if (!e.items.some(item => item.spread)) {
          for (const item of e.items) {
            yield this.expr(item.e);
          }
          return void this.emit(at, 'list', e.items.length);
        }
        this.emit(at, 'list', 0);
        for (const item of e.items) {
          yield this.expr(item.e);
          this.emit(at, item.spread ? 'list-extend' : 'list-append');
        }
        return;
      case 'map': {
        for (const entry of e.entries) {
          yield this.expr(entry.value);
        }
        const keys = `[${e.entries.map(entry => textDisplay(entry.key)).join(', ')}]`;
        return void this.emit(
          at,
          'map',
          this.u.constant(keys),
          e.entries.length,
        );
      }
      case 'pattern':
        return yield* this.textPatternValue(e.pattern, at);
      case 'build':
        return yield* this.build(e.fields, at);
      case 'match-all':
        yield this.expr(e.pat);
        yield this.expr(e.src);
        return void this.emit(at, 'match-all');
      case 'replace':
        yield this.expr(e.pat);
        yield this.expr(e.target);
        return yield* this.replaceLoop(e);
      case 'call':
        return yield* this.call(e, false);
      case 'lambda':
        return yield* this.makeLambda(e);
    }
  }

  // A Text Pattern as a value: a constant, or its template and its splices.
  *textPatternValue(pattern: TextPattern, at: Pos): Task {
    const splices = splicesOf(pattern);
    const source = patternSource(pattern);
    const index = this.u.constant(source);
    this.u.patterns.set(index, pattern.els);
    if (!splices.length) {
      return void this.emit(at, 'const', index);
    }
    for (const splice of splices) {
      yield this.expr(splice);
    }
    this.emit(at, 'make-pattern', index, splices.length);
  }

  *chunkRead(e: Expr & { k: 'chunk' }): Task {
    // The chain, outermost level first, down to the value it reads from.
    const levels: (Expr & { k: 'chunk' })[] = [];
    let base: Expr = e;
    while (base.k === 'chunk' && (base === e || base.delimiter === null)) {
      levels.push(base);
      base = base.base;
    }
    for (const level of levels) {
      if (typeof level.index === 'number') {
        this.constant(level.pos, String(level.index));
      } else {
        yield this.expr(level.index);
      }
    }
    yield this.expr(base);
    let d: number | null = null;
    if (e.delimiter) {
      yield this.expr(e.delimiter);
      d = this.temp();
      this.emit(e.pos, 'store', d);
    }
    for (const level of [...levels].reverse()) {
      if (d !== null && level.kind === 'item') {
        this.emit(level.pos, 'load', d);
        this.emit(level.pos, 'chunk-get-delimited', level.kind);
      } else {
        this.emit(level.pos, 'chunk-get', level.kind);
      }
    }
    if (d !== null) {
      this.release(d);
    }
  }

  *build(fields: BuildField[], at: Pos): Task {
    this.constant(at, '<<>>');
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      if (isBits(field.type)) {
        const run: BuildField[] = [];
        while (i < fields.length && isBits(fields[i]!.type)) {
          run.push(fields[i++]!);
        }
        i--;
        for (const r of run) {
          yield this.expr(r.value);
        }
        this.emit(
          field.pos,
          'bytes-bits',
          this.u.constant(
            this.widths(
              run.map(r => r.type),
              field.pos,
            ),
          ),
          run.length,
        );
        continue;
      }
      yield this.expr(field.value);
      if (field.type?.k === 'sized') {
        // `v as n bytes`: the size, as in a Binary Pattern, then `bytes-sized`.
        const { size } = field.type;
        if (size.k === 'number') {
          this.constant(field.pos, numberText(size.text));
        } else if (size.k === 'pin' || size.k === 'name') {
          this.load(size.name, field.pos);
        } else {
          yield this.expr(size.e);
        }
        this.emit(field.pos, 'bytes-sized', fieldText(field.type));
        continue;
      }
      this.emit(field.pos, 'bytes-field', fieldText(field.type));
    }
  }

  *call(e: Expr & { k: 'call' }, wait: boolean): Task {
    const at = e.pos;
    const binding = e.name.binding!;
    const args = function* (self: BodyLowering): Task {
      for (const arg of e.args) {
        yield self.expr(arg);
      }
    };
    const n = e.args.length;
    switch (binding.kind) {
      case 'builtin function':
        yield args(this);
        return void this.emit(at, 'call-builtin', binding.name, n);
      case 'function':
        yield args(this);
        return void (binding.importedFrom
          ? this.emit(at, 'call-import', importName(binding), n)
          : this.emit(at, 'call', this.u.functionOf.get(binding)!, n));
      case 'handler':
        yield args(this);
        return void this.emit(
          at,
          'call-handler',
          binding.importedFrom ? importName(binding) : binding.name,
          n,
        );
    }
    this.load(e.name, at);
    yield args(this);
    this.emit(at, wait ? 'call-value-wait' : 'call-value', n);
  }

  *makeLambda(e: Lambda): Task {
    const body = this.u.newBody(
      'lambda',
      `${this.body.name}:${e.pos.line}:${e.pos.col}`,
    );
    body.params = e.params.map(p => (p.k === 'bind' ? p.name.text : '…'));
    const inner = new BodyLowering(this.u, body, e.scope);
    yield inner.lambda(e);
    for (const binding of this.u.scopes[e.scope]!.captures) {
      this.emit(e.pos, 'load', this.slotOf(binding)!);
    }
    this.emit(e.pos, 'make-closure', body.index, body.captures);
  }
}

// The names an event's patterns and Guard read, in source order.
const eventReads = (event: Event, guard: Guard | null): SemanticName[] => {
  const out: { name: SemanticName; start: number }[] = [];
  const work: unknown[] = [event.pats, guard];
  while (work.length) {
    const x = work.pop();
    if (!x || typeof x !== 'object') {
      continue;
    }
    if (Array.isArray(x)) {
      work.push(...x);
      continue;
    }
    const node = x as { k?: string; kind?: string; name?: SemanticName };
    if (node.kind === 'name') {
      const name = node as unknown as SemanticName;
      if (name.role === 'value' || name.role === 'binary size') {
        out.push({ name, start: name.span.start });
      }
      continue;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        work.push(value);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start).map(entry => entry.name);
};

export type CompileOptions = CheckOptions & {
  /** The Script's or Library's name, which the disassembly's `unit` line shows. */
  name: string;
};
export type CompileResult =
  | { diagnostics: readonly Diagnostic[]; error: null; unit: CodeUnit }
  | {
      diagnostics: readonly Diagnostic[];
      error: ParseError | null;
      unit: null;
    };

/** A checked Library's exports, for the Scripts and Libraries that import it. */
export const exportsOf = (
  tree: SemanticTree,
): Record<string, Exclude<LibraryExport, string>> => {
  const out: Record<string, Exclude<LibraryExport, string>> = {};
  for (const decl of viewSource(tree.root)) {
    if (
      (decl.k !== 'function' &&
        decl.k !== 'handler' &&
        decl.k !== 'constant') ||
      decl.private
    ) {
      continue;
    }
    if (decl.k === 'function') {
      out[decl.name] = {
        kind: 'function',
        contract: {
          required: decl.params.filter(param => !param.default).length,
          total: decl.params.length,
        },
      };
    } else {
      out[decl.k === 'handler' ? decl.name : decl.name.text] =
        decl.k === 'handler'
          ? {
              kind: decl.k,
              maySuspend: tree.maySuspend?.includes(decl.name) ?? false,
            }
          : { kind: decl.k };
    }
  }
  return out;
};

/**
 * The Libraries a unit's `use` lines name, each once, in the order of the
 * first line that names it.
 */
export const importsOf = (tree: SemanticTree): string[] => [
  ...new Set(
    viewSource(tree.root).flatMap(decl =>
      decl.k === 'use' ? [decl.library] : [],
    ),
  ),
];

/** Lower a checked semantic tree into its code unit. */
export const lowerTree = (
  tree: SemanticTree,
  options: Pick<CompileOptions, 'name' | 'unit'> & {
    existingVariables?: readonly string[];
  },
): CodeUnit => {
  const unit = new UnitLowering(
    options.name,
    options.unit ?? 'script',
    tree.scopes,
    options.existingVariables,
  );
  runTask(unit.lower(viewSource(tree.root)));
  return unit.finish();
};

/**
 * Parse, check and lower a Script or Library. The first syntax error, or any
 * load diagnostic the checker reports, leaves no code unit.
 */
export const compileSource = (
  source: string,
  options: CompileOptions,
): CompileResult => {
  const checked = checkSource(source, options);
  if (checked.error || !checked.ok) {
    return {
      error: checked.error,
      diagnostics: checked.diagnostics,
      unit: null,
    };
  }
  return {
    error: null,
    diagnostics: checked.diagnostics,
    unit: lowerTree(checked.tree, options),
  };
};
