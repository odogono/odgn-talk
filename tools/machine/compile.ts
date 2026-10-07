// A prototype of chapter 8's lowering. Not normative (ADR 0028): it exists to
// check that the lowering tables cover the whole language and agree with the
// instruction set in spec/data/machine.toml, and to print the canonical
// disassembly for Disassembly Cases.
//
// It compiles the parse tree of tools/grammar/parser.ts into one code unit:
// a constant pool, a body table, one instruction array, an Unwind Table and
// an event table, laid out as chapter 8 says.

import stdlib from '../../spec/data/stdlib.toml';
import { parse, type Node } from '../grammar/parser';

export type Arg = number | string;
export type Instr = {
  args: Arg[];
  col: number;
  line: number;
  notes: string[]; // shown after `;` in the disassembly
  op: string;
};
export type Body = {
  captures: number;
  clause?: number;
  defaults: (number | null)[]; // a definition index per parameter, for a function
  end: number;
  index: number;
  kind: 'init' | 'handler' | 'function' | 'lambda' | 'event';
  locals: string[];
  maySuspend: boolean;
  name: string;
  params: string[]; // shown in the body table
  start: number;
};
export type Unwind = {
  depth: number;
  from: number;
  kind: 'catch' | 'finally' | 'guard' | 'offer';
  target: number;
  to: number;
};
export type OfferEntry = {
  body: number;
  depth: number;
  end: number;
  offers: { binds: number[]; name: string; target: number }[];
};
export type EventEntry = {
  branches: {
    binds: number[];
    body: number | null;
    captures: number;
    from: boolean;
    kind: 'when' | 'after';
    message?: string;
  }[];
  index: number;
  timeout: boolean;
};
export type Unit = {
  bodies: Body[];
  code: Instr[];
  constants: string[];
  definitions: string[];
  events: EventEntry[];
  kind: 'script' | 'library';
  name: string;
  objects: string[];
  offers?: OfferEntry[];
  unwind: Unwind[];
  variables: string[];
};

export class CompileError extends Error {
  constructor(
    public line: number,
    public col: number,
    msg: string,
  ) {
    super(msg);
  }
}

const BUILTIN_FUNCTIONS = new Set<string>();
const BUILTIN_CONSTANTS = new Map<string, string>();
for (const b of stdlib.builtin as any[]) {
  if (b.group === 'constants') {
    BUILTIN_CONSTANTS.set(b.name, b.name);
  } else {
    BUILTIN_FUNCTIONS.add(b.name);
  }
}
const ORDINAL_INDEX: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  last: -1,
};
const BINARY: Record<string, string> = {
  '+': 'add',
  '-': 'subtract',
  '*': 'multiply',
  '/': 'divide',
  div: 'div',
  mod: 'mod',
  '^': 'power',
  '&': 'concat',
  '..': 'range',
  '=': 'equal',
  '<>': 'not-equal',
  '<': 'less',
  '>': 'greater',
  '<=': 'less-or-equal',
  '>=': 'greater-or-equal',
  contains: 'contains',
  matches: 'matches',
  'begins with': 'begins-with',
  'ends with': 'ends-with',
};
const FOLDING = new Set([
  'equal',
  'not-equal',
  'less',
  'greater',
  'less-or-equal',
  'greater-or-equal',
  'member',
  'contains',
  'matches',
  'begins-with',
  'ends-with',
]);
const SINGULAR: Record<string, string> = {
  characters: 'character',
  words: 'word',
  lines: 'line',
  items: 'item',
  bytes: 'byte',
  'code points': 'code point',
};

// ---------------------------------------------------------------------------
// The display of constants in the disassembly
// ---------------------------------------------------------------------------

const textConstant = (v: string) => `"${v}"`;

const numberConstant = (v: string) =>
  v.startsWith('0x') ? BigInt(v).toString() : v;

// A Text Pattern's source, with each splice written `(n)` by its position.
const patternSource = (n: Node, splices: { n: number }): string => {
  const el = (e: Node): string => {
    switch (e.k) {
      case 'Text':
        return textConstant(e.v);
      case 'Count':
        return `${e.n} ${el(e.e)}`;
      case 'Group':
        return `<${e.els.map(el).join(', ')}>`;
      case 'Splice':
        return `(${++splices.n})`;
      case 'Capture':
        return `${e.name}: ${el(e.e)}`;
      case 'Anchor':
      case 'Class':
      case 'Keyword':
        return e.v;
      case 'one or more of':
      case 'zero or more of':
        return `${e.k} ${el(e.e)}`;
      case 'optional':
        return `optional ${el(e.e)}`;
      case 'Typed':
        return `a ${e.kind}`;
      case 'or':
        return `${el(e.l)} or ${el(e.r)}`;
      case 'as':
        return `${el(e.e)} as ${e.type}`;
      case 'lazily':
        return `${el(e.e)} lazily`;
      case 'ignoring case':
        return `${el(e.e)} ignoring case`;
    }
    throw new Error(`pattern element ${e.k}`);
  };
  return `<${n.els.map(el).join(', ')}>`;
};

const splicesOf = (n: Node): Node[] => {
  const out: Node[] = [];
  const walk = (e: any) => {
    if (!e || typeof e !== 'object') {
      return;
    }
    if (Array.isArray(e)) {
      return e.forEach(walk);
    }
    if (e.k === 'Splice') {
      return void out.push(e.e);
    }
    for (const [k, v] of Object.entries(e)) {
      if (k !== 'k') {
        walk(v);
      }
    }
  };
  walk(n.els);
  return out;
};

const capturesOf = (n: Node): string[] => {
  const out: string[] = [];
  const walk = (e: any) => {
    if (!e || typeof e !== 'object') {
      return;
    }
    if (Array.isArray(e)) {
      return e.forEach(walk);
    }
    if (e.k === 'Splice') {
      return;
    }
    if (e.k === 'Capture') {
      out.push(e.name);
    }
    for (const [k, v] of Object.entries(e)) {
      if (k !== 'k') {
        walk(v);
      }
    }
  };
  walk(n.els);
  return out;
};

// The names a pattern binds, left to right.
const patternNames = (p: Node | null): string[] => {
  if (!p) {
    return [];
  }
  switch (p.k) {
    case 'Bind':
      return [p.name];
    case 'BindAs':
      return [...patternNames(p.p), p.name];
    case 'ListPattern':
      return p.items.flatMap((i: Node) =>
        i.k === 'Rest' ? (i.name ? [i.name] : []) : patternNames(i),
      );
    case 'MapPattern':
      return p.entries.flatMap((e: Node) => patternNames(e.value));
    case 'TextPattern':
      return capturesOf(p);
    case 'BinaryPattern':
      return p.fields.flatMap((f: Node) =>
        f.name && f.name !== '_' ? [f.name] : [],
      );
  }
  return [];
};

const fieldType = (t: Node | null): string => {
  if (!t) {
    return 'value';
  }
  if (t.k === 'Int') {
    return t.order ? `${t.type} ${t.order}` : t.type;
  }
  const unit = t.unit === 'byte' ? 'bytes' : t.unit === 'bit' ? 'bits' : t.unit;
  return t.asText ? `${unit} as text` : unit;
};

// ---------------------------------------------------------------------------
// A code unit
// ---------------------------------------------------------------------------

type Import = {
  library: string;
  name: string; // the name in the Library
  what: 'function' | 'handler' | 'constant';
};

export type Options = {
  // A name that resolves to nothing is a well-known object, not an error.
  lenient?: boolean;
  // Names a Library imports resolve against these sources, so the compiler
  // knows which are functions, Handlers or Constants.
  libraries?: Map<string, Node[]>;
};

export class UnitCompiler {
  unit: Unit;
  private constIndex = new Map<string, number>();
  private objectIndex = new Map<string, number>();
  imports = new Map<string, Import>();
  functions = new Map<string, number>(); // name → body index
  handlers = new Map<string, number[]>(); // name → clause bodies
  definitionIndex = new Map<string, number>(); // own and imported Constants, and defaults
  variableIndex = new Map<string, number>();
  pending: (() => void)[] = [];
  bodyCode = new Map<number, Instr[]>();
  bodyUnwind = new Map<number, Unwind[]>();
  bodyOffers = new Map<
    number,
    {
      body: number;
      depth: number;
      end: Label;
      offers: { binds: number[]; name: string; target: Label }[];
    }[]
  >();
  events: EventEntry[] = [];

  constructor(
    name: string,
    kind: 'script' | 'library',
    public decls: Node[],
    public opts: Options = {},
  ) {
    this.unit = {
      name,
      kind,
      constants: [],
      definitions: [],
      variables: [],
      objects: [],
      bodies: [],
      code: [],
      unwind: [],
      events: this.events,
    };
  }

  constant(display: string): number {
    let i = this.constIndex.get(display);
    if (i === undefined) {
      i = this.unit.constants.length;
      this.unit.constants.push(display);
      this.constIndex.set(display, i);
    }
    return i;
  }

  object(name: string): number {
    let i = this.objectIndex.get(name);
    if (i === undefined) {
      i = this.unit.objects.length;
      this.unit.objects.push(name);
      this.objectIndex.set(name, i);
    }
    return i;
  }

  newBody(
    kind: Body['kind'],
    name: string,
    params: string[],
    clause?: number,
  ): Body {
    const b: Body = {
      index: this.unit.bodies.length,
      kind,
      name,
      clause,
      params,
      defaults: [],
      locals: [],
      start: 0,
      end: 0,
      maySuspend: false,
      captures: 0,
    };
    this.unit.bodies.push(b);
    return b;
  }

  compile(): Unit {
    // The table of names, before any body is compiled.
    for (const d of this.decls) {
      if (d.k === 'Use') {
        const lib = this.opts.libraries?.get(d.library);
        for (const n of d.names) {
          const decl = lib?.find(x => x.name === n && !x.private);
          const what =
            decl?.k === 'Constant'
              ? 'constant'
              : decl?.k === 'Handler'
                ? 'handler'
                : 'function';
          this.imports.set(d.rename ?? n, {
            library: d.library,
            name: n,
            what,
          });
          if (what === 'constant') {
            this.defineDefinition(d.rename ?? n, `${d.library}:${n}`);
          }
        }
      } else if (d.k === 'ScriptVariable') {
        this.variableIndex.set(d.name, this.unit.variables.length);
        this.unit.variables.push(d.name);
      } else if (d.k === 'Constant') {
        this.defineDefinition(d.name, d.name);
      }
    }
    const init = this.newBody('init', 'initialiser', []);
    for (const d of this.decls) {
      if (d.k === 'Function') {
        const b = this.newBody(
          'function',
          d.name,
          d.params.map((p: any) => p.name),
        );
        this.functions.set(d.name, b.index);
      } else if (d.k === 'Handler') {
        const list = this.handlers.get(d.name) ?? [];
        const b = this.newBody('handler', d.name, [], list.length + 1);
        list.push(b.index);
        this.handlers.set(d.name, list);
      }
    }
    // Function defaults are Constants the initialiser computes (ADR 0035).
    for (const d of this.decls) {
      if (d.k !== 'Function') {
        continue;
      }
      const b = this.unit.bodies[this.functions.get(d.name)!]!;
      b.defaults = d.params.map((p: any) =>
        p.default
          ? this.defineDefinition(`${d.name}.${p.name}`, `${d.name}.${p.name}`)
          : null,
      );
    }
    new BodyCompiler(this, init, null).initialiser(this.decls);
    const clauseOf = new Map<string, number>();
    for (const d of this.decls) {
      if (d.k === 'Function') {
        new BodyCompiler(
          this,
          this.unit.bodies[this.functions.get(d.name)!]!,
          null,
        ).func(d);
      } else if (d.k === 'Handler') {
        const n = (clauseOf.get(d.name) ?? 0) + 1;
        clauseOf.set(d.name, n);
        new BodyCompiler(
          this,
          this.unit.bodies[this.handlers.get(d.name)![n - 1]!]!,
          null,
        ).handler(d);
      }
    }
    while (this.pending.length) {
      this.pending.shift()!();
    }
    this.layout();
    return this.unit;
  }

  defineDefinition(key: string, display: string): number {
    let i = this.definitionIndex.get(key);
    if (i === undefined) {
      i = this.unit.definitions.length;
      this.unit.definitions.push(display);
      this.definitionIndex.set(key, i);
    }
    return i;
  }

  // Bodies are laid out in the order they were made, so each one's code is
  // a contiguous range of the unit's instruction array.
  private layout() {
    for (const b of this.unit.bodies) {
      const code = this.bodyCode.get(b.index) ?? [];
      b.start = this.unit.code.length;
      for (const ins of code) {
        this.unit.code.push({
          ...ins,
          args: ins.args.map(a =>
            typeof a === 'object' ? b.start + (a as any).pc : a,
          ),
        });
      }
      b.end = this.unit.code.length;
      const offers = this.unit.offers ?? [];
      const offerBase = offers.length;
      for (const entry of this.bodyOffers.get(b.index) ?? []) {
        offers.push({
          ...entry,
          end: b.start + entry.end.pc!,
          offers: entry.offers.map(o => ({
            ...o,
            target: b.start + o.target.pc!,
          })),
        });
      }
      if (offers.length) {
        this.unit.offers = offers;
      }
      for (const u of this.bodyUnwind.get(b.index) ?? []) {
        this.unit.unwind.push({
          ...u,
          from: b.start + u.from,
          to: b.start + u.to,
          target:
            u.kind === 'offer' ? offerBase + u.target : b.start + u.target,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// A body
// ---------------------------------------------------------------------------

type Label = {
  pc: number | null;
};
type Place =
  | { k: 'local'; slot: number }
  | { k: 'variable'; slot: number }
  | { index: number; k: 'definition' }
  | { body: number; k: 'function' }
  | { imp: Import; k: 'import'; name: string }
  | { k: 'handler'; name: string }
  | { k: 'builtin-constant'; name: string }
  | { k: 'object'; name: string };

type Rec = {
  open: number | null;
  spans: [number, number][];
};

type Loop = {
  exit: Label;
  finallies: number; // the number of `finally` blocks open when the loop began
  top: Label;
};

// The names an expression or block reads, in the order it first names them,
// without looking inside nested Lambdas' own bindings.
const freeNames = (e: any): string[] => {
  const out: string[] = [];
  const walk = (x: any, bound: Set<string>) => {
    if (!x || typeof x !== 'object') {
      return;
    }
    if (Array.isArray(x)) {
      return x.forEach(y => walk(y, bound));
    }
    const add = (n: string) => {
      if (!bound.has(n) && !out.includes(n)) {
        out.push(n);
      }
    };
    if (x.k === 'Lambda' || x.k === 'LambdaBlock') {
      // A nested Lambda's own parameters and locals shadow the names outside.
      const inner = new Set(bound);
      for (const n of x.params.flatMap(patternNames)) {
        inner.add(n);
      }
      if (x.k === 'LambdaBlock') {
        for (const n of boundNames(x.body)) {
          inner.add(n);
        }
      }
      walk(x.body, inner);
      return;
    }
    if (x.k === 'Name' || x.k === 'Pin') {
      add(x.name);
    }
    if (x.k === 'Call') {
      add(x.fn);
    }
    for (const [k, v] of Object.entries(x)) {
      if (k !== 'k') {
        walk(v, bound);
      }
    }
  };
  walk(e, new Set());
  return out;
};

// The names a block binds, as `prescan` finds them.
const boundNames = (stmts: Node[]): string[] => {
  const unit = { variableIndex: new Map() } as unknown as UnitCompiler;
  const bc = new BodyCompiler(
    unit,
    {
      index: -1,
      kind: 'lambda',
      name: '',
      params: [],
      defaults: [],
      locals: [],
      start: 0,
      end: 0,
      maySuspend: false,
      captures: 0,
    },
    null,
  );
  bc.prescan(stmts);
  return bc.locals.slice(1);
};

export class BodyCompiler {
  code: Instr[] = [];
  unwind: Unwind[] = [];
  offers: {
    body: number;
    depth: number;
    end: Label;
    offers: { binds: number[]; name: string; target: Label }[];
  }[] = [];
  names = new Map<string, number>(); // local name → slot
  locals: string[] = ['it'];
  free: number[] = []; // released temp slots
  loops: Loop[] = [];
  finallies: Node[][] = [];
  // The open `try`s, outermost first: the spans their catch and finally
  // entries protect, and the index of their `finally` in `finallies`.
  tries: {
    catchRec: Rec | null;
    finally: number | null;
    finRec: Rec | null;
    offerRec: Rec | null;
  }[] = [];
  // For each `finally` block being lowered, the loop depth where it began.
  inFinally: number[] = [];
  join = 0;
  iterators = 0; // loop iterators on the operand stack: the static depth
  line = 1;
  col = 1;
  capturedFrom: BodyCompiler | null;
  captureSlots: { name: string; outer: Place }[] = [];

  constructor(
    public u: UnitCompiler,
    public body: Body,
    public parent: BodyCompiler | null,
  ) {
    this.capturedFrom = parent;
  }

  // ------------------------------------------------------------- emission

  at(n: any) {
    if (n && n.line !== undefined) {
      this.line = n.line;
      this.col = n.col;
    }
  }

  // Lowers `f` at a construct's position, and restores the position after,
  // so the construct around it keeps its own (the source map, chapter 8).
  pos<T>(n: any, f: () => T): T {
    const [line, col] = [this.line, this.col];
    this.at(n);
    try {
      return f();
    } finally {
      this.line = line;
      this.col = col;
    }
  }

  emit(op: string, args: (Arg | Label)[] = [], notes: string[] = []): number {
    this.code.push({
      op,
      args: args as Arg[],
      notes,
      line: this.line,
      col: this.col,
    });
    if (
      [
        'ask-wait',
        'send-wait',
        'send-named-wait',
        'send-up-wait',
        'call-handler-wait',
        'wait',
        'wait-for',
        'wait-for-any',
        'join-end',
        'call-value-wait',
      ].includes(op)
    ) {
      this.body.maySuspend = true;
    }
    return this.code.length - 1;
  }

  label(): Label {
    return { pc: null };
  }

  place(l: Label) {
    l.pc = this.code.length;
  }

  finish() {
    for (const u of this.unwind as any[]) {
      if (u.label) {
        u.target = u.label.pc;
        delete u.label;
      }
    }
    for (const ins of this.code) {
      for (const a of ins.args) {
        if (typeof a === 'object' && (a as Label).pc === null) {
          throw new Error(`an unplaced label in ${this.body.name}`);
        }
      }
    }
    this.body.locals = this.locals;
    this.u.bodyCode.set(this.body.index, this.code);
    this.u.bodyUnwind.set(this.body.index, this.unwind);
    this.u.bodyOffers.set(this.body.index, this.offers);
  }

  fail(n: any, msg: string): never {
    throw new CompileError(n?.line ?? this.line, n?.col ?? this.col, msg);
  }

  // ------------------------------------------------------------- slots

  declare(name: string): number {
    let s = this.names.get(name);
    if (s === undefined) {
      s = this.locals.length;
      this.locals.push(name);
      this.names.set(name, s);
    }
    return s;
  }

  // A temp slot: the lowest one released, or a new one.
  temp(): number {
    if (this.free.length) {
      this.free.sort((a, b) => a - b);
      return this.free.shift()!;
    }
    this.locals.push(`(${this.locals.length})`);
    return this.locals.length - 1;
  }

  release(...slots: number[]) {
    this.free.push(...slots);
  }

  // The locals a body binds, in the order they are first bound in the source
  // (chapter 8): each binding site is a name's position, and the sites are
  // taken in source order.
  prescan(stmts: Node[]) {
    const sites: { col: number; line: number; name: string }[] = [];
    const site = (name: string, n: any) => {
      if (!this.u.variableIndex.has(name)) {
        sites.push({ name, line: n?.line ?? 0, col: n?.col ?? 0 });
      }
    };
    const rootNode = (c: Node): Node | null => {
      let r: any = c;
      while (r && r.k !== 'Name') {
        r = r.of ?? r.base;
      }
      return r ?? null;
    };
    const patSites = (p: Node | null) => {
      const walk = (x: any) => {
        if (!x || typeof x !== 'object') {
          return;
        }
        if (Array.isArray(x)) {
          return x.forEach(walk);
        }
        if (x.k === 'Splice' || x.k === 'Lambda' || x.k === 'LambdaBlock') {
          return;
        }
        if (x.k === 'Bind' || x.k === 'Capture') {
          site(x.name, x);
        } else if (x.k === 'BindAs') {
          walk(x.p);
          site(x.name, x);
          return;
        } else if (x.k === 'Rest' && x.name) {
          site(x.name, x);
        } else if (x.k === 'Field' && x.name && x.name !== '_') {
          site(x.name, x);
        }
        for (const [k, v] of Object.entries(x)) {
          if (k !== 'k') {
            walk(v);
          }
        }
      };
      walk(p);
    };
    const exprSites = (e: any) => {
      if (!e || typeof e !== 'object') {
        return;
      }
      if (Array.isArray(e)) {
        return e.forEach(exprSites);
      }
      if (e.k === 'Lambda' || e.k === 'LambdaBlock') {
        return;
      }
      if (e.k === 'Replace' && e.pat?.k === 'TextPattern') {
        patSites(e.pat);
      }
      for (const [k, v] of Object.entries(e)) {
        if (k !== 'k') {
          exprSites(v);
        }
      }
    };
    const walk = (s: Node) => {
      exprSites(s);
      switch (s.k) {
        case 'Put':
        case 'add':
        case 'subtract':
        case 'multiply':
        case 'divide':
        case 'Delete':
        case 'ReplaceStatement': {
          if (s.k === 'ReplaceStatement' && s.pat.k === 'TextPattern') {
            patSites(s.pat);
          }
          const r = rootNode(s.target);
          if (r) {
            site(r.name, r);
          }
          return;
        }
        case 'Let':
          patSites(s.pat);
          return;
        case 'If':
          s.then.forEach(walk);
          for (const e of s.elses ?? []) {
            e.body.forEach(walk);
          }
          (s.else ?? []).forEach(walk);
          return;
        case 'Repeat':
          if (s.collect) {
            site(s.collect.into, s.collect);
          }
          if (s.head.k === 'ForEach') {
            patSites(s.head.pat);
          }
          s.body.forEach(walk);
          return;
        case 'Match':
          for (const b of s.branches) {
            if (b.k === 'When') {
              patSites(b.pat);
            }
            b.body.forEach(walk);
          }
          return;
        case 'ChooseOffer':
          return;
        case 'Try':
          s.body.forEach(walk);
          for (const offer of s.offers ?? []) {
            for (const name of offer.params) {
              site(name, offer);
            }
            offer.body.forEach(walk);
          }
          for (const c of s.catches) {
            patSites(c.pat);
            c.body.forEach(walk);
          }
          (s.finally ?? []).forEach(walk);
          return;
        case 'WaitFor':
          patSites(s.pats);
          return;
        case 'WaitForBlock':
          for (const b of s.branches) {
            if (b.k === 'WhenEvent') {
              patSites(b.pats);
            }
            b.body.forEach(walk);
          }
          return;
        case 'Join':
          s.body.forEach(walk);
          return;
      }
    };
    stmts.forEach(walk);
    sites.sort((a, b) => a.line - b.line || a.col - b.col);
    for (const x of sites) {
      this.declare(x.name);
    }
  }

  // ------------------------------------------------------------- names

  // Like `resolve`, but a Built-in function or an unknown name gives null.
  tryResolve(name: string): Place | null {
    const lenient = this.u.opts.lenient;
    this.u.opts.lenient = false;
    try {
      return this.resolve(name, null);
    } catch (error) {
      if (error instanceof CompileError) {
        return null;
      }
      throw error;
    } finally {
      this.u.opts.lenient = lenient;
    }
  }

  resolve(name: string, n: any): Place {
    const s = this.names.get(name);
    if (s !== undefined) {
      return { k: 'local', slot: s };
    }
    const cap = this.captureSlots.find(c => c.name === name);
    if (cap) {
      return { k: 'local', slot: this.names.get(name)! };
    }
    if (this.parent) {
      const outer = this.parent.resolve(name, n);
      if (outer.k === 'local') {
        const slot = this.declare(name);
        this.captureSlots.push({ name, outer });
        this.body.captures = this.captureSlots.length;
        return { k: 'local', slot };
      }
      return outer;
    }
    const v = this.u.variableIndex.get(name);
    if (v !== undefined) {
      return { k: 'variable', slot: v };
    }
    const d = this.u.definitionIndex.get(name);
    if (d !== undefined) {
      return { k: 'definition', index: d };
    }
    const f = this.u.functions.get(name);
    if (f !== undefined) {
      return { k: 'function', body: f };
    }
    if (this.u.handlers.has(name)) {
      return { k: 'handler', name };
    }
    const imp = this.u.imports.get(name);
    if (imp) {
      return imp.what === 'handler'
        ? { k: 'handler', name }
        : { k: 'import', imp, name };
    }
    if (BUILTIN_CONSTANTS.has(name)) {
      return { k: 'builtin-constant', name };
    }
    if (this.u.opts.lenient) {
      return { k: 'object', name };
    }
    this.fail(
      n,
      `\`${name}\` isn't a local, Script Variable, Constant, function or Import`,
    );
  }

  load(name: string, n: any) {
    const p = this.resolve(name, n);
    switch (p.k) {
      case 'local':
        return this.emit('load', [p.slot], [name]);
      case 'variable':
        return this.emit('load-var', [p.slot], [name]);
      case 'definition':
        return this.emit(
          'load-definition',
          [p.index],
          [this.u.unit.definitions[p.index]!],
        );
      case 'function':
        return this.emit('make-function', [p.body], [name]);
      case 'import':
        if (p.imp.what === 'constant') {
          return this.emit(
            'load-definition',
            [this.u.definitionIndex.get(p.name)!],
            [`${p.imp.library}:${p.imp.name}`],
          );
        }
        return this.emit('make-imported-function', [
          `${p.imp.library}:${p.imp.name}`,
        ]);
      case 'builtin-constant':
        return this.emit('const', [this.u.constant(p.name)], [p.name]);
      case 'object':
        return this.emit('load-object', [this.u.object(p.name)], [p.name]);
      case 'handler':
        this.fail(n, `the Handler \`${name}\` isn't a value`);
    }
  }

  store(name: string, n: any) {
    const p = this.resolve(name, n);
    if (p.k === 'local') {
      return this.emit('store', [p.slot], [name]);
    }
    if (p.k === 'variable') {
      return this.emit('store-var', [p.slot], [name]);
    }
    this.fail(n, `\`${name}\` can't be put into`);
  }

  constant(display: string) {
    return this.emit('const', [this.u.constant(display)], [display]);
  }

  // ------------------------------------------------------------- bodies

  initialiser(decls: Node[]) {
    for (const d of decls) {
      if (d.k === 'ScriptVariable' && d.init) {
        this.at(d.init);
        this.expr(d.init);
        this.emit('store-var', [this.u.variableIndex.get(d.name)!], [d.name]);
      } else if (d.k === 'Constant') {
        this.at(d.value);
        this.expr(d.value);
        const i = this.u.definitionIndex.get(d.name)!;
        this.emit('store-definition', [i], [d.name]);
      } else if (d.k === 'Function') {
        for (const p of d.params) {
          if (!p.default) {
            continue;
          }
          this.at(p.default);
          this.expr(p.default);
          const i = this.u.definitionIndex.get(`${d.name}.${p.name}`)!;
          this.emit('store-definition', [i], [`${d.name}.${p.name}`]);
        }
      }
    }
    this.line = 1;
    this.col = 1;
    this.returnNothing();
    this.finish();
  }

  func(d: Node) {
    for (const p of d.params) {
      this.declare(p.name);
    }
    this.prescan(d.body);
    this.block(d.body);
    this.at(d.end);
    this.returnNothing();
    this.finish();
  }

  handler(d: Node) {
    // Each parameter arrives in slots 1 to n. A name is its own slot, and any
    // other pattern tests the argument's slot and binds its names directly,
    // since a clause's frame is fresh (chapter 8).
    const argSlots = d.params.map((p: Node) =>
      p.k === 'Bind'
        ? this.declare(p.name)
        : this.declare(`(argument ${this.locals.length})`),
    );
    this.body.params = d.params.map((p: Node) =>
      p.k === 'Bind' ? p.name : '…',
    );
    d.params
      .filter((p: Node) => p.k !== 'Bind')
      .flatMap(patternNames)
      .forEach((n: string) => this.declare(n));
    this.prescan(d.body);
    const failed = this.label();
    this.params(d.params, argSlots, d.guard, failed, true);
    if (d.finally) {
      this.tryBlock({
        k: 'Try',
        body: d.body,
        catches: [],
        finally: d.finally,
      });
    } else {
      this.block(d.body);
    }
    this.at(d.end);
    this.returnNothing();
    this.place(failed);
    this.emit('clause-fail');
    this.finish();
  }

  // Parameter patterns and a Guard, with direct bindings, failing to `failed`.
  // In a clause or an event test, an error while testing skips it, so the
  // whole prologue is a guard region (chapter 8).
  params(
    pats: Node[],
    slots: number[],
    guard: Node | null,
    failed: Label,
    guarded: boolean,
  ) {
    const test = () => {
      pats.forEach((p, i) => {
        if (p.k !== 'Bind') {
          this.pattern(p, slots[i]!, failed, null);
        }
      });
      if (guard) {
        this.guard(guard, failed);
      }
    };
    if (guarded) {
      this.guarded(failed, test);
    } else {
      test();
    }
  }

  guard(g: Node, failed: Label) {
    this.pos(g, () => {
      this.expr(g);
      this.emit('branch-false', [failed]);
    });
  }

  // Code in which any error goes to `failed`: a `guard` entry.
  guarded(failed: Label, f: () => void) {
    const from = this.code.length;
    f();
    if (this.code.length > from) {
      this.unwind.push({
        from,
        to: this.code.length,
        kind: 'guard',
        target: -1,
        depth: this.iterators,
        label: failed,
      } as any);
    }
  }

  returnNothing() {
    this.constant('nothing');
    this.emit('return');
  }

  // A Lambda's body, compiled when the Lambda is.
  lambda(n: Node) {
    const argSlots = n.params.map((p: Node) =>
      p.k === 'Bind'
        ? this.declare(p.name)
        : this.declare(`(argument ${this.locals.length})`),
    );
    this.body.params = n.params.map((p: Node) =>
      p.k === 'Bind' ? p.name : '…',
    );
    n.params
      .filter((p: Node) => p.k !== 'Bind')
      .flatMap(patternNames)
      .forEach((x: string) => this.declare(x));
    const failed = this.label();
    const hasPatterns = n.params.some((p: Node) => p.k !== 'Bind');
    // Its captures come straight after its parameters, in the order the
    // Lambda first names them (chapter 8).
    const own = new Set<string>(n.params.flatMap(patternNames));
    const inner = new BodyCompiler(this.u, this.body, null);
    if (n.k === 'LambdaBlock') {
      inner.prescan(n.body);
    }
    for (const name of inner.locals.slice(1)) {
      own.add(name);
    }
    for (const name of freeNames(n.k === 'Lambda' ? [n.body] : n.body)) {
      if (own.has(name) || this.names.has(name)) {
        continue;
      }
      const outer = this.parent!.tryResolve(name);
      if (outer?.k === 'local') {
        this.declare(name);
        this.captureSlots.push({ name, outer });
      }
    }
    this.body.captures = this.captureSlots.length;
    for (const name of inner.locals.slice(1)) {
      if (this.parent!.tryResolve(name)?.k === 'local') {
        this.fail(
          n,
          `\`${name}\` is a captured local, which a Lambda can't put into`,
        );
      }
    }
    if (n.k === 'LambdaBlock') {
      this.prescan(n.body);
    }
    if (hasPatterns) {
      this.params(n.params, argSlots, null, failed, false);
    }
    if (n.k === 'Lambda') {
      this.at(n.body);
      this.expr(n.body);
      this.emit('return');
    } else {
      this.block(n.body);
      this.at(n.end);
      this.returnNothing();
    }
    if (hasPatterns) {
      this.place(failed);
      this.emit('raise', ['no match']);
    }
    this.finish();
  }

  // ------------------------------------------------------------- statements

  block(stmts: Node[]) {
    for (const s of stmts) {
      this.statement(s);
    }
  }

  statement(s: Node) {
    this.pos(s, () => this.statementAt(s));
  }

  statementAt(s: Node) {
    switch (s.k) {
      case 'Put':
        return this.put(s);
      case 'Let':
        return this.letStatement(s);
      case 'Set':
        return this.setStatement(s);
      case 'add':
      case 'subtract':
      case 'multiply':
      case 'divide':
        return this.arithmetic(s);
      case 'Delete':
        return this.deleteStatement(s);
      case 'ReplaceStatement':
        return this.replaceStatement(s);
      case 'If':
        return this.ifStatement(s);
      case 'Repeat':
        return this.repeat(s);
      case 'Match':
        return this.match(s);
      case 'ChooseOffer':
        for (const arg of s.args) {
          this.expr(arg);
        }
        this.at(s);
        this.emit('choose-offer', [s.name, s.args.length]);
        return;
      case 'Try':
        return this.tryBlock(s);
      case 'Throw':
        this.expr(s.value);
        this.emit('throw');
        return;
      case 'return':
        return this.returnStatement(s);
      case 'ExitRepeat':
      case 'NextRepeat':
        return this.loopJump(s);
      case 'Command':
        return this.command(s);
      case 'CallStatement':
        return this.callStatement(s);
      case 'ask':
      case 'tell':
        return this.askTell(s);
      case 'TellBlock':
        // Each line is the one-line call its Operation's mode allows (ADR
        // 0063). With no declarations here, a line is lowered as an `ask`,
        // which is what loading chooses for any Operation but a
        // fire-and-forget one.
        for (const line of s.lines) {
          this.askTell({ ...line, k: 'ask', target: s.target });
        }
        return;
      case 'Send':
        return this.send(s);
      case 'Wait':
        this.expr(s.duration);
        this.emit('wait');
        return;
      case 'WaitFor':
        return this.waitFor(s);
      case 'WaitForBlock':
        return this.waitForBlock(s);
      case 'Join':
        return this.joinBlock(s);
      case 'veto':
        if (s.value) {
          this.expr(s.value);
        } else {
          this.constant('nothing');
        }
        this.leaveBody(s, true, () => this.emit('veto'));
        return;
      case 'Pass':
        this.leaveBody(s, false, () => this.emit('pass', [s.name]));
        return;
    }
    this.fail(s, `no lowering for the statement ${s.k}`);
  }

  // The levels of a Container, from its root out: [root name, levels…].
  levels(c: Node): { levels: Node[]; root: Node } {
    const levels: Node[] = [];
    let e: Node = c;
    while (e.k !== 'Name') {
      levels.unshift(e);
      e = e.k === 'Key' || e.k === 'Property' ? e.base : e.of;
      if (!e) {
        this.fail(c, 'not a Container');
      }
    }
    return { root: e, levels };
  }

  // A read-modify-write of a Container (chapter 8). `before` emits the code
  // that comes before the Container in the source, left in a temp slot or
  // nothing. `part` emits the new leaf value, given a function that loads
  // the old one.
  // With `skip`, for `delete`, each level is tested before it is read, and a
  // missing one jumps to `skip`, past the store, so nothing changes.
  update(
    c: Node,
    part: (old: () => void) => void,
    before?: () => void,
    delimiter?: Node,
    skip?: Label,
  ) {
    const { root, levels } = this.levels(c);
    if (!levels.length) {
      before?.();
      part(() => this.load(root.name, root));
      this.store(root.name, root);
      return;
    }
    before?.();
    const delim = delimiter ?? levels.at(-1)!.delimiter;
    // The indexes and keys, outermost level first, as the source has them.
    const idx: (number | null)[] = [];
    for (let i = levels.length - 1; i >= 0; i--) {
      const l = levels[i]!;
      this.pos(l, () => {
        if (l.k === 'Key' && !l.computed) {
          return void (idx[i] = null);
        }
        if (l.k === 'Property') {
          this.fail(l, "a Built-in property isn't a Container");
        }
        if (l.k === 'Chunk') {
          this.expr(l.index);
        } else if (l.k === 'OrdinalChunk') {
          this.constant(String(ORDINAL_INDEX[l.ord]));
        } else {
          this.expr(l.key);
        }
        idx[i] = this.temp();
        this.emit('store', [idx[i]!]);
      });
    }
    let d: number | null = null;
    if (delim) {
      this.expr(delim);
      d = this.temp();
      this.emit('store', [d]);
    }
    // The wholes, from the root down.
    const whole: number[] = [];
    this.load(root.name, root);
    whole[0] = this.temp();
    this.emit('store', [whole[0]]);
    const read = skip ? levels.length : levels.length - 1;
    for (let i = 0; i < read; i++) {
      this.pos(levels[i]!, () => {
        if (skip) {
          this.testLevel(levels[i]!, idx[i]!, whole[i]!, d, skip);
        }
        this.getLevel(levels[i]!, idx[i]!, whole[i]!, d);
        whole[i + 1] = this.temp();
        this.emit('store', [whole[i + 1]!]);
      });
    }
    const leaf = levels.length - 1;
    const write = (i: number) => {
      const l = levels[i]!;
      this.pos(l, () => {
        if (l.k === 'Key') {
          if (l.computed) {
            this.emit('load', [idx[i]!]);
          }
          this.emit('load', [whole[i]!]);
        } else {
          this.emit('load', [idx[i]!]);
          this.emit('load', [whole[i]!]);
        }
      });
      if (i === leaf) {
        part(() =>
          this.pos(l, () =>
            skip
              ? void this.emit('load', [whole[i + 1]!])
              : this.getLevel(l, idx[i]!, whole[i]!, d),
          ),
        );
      } else {
        write(i + 1);
      }
      this.pos(l, () => this.setLevel(l, d));
    };
    write(0);
    this.store(root.name, root);
    this.release(
      ...(idx.filter(x => x !== null) as number[]),
      ...whole,
      ...(d === null ? [] : [d]),
    );
  }

  testLevel(
    l: Node,
    idx: number | null,
    whole: number,
    d: number | null,
    skip: Label,
  ) {
    if (l.k === 'Key') {
      if (l.computed) {
        this.emit('load', [idx!]);
      }
      this.emit('load', [whole]);
      this.emit(
        l.computed ? 'test-key-computed' : 'test-key',
        l.computed ? [skip] : [l.key, skip],
      );
      return;
    }
    const kind = SINGULAR[l.kind] ?? l.kind;
    this.emit('load', [idx!]);
    this.emit('load', [whole]);
    if (d !== null && kind === 'item') {
      this.emit('load', [d]);
      this.emit('test-chunk-delimited', [kind, skip]);
    } else {
      this.emit('test-chunk', [kind, skip]);
    }
  }

  getLevel(l: Node, idx: number | null, whole: number, d: number | null) {
    if (l.k === 'Key') {
      if (l.computed) {
        this.emit('load', [idx!]);
      }
      this.emit('load', [whole]);
      this.emit(
        l.computed ? 'get-key-computed' : 'get-key',
        l.computed ? [] : [l.key],
      );
      return;
    }
    const kind = SINGULAR[l.kind] ?? l.kind;
    this.emit('load', [idx!]);
    this.emit('load', [whole]);
    if (d !== null && kind === 'item') {
      this.emit('load', [d]);
      this.emit('chunk-get-delimited', [kind]);
    } else {
      this.emit('chunk-get', [kind]);
    }
  }

  setLevel(l: Node, d: number | null) {
    if (l.k === 'Key') {
      this.emit(
        l.computed ? 'set-key-computed' : 'set-key',
        l.computed ? [] : [l.key],
      );
      return;
    }
    const kind = SINGULAR[l.kind] ?? l.kind;
    if (d !== null && kind === 'item') {
      this.emit('load', [d]);
      this.emit('chunk-set-delimited', [kind]);
    } else {
      this.emit('chunk-set', [kind]);
    }
  }

  put(s: Node) {
    let v = 0;
    const before = () => {
      this.expr(s.value);
      v = this.temp();
      this.emit('store', [v]);
    };
    if (s.prep === 'into') {
      const { levels } = this.levels(s.target);
      if (!levels.length) {
        this.expr(s.value);
        this.at(s.target);
        this.store(s.target.name, s.target);
        return;
      }
      this.update(s.target, () => this.emit('load', [v]), before);
    } else {
      const op =
        s.prep === 'after'
          ? s.spread
            ? 'append-all'
            : 'append'
          : s.spread
            ? 'prepend-all'
            : 'prepend';
      this.update(
        s.target,
        old => {
          old();
          this.emit('load', [v]);
          this.at(s);
          this.emit(op);
        },
        before,
      );
    }
    this.release(v);
  }

  arithmetic(s: Node) {
    const op = {
      add: 'add',
      subtract: 'subtract',
      multiply: 'multiply',
      divide: 'divide',
    }[s.k as string]!;
    let v = 0;
    const value = () => {
      this.expr(s.value);
      v = this.temp();
      this.emit('store', [v]);
    };
    // `add e to c` and `subtract e from c` have the value first in the
    // source, and `multiply c by e` and `divide c by e` have it last.
    const valueFirst = s.k === 'add' || s.k === 'subtract';
    if (valueFirst) {
      this.update(
        s.target,
        old => {
          old();
          this.emit('load', [v]);
          this.at(s);
          this.emit(op);
        },
        value,
      );
    } else {
      this.update(s.target, old => {
        old();
        value();
        this.emit('load', [v]);
        this.at(s);
        this.emit(op);
      });
    }
    this.release(v);
  }

  // `delete` is a write one level up: the leaf's index or computed key comes
  // first, as the source has it, then the write of the level above, whose
  // new part is the whole with the leaf deleted (chapter 8).
  deleteStatement(s: Node) {
    const { root, levels } = this.levels(s.target);
    if (!levels.length) {
      this.constant('nothing');
      this.store(root.name, root);
      return;
    }
    const leaf = levels.at(-1)!;
    const kind = leaf.k === 'Key' ? null : (SINGULAR[leaf.kind] ?? leaf.kind);
    let i = -1;
    const index = () => {
      if (leaf.k === 'Key' && !leaf.computed) {
        return;
      }
      if (leaf.k === 'OrdinalChunk') {
        this.constant(String(ORDINAL_INDEX[leaf.ord]));
      } else {
        this.expr(leaf.k === 'Key' ? leaf.key : leaf.index);
      }
      i = this.temp();
      this.emit('store', [i]);
    };
    const del = (old: () => void) => {
      if (i >= 0) {
        this.emit('load', [i]);
      }
      old();
      this.at(leaf);
      if (leaf.k === 'Key') {
        this.emit(
          leaf.computed ? 'delete-key-computed' : 'delete-key',
          leaf.computed ? [] : [leaf.key],
        );
      } else if (s.target.delimiter && kind === 'item') {
        this.expr(s.target.delimiter);
        this.emit('chunk-delete-delimited', [kind]);
      } else {
        this.emit('chunk-delete', [kind!]);
      }
    };
    const upNode = leaf.k === 'Key' ? leaf.base : leaf.of;
    const skip = this.label();
    this.update(upNode, del, index, s.target.delimiter, skip);
    this.place(skip);
    if (i >= 0) {
      this.release(i);
    }
  }

  setStatement(s: Node) {
    const t = s.target;
    if (t.k !== 'Key') {
      this.fail(t, "`set` writes a Host Object's property");
    }
    if (t.computed) {
      this.expr(t.key);
    }
    this.expr(t.base);
    this.expr(s.value);
    this.at(s);
    this.emit(
      t.computed ? 'set-property-computed' : 'set-property',
      t.computed ? [] : [t.key],
    );
  }

  letStatement(s: Node) {
    this.expr(s.value);
    const sub = this.temp();
    this.emit('store', [sub]);
    const failed = this.label();
    const done = this.label();
    const binds = this.pattern(s.pat, sub, failed, new Map());
    this.commit(binds);
    this.emit('jump', [done]);
    this.place(failed);
    this.emit('raise', ['no match']);
    this.place(done);
    this.release(sub);
  }

  // Moves a pattern's temp bindings into the names' own slots.
  commit(binds: Map<string, number> | null) {
    if (!binds) {
      return;
    }
    for (const [name, t] of binds) {
      this.emit(
        'move',
        [t, this.names.get(name) ?? this.declare(name)],
        [name],
      );
      this.release(t);
    }
  }

  replaceStatement(s: Node) {
    let p = 0;
    this.update(
      s.target,
      old => {
        this.emit('load', [p]);
        old();
        this.replaceLoop(s);
      },
      () => {
        this.expr(s.pat);
        p = this.temp();
        this.emit('store', [p]);
      },
    );
    this.release(p);
  }

  // The pattern and the text are on the stack.
  replaceLoop(s: Node) {
    this.at(s);
    this.emit('replace-start', [s.first ? 1 : 0]);
    const top = this.label();
    const end = this.label();
    this.place(top);
    this.emit('replace-next', [end]);
    const m = this.temp();
    this.emit('store', [m]);
    if (s.pat.k === 'TextPattern') {
      for (const name of capturesOf(s.pat)) {
        this.emit('load', [m]);
        this.emit('get-key', ['captures']);
        this.emit('get-key', [name]);
        this.store(name, s);
      }
    }
    this.release(m);
    this.expr(s.value);
    this.at(s);
    this.emit('replace-put');
    this.emit('jump', [top]);
    this.place(end);
    this.emit('replace-end');
  }

  ifStatement(s: Node) {
    const end = this.label();
    const arms: { body: Node[]; cond: Node }[] = [
      { cond: s.cond, body: s.then },
      ...(s.elses ?? []).map((e: Node) => ({ cond: e.cond, body: e.body })),
    ];
    arms.forEach((arm, i) => {
      const next = this.label();
      this.expr(arm.cond);
      this.emit('branch-false', [next]);
      this.block(arm.body);
      if (i < arms.length - 1 || s.else) {
        this.emit('jump', [end]);
      }
      this.place(next);
    });
    if (s.else) {
      this.block(s.else);
    }
    this.place(end);
  }

  repeat(s: Node) {
    if (s.collect) {
      this.at(s.collect);
      this.emit('list', [0]);
      this.store(s.collect.into, s.collect);
    }
    const append = () => {
      if (s.collect) {
        this.at(s.collect);
        this.load(s.collect.into, s.collect);
        this.expr(s.collect.value);
        this.at(s.collect);
        this.emit('list-append');
        this.store(s.collect.into, s.collect);
        this.at(s);
      }
    };
    const h = s.head;
    const loop: Loop = {
      top: this.label(),
      exit: this.label(),
      finallies: this.finallies.length,
    };
    if (h.k === 'ForEach' || h.k === 'Times') {
      if (h.k === 'ForEach') {
        this.expr(h.src);
        this.at(s);
        this.emit('iterate');
      } else {
        this.expr(h.n);
        this.at(s);
        this.emit('iterate-times');
      }
      const done = this.label();
      this.iterators++;
      this.place(loop.top);
      this.emit('next', [done]);
      if (h.k === 'ForEach') {
        const failed = this.label();
        const ok = this.label();
        if (h.pat.k === 'Bind') {
          this.store(h.pat.name, h.pat);
        } else {
          const sub = this.temp();
          this.emit('store', [sub]);
          const binds = this.pattern(h.pat, sub, failed, new Map());
          this.commit(binds);
          this.release(sub);
          this.emit('jump', [ok]);
          this.place(failed);
          this.emit('raise', ['no match']);
          this.place(ok);
        }
      } else {
        this.emit('pop');
      }
      this.loops.push(loop);
      this.block(s.body);
      append();
      this.loops.pop();
      this.emit('jump', [loop.top]);
      this.place(loop.exit);
      this.place(done);
      this.emit('pop');
      this.iterators--;
      return;
    }
    this.place(loop.top);
    if (h.k === 'while' || h.k === 'until') {
      this.at(h.cond);
      this.expr(h.cond);
      this.emit(h.k === 'while' ? 'branch-false' : 'branch-true', [loop.exit]);
    }
    this.loops.push(loop);
    this.block(s.body);
    append();
    this.loops.pop();
    this.emit('jump', [loop.top]);
    this.place(loop.exit);
  }

  loopJump(s: Node) {
    const loop = this.loops.at(-1);
    if (!loop) {
      this.fail(s, '`exit repeat` or `next repeat` outside a loop');
    }
    if (this.inFinally.length && this.loops.length <= this.inFinally.at(-1)!) {
      this.fail(
        s,
        "`exit repeat` or `next repeat` can't leave a `finally` block",
      );
    }
    this.leave(loop.finallies, () =>
      this.emit('jump', [s.k === 'ExitRepeat' ? loop.exit : loop.top]),
    );
  }

  // `return`, `veto` and `pass` run the open `finally` blocks first, and
  // can't leave a `finally` block (chapter 6).
  leaveBody(s: Node, value: boolean, op: () => void) {
    if (this.inFinally.length) {
      this.fail(
        s,
        `\`${s.k === 'Pass' ? 'pass' : s.k}\` can't leave a \`finally\` block`,
      );
    }
    if (!this.finallies.length) {
      return op();
    }
    let t = -1;
    if (value) {
      t = this.temp();
      this.emit('store', [t]);
    }
    this.leave(0, () => {
      if (value) {
        this.emit('load', [t]);
      }
      op();
    });
    if (value) {
      this.release(t);
    }
  }

  // Leaves the `finally` blocks from `depth` in: runs each, innermost
  // first, then `tail` (the jump or `return` that leaves). The copies and the
  // tail are outside the spans of those `try`s and of every `try` inside
  // them (chapter 8).
  leave(depth: number, tail: () => void) {
    if (depth >= this.finallies.length) {
      return tail();
    }
    const from = this.tries.findIndex(t => t.finally === depth);
    const paused = this.tries
      .slice(from)
      .flatMap(t => [t.catchRec, t.offerRec, t.finRec])
      .filter((r): r is Rec => !!r && r.open !== null);
    for (const r of paused) {
      this.closeSpan(r);
    }
    const saved = this.finallies;
    for (let i = saved.length - 1; i >= depth; i--) {
      this.finallies = saved.slice(0, i);
      this.inFinally.push(this.loops.length);
      this.block(saved[i]!);
      this.inFinally.pop();
    }
    this.finallies = saved;
    tail();
    for (const r of paused) {
      r.open = this.code.length;
    }
  }

  closeSpan(r: Rec) {
    if (r.open !== null && r.open < this.code.length) {
      r.spans.push([r.open, this.code.length]);
    }
    r.open = null;
  }

  returnStatement(s: Node) {
    if (s.value) {
      this.expr(s.value);
    } else {
      this.constant('nothing');
    }
    this.leaveBody(s, true, () => this.emit('return'));
  }

  match(s: Node) {
    this.expr(s.subject);
    const sub = this.temp();
    this.emit('store', [sub]);
    const end = this.label();
    for (const b of s.branches) {
      this.pos(b, () => {
        if (b.k === 'Else') {
          this.block(b.body);
          return;
        }
        const next = this.label();
        const binds = new Map<string, number>();
        this.guarded(next, () => {
          if (b.search) {
            this.emit('load', [sub]);
            this.expr(b.pat);
            this.emit('match-search', s.ignoringCase ? ['fold', next] : [next]);
            this.bindCaptures(b.pat, binds);
          } else {
            this.pattern(b.pat, sub, next, binds, s.ignoringCase);
          }
          if (b.guard) {
            this.guardWith(b.guard, next, binds);
          }
        });
        this.commit(binds);
        this.block(b.body);
        this.emit('jump', [end]);
        this.place(next);
      });
    }
    this.place(end);
    this.release(sub);
  }

  // A Guard that reads a pattern's temp bindings under their names.
  guardWith(g: Node, failed: Label, binds: Map<string, number>) {
    const saved = new Map<string, number | undefined>();
    for (const [name, t] of binds) {
      saved.set(name, this.names.get(name));
      this.names.set(name, t);
    }
    this.guard(g, failed);
    for (const [name, s] of saved) {
      if (s === undefined) {
        this.names.delete(name);
      } else {
        this.names.set(name, s);
      }
    }
  }

  // A `try`: its body, its catch handler and its `finally` (chapter 8). The
  // catch entry covers the body, and the finally entry the body and the
  // catch handler, each without the inlined copies of the `finally`.
  tryBlock(s: Node) {
    const end = this.label();
    const hasFinally = !!s.finally;
    const offerRec: Rec | null = s.offers?.length
      ? { spans: [], open: this.code.length }
      : null;
    const catchRec: Rec | null = s.catches.length
      ? { spans: [], open: this.code.length }
      : null;
    const finRec: Rec | null = hasFinally
      ? { spans: [], open: this.code.length }
      : null;
    if (hasFinally) {
      this.finallies.push(s.finally);
    }
    const me = {
      finally: hasFinally ? this.finallies.length - 1 : null,
      catchRec,
      finRec,
      offerRec,
    };
    this.tries.push(me);
    this.block(s.body);
    if (catchRec) {
      this.closeSpan(catchRec);
    }
    if (offerRec) {
      this.closeSpan(offerRec);
    }
    if (hasFinally) {
      this.leave(me.finally!, () => this.emit('jump', [end]));
    } else {
      this.emit('jump', [end]);
    }
    if (catchRec) {
      const handler = this.code.length;
      for (const [from, to] of catchRec.spans) {
        this.unwind.push({
          from,
          to,
          kind: 'catch',
          target: handler,
          depth: this.iterators,
        });
      }
      // Catch dispatch runs while protected-body continuations remain live.
      const retainedFree = this.free;
      this.free = [];
      const err = this.temp();
      // The error is on the stack until it is stored, so the finally spans
      // start after the store, at the static depth.
      if (finRec) {
        this.closeSpan(finRec);
      }
      this.pos(s.catches[0], () => this.emit('store', [err]));
      if (finRec) {
        finRec.open = this.code.length;
      }
      for (const c of s.catches) {
        this.pos(c, () => {
          const next = this.label();
          const binds = new Map<string, number>();
          const pat =
            c.pat.k === 'Literal' && typeof c.pat.v === 'object'
              ? {
                  k: 'MapPattern',
                  entries: [{ k: 'Entry', key: 'code', value: c.pat }],
                  line: c.pat.line,
                  col: c.pat.col,
                }
              : c.pat;
          this.guarded(next, () => {
            this.pattern(pat, err, next, binds);
            if (c.guard) {
              this.guardWith(c.guard, next, binds);
            }
          });
          this.at(c);
          if (!c.recovery) {
            this.emit('catch-accept');
          }
          this.commit(binds);
          this.block(c.body);
          if (!c.recovery) {
            if (hasFinally) {
              this.leave(me.finally!, () => this.emit('jump', [end]));
            } else {
              this.emit('jump', [end]);
            }
          }
          this.place(next);
        });
      }
      this.pos(s.catches.at(-1), () => {
        this.emit('catch-next');
      });
      this.release(err);
      this.free = [...retainedFree, ...this.free];
    }
    if (offerRec) {
      const record = {
        body: this.body.index,
        depth: this.iterators,
        end,
        offers: [] as { binds: number[]; name: string; target: Label }[],
      };
      for (const offer of s.offers) {
        const target = this.label();
        this.place(target);
        record.offers.push({
          name: offer.name,
          binds: offer.params.map((name: string) => this.names.get(name)!),
          target,
        });
        this.block(offer.body);
        this.pos(offer, () => {
          if (hasFinally) {
            this.leave(me.finally!, () => this.emit('jump', [end]));
          } else {
            this.emit('jump', [end]);
          }
        });
      }
      const index = this.offers.length;
      this.offers.push(record);
      for (const [from, to] of offerRec.spans) {
        this.unwind.push({
          from,
          to,
          kind: 'offer',
          target: index,
          depth: this.iterators,
        });
      }
    }
    this.tries.pop();
    if (finRec) {
      this.closeSpan(finRec);
      this.finallies.pop();
      const target = this.code.length;
      for (const [from, to] of finRec.spans) {
        this.unwind.push({
          from,
          to,
          kind: 'finally',
          target,
          depth: this.iterators,
        });
      }
      this.inFinally.push(this.loops.length);
      this.block(s.finally);
      this.inFinally.pop();
      this.emit('end-cleanup');
    }
    this.place(end);
  }

  command(s: Node) {
    if (s.name === 'say') {
      s.args.forEach((a: Node) => this.expr(a));
      this.at(s);
      this.emit('tell', ['console', 'write', s.args.length]);
      return;
    }
    s.args.forEach((a: Node) => this.expr(a));
    this.at(s);
    const local = this.u.handlers.has(s.name);
    const imp = this.u.imports.get(s.name);
    if (local || imp?.what === 'handler') {
      this.emit(s.wait ? 'call-handler-wait' : 'call-handler', [
        imp ? `${imp.library}:${imp.name}` : s.name,
        s.args.length,
      ]);
      this.emit('store', [0], ['it']);
    } else if (s.wait) {
      this.emit('send-up-wait', [s.name, s.args.length]);
      this.emit('store', [0], ['it']);
    } else {
      this.emit('send-up', [s.name, s.args.length]);
    }
  }

  callStatement(s: Node) {
    this.call(s.call, s.wait);
    this.emit('store', [0], ['it']);
  }

  askTell(s: Node) {
    if (s.target.k !== 'Name') {
      this.fail(s.target, "`ask` and `tell` take a Grant's name");
    }
    s.args.forEach((a: Node) => this.expr(a));
    this.at(s);
    const g = s.target.name;
    if (s.k === 'tell') {
      return void this.emit('tell', [g, s.op, s.args.length]);
    }
    if (s.wait && this.join) {
      return void this.emit('join-ask', [g, s.op, s.args.length]);
    }
    this.emit(s.wait ? 'ask-wait' : 'ask', [g, s.op, s.args.length]);
    this.emit('store', [0], ['it']);
  }

  send(s: Node) {
    // A computed name is evaluated first, below the arguments (ADR 0057).
    if (s.name) {
      this.expr(s.name);
    }
    s.args.forEach((a: Node) => this.expr(a));
    this.expr(s.target);
    this.at(s);
    if (s.name) {
      if (s.wait && this.join) {
        return void this.emit('join-send-named', [s.args.length]);
      }
      this.emit(s.wait ? 'send-named-wait' : 'send-named', [s.args.length]);
    } else if (s.wait && this.join) {
      return void this.emit('join-send', [s.msg, s.args.length]);
    } else {
      this.emit(s.wait ? 'send-wait' : 'send', [s.msg, s.args.length]);
    }
    if (s.wait) {
      this.emit('store', [0], ['it']);
    }
  }

  // An event test body: the event's patterns and Guard, over the message's
  // arguments, giving the list of the values it binds.
  // Like a Lambda, it captures the waiting body's locals it reads, by value,
  // when the `wait for` begins, and `wait-for` pops them (chapter 8).
  eventBody(
    ev: Node,
    guard: Node | null,
  ): { binds: number[]; body: number | null; captures: number } {
    const names = ev.pats.flatMap(patternNames);
    if (!ev.pats.length && !guard) {
      return { body: null, binds: [], captures: 0 };
    }
    const b = this.u.newBody('event', ev.name, []);
    const bc = new BodyCompiler(this.u, b, this);
    const argSlots = ev.pats.map((p: Node) =>
      p.k === 'Bind'
        ? bc.declare(p.name)
        : bc.declare(`(argument ${bc.locals.length})`),
    );
    b.params = ev.pats.map((p: Node) => (p.k === 'Bind' ? p.name : '…'));
    ev.pats
      .filter((p: Node) => p.k !== 'Bind')
      .flatMap(patternNames)
      .forEach((x: string) => bc.declare(x));
    const own = new Set(names);
    for (const name of freeNames([ev.pats, guard])) {
      if (own.has(name) || bc.names.has(name)) {
        continue;
      }
      const outer = this.tryResolve(name);
      if (outer?.k === 'local') {
        bc.declare(name);
        bc.captureSlots.push({ name, outer });
      }
    }
    b.captures = bc.captureSlots.length;
    for (const c of bc.captureSlots) {
      this.emit('load', [(c.outer as any).slot], [c.name]);
    }
    const failed = bc.label();
    bc.params(ev.pats, argSlots, guard, failed, true);
    for (const n of names) {
      bc.emit('load', [bc.names.get(n)!], [n]);
    }
    bc.emit('list', [names.length]);
    bc.emit('return');
    bc.place(failed);
    bc.emit('clause-fail');
    bc.finish();
    return {
      body: b.index,
      binds: names.map((n: string) => this.names.get(n) ?? this.declare(n)),
      captures: b.captures,
    };
  }

  waitFor(s: Node) {
    const e: EventEntry = {
      index: this.u.events.length,
      branches: [],
      timeout: !!s.timeout,
    };
    this.u.events.push(e);
    if (s.from) {
      this.expr(s.from);
    }
    const { body, binds, captures } = this.eventBody(s, null);
    if (s.timeout) {
      this.expr(s.timeout);
    }
    e.branches.push({
      kind: 'when',
      message: s.name,
      from: !!s.from,
      body,
      binds,
      captures,
    });
    this.at(s);
    this.emit('wait-for', [e.index]);
    this.emit('store', [0], ['it']);
  }

  waitForBlock(s: Node) {
    const e: EventEntry = {
      index: this.u.events.length,
      branches: [],
      timeout: false,
    };
    this.u.events.push(e);
    for (const b of s.branches) {
      if (b.k === 'WhenEvent') {
        if (b.from) {
          this.expr(b.from);
        }
        const { body, binds, captures } = this.eventBody(b, b.guard);
        e.branches.push({
          kind: 'when',
          message: b.name,
          from: !!b.from,
          body,
          binds,
          captures,
        });
      } else {
        this.expr(b.duration);
        e.branches.push({
          kind: 'after',
          from: false,
          body: null,
          binds: [],
          captures: 0,
        });
      }
    }
    this.at(s);
    this.emit('wait-for-any', [e.index]);
    const which = this.temp();
    this.emit('store', [which]);
    this.emit('store', [0], ['it']);
    const end = this.label();
    s.branches.forEach((b: Node, i: number) => {
      const next = this.label();
      this.emit('load', [which]);
      this.constant(String(i + 1));
      this.emit('equal', []);
      this.emit('branch-false', [next]);
      this.block(b.body);
      this.emit('jump', [end]);
      this.place(next);
    });
    this.place(end);
    this.release(which);
  }

  joinBlock(s: Node) {
    this.emit('join-start');
    this.join++;
    this.block(s.body);
    this.join--;
    this.at(s);
    this.emit('join-end');
    this.emit('store', [0], ['it']);
  }

  // ------------------------------------------------------------- patterns

  // Tests the value in slot `sub` against a pattern, jumping to `failed`.
  // With `binds`, names bind to temp slots for `commit`; without, directly.
  pattern(
    p: Node,
    sub: number,
    failed: Label,
    binds: Map<string, number> | null,
    fold = false,
  ): Map<string, number> | null {
    const bindName = (name: string) => {
      if (!binds) {
        this.emit(
          'store',
          [this.names.get(name) ?? this.declare(name)],
          [name],
        );
        return;
      }
      const t = this.temp();
      binds.set(name, t);
      this.emit('store', [t], [name]);
    };
    const test = (p: Node, sub: number) => this.pos(p, () => testAt(p, sub));
    const testAt = (p: Node, sub: number) => {
      switch (p.k) {
        case 'Bind':
          this.emit('load', [sub]);
          bindName(p.name);
          return;
        case 'Wildcard':
          return;
        case 'BindAs':
          test(p.p, sub);
          this.emit('load', [sub]);
          bindName(p.name);
          return;
        case 'Literal': {
          this.emit('load', [sub]);
          const v =
            typeof p.v === 'object'
              ? textConstant(p.v.v)
              : p.unit
                ? `${p.neg ? '-' : ''}${numberConstant(p.v)} ${p.unit}`
                : /^\d/.test(p.v)
                  ? `${p.neg ? '-' : ''}${numberConstant(p.v)}`
                  : p.v;
          this.emit(
            'test-constant',
            fold
              ? [this.u.constant(v), 'fold', failed]
              : [this.u.constant(v), failed],
            [v],
          );
          return;
        }
        case 'Pin':
          this.emit('load', [sub]);
          this.load(p.name, p);
          this.emit('test-equal', [failed]);
          return;
        case 'ListPattern': {
          const rest = p.items.findIndex((i: Node) => i.k === 'Rest');
          const fixed = rest < 0 ? p.items.length : rest;
          this.emit('load', [sub]);
          this.emit(rest < 0 ? 'test-list' : 'test-list-at-least', [
            fixed,
            failed,
          ]);
          p.items.forEach((item: Node, i: number) => {
            this.emit('load', [sub]);
            if (item.k === 'Rest') {
              if (!item.name) {
                return void this.emit('pop');
              }
              this.emit('list-rest', [i + 1]);
              bindName(item.name);
              return;
            }
            this.emit('list-item', [i + 1]);
            this.sub(item, test, bindName);
          });
          return;
        }
        case 'MapPattern':
          this.emit('load', [sub]);
          this.emit('test-map', [failed]);
          for (const e of p.entries) {
            this.emit('load', [sub]);
            this.emit('map-get', [e.key, failed]);
            this.sub(e.value, test, bindName);
          }
          return;
        case 'TextPattern': {
          this.emit('load', [sub]);
          this.expr(p);
          this.emit('match-whole', fold ? ['fold', failed] : [failed]);
          const caps = capturesOf(p);
          if (!caps.length) {
            return void this.emit('pop');
          }
          const c = this.temp();
          this.emit('store', [c]);
          for (const name of caps) {
            this.emit('load', [c]);
            this.emit('get-key', [name]);
            bindName(name);
          }
          this.release(c);
          return;
        }
        case 'BinaryPattern':
          return this.binaryPattern(p, sub, failed, bindName, binds);
      }
      this.fail(p, `no lowering for the pattern ${p.k}`);
    };
    test(p, sub);
    return binds;
  }

  // A sub-pattern of the value on the stack: a name binds it straight away,
  // and anything else goes through a temp slot.
  sub(
    p: Node,
    test: (p: Node, sub: number) => void,
    bindName: (n: string) => void,
  ) {
    if (p.k === 'Bind') {
      return bindName(p.name);
    }
    if (p.k === 'Wildcard') {
      return void this.emit('pop');
    }
    const t = this.temp();
    this.emit('store', [t]);
    test(p, t);
    this.release(t);
  }

  bindCaptures(pat: Node, binds: Map<string, number>) {
    const caps = pat.k === 'TextPattern' ? capturesOf(pat) : [];
    if (!caps.length) {
      return void this.emit('pop');
    }
    const c = this.temp();
    this.emit('store', [c]);
    for (const name of caps) {
      this.emit('load', [c]);
      this.emit('get-key', [name]);
      const t = this.temp();
      binds.set(name, t);
      this.emit('store', [t], [name]);
    }
    this.release(c);
  }

  binaryPattern(
    p: Node,
    sub: number,
    failed: Label,
    bindName: (n: string) => void,
    binds: Map<string, number> | null,
  ) {
    this.emit('load', [sub]);
    this.emit('bin-start', [failed]);
    // Names bound by earlier fields are sizes for later ones, so they bind to
    // their slots as the fields are read.
    const fields: Node[] = p.fields;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!;
      this.line = f.line ?? this.line;
      this.col = f.col ?? this.col;
      if (f.k === 'Literal') {
        const v = /^\d/.test(f.v) ? numberConstant(f.v) : textConstant(f.v);
        this.emit('bin-literal', [this.u.constant(v), failed], [v]);
      } else if (f.k === 'Rest') {
        this.emit('bin-rest', [f.asText ? 'bytes as text' : 'bytes', failed]);
        if (f.name) {
          bindName(f.name);
        } else {
          this.emit('pop');
        }
        return;
      } else if (f.type.k === 'Int') {
        this.emit('bin-int', [fieldType(f.type), failed]);
        if (f.name === '_') {
          this.emit('pop');
        } else {
          bindName(f.name);
        }
      } else if (f.type.unit === 'bits' || f.type.unit === 'bit') {
        const run: Node[] = [];
        while (
          i < fields.length &&
          fields[i]!.k === 'Field' &&
          fields[i]!.type.k === 'Sized' &&
          ['bits', 'bit'].includes(fields[i]!.type.unit)
        ) {
          run.push(fields[i++]!);
        }
        i--;
        const widths = run.map(r =>
          r.type.size.k === 'Num' ? r.type.size.v : '?',
        );
        this.emit('bin-bits', [
          this.u.constant(`[${widths.join(', ')}]`),
          run.length,
          failed,
        ]);
        for (const r of [...run].reverse()) {
          if (r.name === '_') {
            this.emit('pop');
          } else {
            bindName(r.name);
          }
        }
      } else {
        this.binarySize(f.type.size, binds);
        this.emit('bin-bytes', [fieldType(f.type), failed]);
        if (f.name === '_') {
          this.emit('pop');
        } else {
          bindName(f.name);
        }
      }
    }
    this.at(p);
    this.emit('bin-end', [failed]);
  }

  // A size reads the names earlier fields bound, from their temps when the
  // pattern binds to temps (chapter 8).
  binarySize(n: Node, binds: Map<string, number> | null) {
    if (n.k === 'Pin') {
      return void this.load(n.name, n);
    }
    if (!binds?.size) {
      return this.expr(n);
    }
    const saved = new Map<string, number | undefined>();
    for (const [name, t] of binds) {
      saved.set(name, this.names.get(name));
      this.names.set(name, t);
    }
    try {
      this.expr(n);
    } finally {
      for (const [name, v] of saved) {
        if (v === undefined) {
          this.names.delete(name);
        } else {
          this.names.set(name, v);
        }
      }
    }
  }

  // ------------------------------------------------------------- expressions

  expr(n: Node) {
    this.pos(n, () => this.exprAt(n));
  }

  exprAt(n: Node) {
    switch (n.k) {
      case 'Num':
        return void this.constant(numberConstant(n.v));
      case 'Quantity':
        return void this.constant(`${numberConstant(n.n)} ${n.unit}`);
      case 'Text':
        return void this.constant(textConstant(n.v));
      case 'Const':
        if (n.v === 'it') {
          return void this.emit('load', [0], ['it']);
        }
        if (n.v === 'me') {
          return void this.emit('me');
        }
        return void this.constant(n.v);
      case 'Target':
        return void this.emit('target');
      case 'Group':
        return this.expr(n.e);
      case 'Name':
        return void this.load(n.name, n);
      case 'Call':
        return this.call(n, false);
      case 'and':
      case 'or':
        return this.logical(n);
      case 'not':
        this.expr(n.e);
        this.at(n);
        this.emit('not');
        return;
      case 'neg':
        this.expr(n.e);
        this.at(n);
        this.emit('negate');
        return;
      case 'as':
        this.expr(n.e);
        this.at(n);
        this.emit('convert', [n.type]);
        return;
      case 'is': {
        this.expr(n.l);
        this.expr(n.r);
        this.at(n);
        const op = n.neg ? 'not-equal' : 'equal';
        this.emit(op, n.ignoringCase ? ['fold'] : []);
        return;
      }
      case 'is in': {
        this.expr(n.l);
        this.expr(n.r);
        this.at(n);
        this.emit('member', n.ignoringCase ? ['fold'] : []);
        if (n.neg) {
          this.emit('not');
        }
        return;
      }
      case 'is a':
        this.expr(n.l);
        this.at(n);
        this.emit('is-kind', [n.kind]);
        if (n.neg) {
          this.emit('not');
        }
        return;
      case 'is empty':
        this.expr(n.l);
        this.at(n);
        this.emit('is-empty');
        if (n.neg) {
          this.emit('not');
        }
        return;
      case 'can be':
        this.expr(n.l);
        this.at(n);
        this.emit('can-convert', [n.kind]);
        return;
      case 'Key': {
        if (n.computed) {
          this.expr(n.key);
        }
        this.expr(n.base);
        this.at(n);
        this.emit(
          n.computed ? 'get-key-computed' : 'get-key',
          n.computed ? [] : [n.key],
        );
        return;
      }
      case 'Property': {
        this.expr(n.base);
        if (n.delimiter) {
          this.expr(n.delimiter);
          this.at(n);
          this.emit('property-delimited', [n.key]);
        } else {
          this.at(n);
          this.emit('property', [n.key]);
        }
        return;
      }
      case 'Chunk':
      case 'OrdinalChunk':
        return this.chunkRead(n);
      case 'List':
        return this.list(n);
      case 'Map': {
        n.entries.forEach((e: Node) => this.expr(e.value));
        this.at(n);
        const keys = `[${n.entries.map((e: Node) => textConstant(e.key)).join(', ')}]`;
        this.emit('map', [this.u.constant(keys), n.entries.length], [keys]);
        return;
      }
      case 'TextPattern': {
        const splices = splicesOf(n);
        const src = patternSource(n, { n: 0 });
        if (!splices.length) {
          return void this.constant(src);
        }
        splices.forEach(e => this.expr(e));
        this.at(n);
        this.emit(
          'make-pattern',
          [this.u.constant(src), splices.length],
          [src],
        );
        return;
      }
      case 'BinaryBuild':
        return this.binaryBuild(n);
      case 'MatchSearch':
        this.expr(n.pat);
        this.expr(n.src);
        this.at(n);
        this.emit('match-all');
        return;
      case 'Replace':
        this.expr(n.pat);
        this.expr(n.target);
        return this.replaceLoop(n);
      case 'Lambda':
      case 'LambdaBlock':
        return this.makeLambda(n);
      case 'Spread':
        this.fail(n, '`...` outside a list literal');
    }
    const op = BINARY[n.k];
    if (op) {
      this.expr(n.l);
      this.expr(n.r);
      this.at(n);
      this.emit(op, n.ignoringCase && FOLDING.has(op) ? ['fold'] : []);
      return;
    }
    this.fail(n, `no lowering for the expression ${n.k}`);
  }

  // `a and b` and `a or b`, short-circuiting.
  logical(n: Node) {
    const short = this.label();
    const end = this.label();
    this.expr(n.l);
    this.at(n);
    this.emit(n.k === 'and' ? 'branch-false' : 'branch-true', [short]);
    this.expr(n.r);
    this.at(n);
    this.emit('check-boolean');
    this.emit('jump', [end]);
    this.place(short);
    this.constant(n.k === 'and' ? 'false' : 'true');
    this.place(end);
  }

  chunkRead(n: Node) {
    // The chain, outermost level first, down to the value it reads from.
    const levels: Node[] = [];
    let e: Node = n;
    while (e.k === 'Chunk' || e.k === 'OrdinalChunk') {
      levels.push(e);
      e = e.of;
    }
    for (const l of levels) {
      if (l.k === 'OrdinalChunk') {
        this.constant(String(ORDINAL_INDEX[l.ord]));
      } else {
        this.expr(l.index);
      }
    }
    this.expr(e);
    let d: number | null = null;
    if (n.delimiter) {
      this.expr(n.delimiter);
      d = this.temp();
      this.emit('store', [d]);
    }
    for (const l of [...levels].reverse()) {
      this.at(l);
      const kind = SINGULAR[l.kind] ?? l.kind;
      if (d !== null && kind === 'item') {
        this.emit('load', [d]);
        this.emit('chunk-get-delimited', [kind]);
      } else {
        this.emit('chunk-get', [kind]);
      }
    }
    if (d !== null) {
      this.release(d);
    }
  }

  list(n: Node) {
    if (!n.items.some((i: Node) => i.k === 'Spread')) {
      n.items.forEach((i: Node) => this.expr(i));
      this.at(n);
      this.emit('list', [n.items.length]);
      return;
    }
    this.at(n);
    this.emit('list', [0]);
    for (const i of n.items) {
      this.expr(i.k === 'Spread' ? i.e : i);
      this.emit(i.k === 'Spread' ? 'list-extend' : 'list-append');
    }
  }

  binaryBuild(n: Node) {
    this.constant('<<>>');
    const fields: Node[] = n.fields;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!;
      const isBits = (x: Node) =>
        x.type && x.type.k === 'Sized' && ['bits', 'bit'].includes(x.type.unit);
      if (isBits(f)) {
        const run: Node[] = [];
        while (i < fields.length && isBits(fields[i]!)) {
          run.push(fields[i++]!);
        }
        i--;
        run.forEach(r => this.expr(r.value));
        const widths = run.map(r =>
          r.type.size.k === 'Num' ? r.type.size.v : '?',
        );
        this.at(f);
        this.emit('bytes-bits', [
          this.u.constant(`[${widths.join(', ')}]`),
          run.length,
        ]);
        continue;
      }
      this.expr(f.value);
      if (f.type && f.type.k === 'Sized') {
        this.binarySize(f.type.size, null);
        this.at(f.value);
        this.emit('bytes-sized', [fieldType(f.type)]);
        continue;
      }
      this.at(f.value);
      this.emit('bytes-field', [fieldType(f.type)]);
    }
  }

  call(n: Node, wait: boolean) {
    const p =
      this.tryResolve(n.fn) ??
      (BUILTIN_FUNCTIONS.has(n.fn) ? null : this.resolve(n.fn, n));
    if (!p) {
      n.args.forEach((a: Node) => this.expr(a));
      this.at(n);
      return void this.emit('call-builtin', [n.fn, n.args.length]);
    }
    if (p.k === 'local' || p.k === 'variable' || p.k === 'definition') {
      this.load(n.fn, n);
      n.args.forEach((a: Node) => this.expr(a));
      this.at(n);
      this.emit(wait ? 'call-value-wait' : 'call-value', [n.args.length]);
      return;
    }
    n.args.forEach((a: Node) => this.expr(a));
    this.at(n);
    if (p.k === 'function') {
      return void this.emit('call', [p.body, n.args.length], [n.fn]);
    }
    if (p.k === 'handler') {
      return void this.emit('call-handler', [n.fn, n.args.length]);
    }
    if (p.k === 'import') {
      return void this.emit('call-import', [
        `${p.imp.library}:${p.imp.name}`,
        n.args.length,
      ]);
    }
    if (p.k === 'object') {
      return void this.emit('call-builtin', [n.fn, n.args.length], ['unknown']);
    }
    this.fail(n, `\`${n.fn}\` isn't a function`);
  }

  makeLambda(n: Node) {
    const b = this.u.newBody(
      'lambda',
      `${this.body.name}:${n.line}:${n.col}`,
      [],
    );
    const bc = new BodyCompiler(this.u, b, this);
    bc.lambda(n);
    for (const c of bc.captureSlots) {
      const outer = c.outer as { k: 'local'; slot: number };
      this.emit('load', [outer.slot], [c.name]);
    }
    this.at(n);
    this.emit('make-closure', [b.index, bc.captureSlots.length], [b.name]);
  }
}

// The resolve step in `resolve` resolves Built-in function names only at a
// call, so a bare Built-in name is an error there; a Built-in may still be
// shadowed by any of the Script's own names (ADR 0034).
export const compileSource = (
  name: string,
  kind: 'script' | 'library',
  src: string,
  opts: Options = {},
): Unit => {
  const { ast, error } = parse(src);
  if (error) {
    throw new CompileError(
      error.tok.line,
      error.tok.col,
      `${error.code}: ${error.message}`,
    );
  }
  const u = new UnitCompiler(name, kind, ast!, opts);
  const unit = u.compile();
  // Guard entries target the label they fail to.
  for (const b of unit.bodies) {
    void b;
  }
  return unit;
};
