// A static Fuel estimate for each body of a compiled Script or Library (#1606).
// It is advisory: the Cost Model charges a Run, and this only reads the
// lowering. Each instruction's Fuel formula splits into a constant and the
// terms that measure values; a body gets the constant Fuel of its cheapest and
// dearest paths to an exit, and of one pass of each loop. Calls to bodies it
// can see add their callee's bounds, and Capability calls add the Host
// Manifest's declared cost.
import type { CodeUnit, Shape } from '@northtalk/ts';
import { countAt, ending, fuelRates, jumping } from './generated/fuel';

/** What the estimate reads of a loaded Script or Library. */
export type FuelCode = {
  readonly libraries: ReadonlyMap<string, FuelCode>;
  readonly unit: CodeUnit;
};

/** A source position in the unit that holds it. */
export type FuelAt = { col: number; line: number; unit: string };

/** One pass of a loop, from its header to its back edge. */
export type FuelLoop = { at: FuelAt; max: number; min: number };

/** A term this estimate cannot evaluate, at the instruction that charges it. */
export type FuelTerm = {
  at: FuelAt;
  /** The Cost Model key, `call` for an unresolved callee. */
  key: string;
  /** The formula's term, or what the open cost is. */
  term: string;
};

export type FuelEstimate = {
  at: FuelAt;
  /** Fuel a Handler's dispatch charges for each Handler Clause it tries. */
  clause: number;
  kind: string;
  /** Loops in this body and in the callees it adds. */
  loops: FuelLoop[];
  /** Constant Fuel of the dearest path to an exit, each loop skipped. */
  max: number;
  /** Constant Fuel of the cheapest path to an exit. */
  min: number;
  name: string;
  /** Terms in this body and in the callees it adds. */
  terms: FuelTerm[];
};

/** A Capability Operation's declared Fuel, if the Host Manifest has one. */
export type DeclaredFuel = (
  grant: string,
  operation: string,
) => number | undefined;

const jumps = new Set<string>(jumping);
const ends = new Set<string>(ending);
const clauseFuel = fuelRates.find(r => r.key === 'clause')!.fixed;
const capabilityCalls = new Set(['ask', 'ask-wait', 'tell', 'join-ask']);

type Unit = CodeUnit;
type Body = Unit['bodies'][number];

/**
 * A body's control flow, indexed from its first instruction: forward edges,
 * the back edges that close loops, and where an Error raised at each
 * instruction can go. A catch, finally or guard range sends it to its target;
 * the raising instruction may not have paid, so that edge leaves before it.
 */
const graphOf = (unit: Unit, body: Body) => {
  const edges: number[][] = [];
  const raises: number[][] = [];
  const backs: [from: number, to: number][] = [];
  for (let pc = body.start; pc < body.end; pc++) {
    const { op, operands } = unit.code[pc]!;
    const next = ends.has(op) ? [] : [pc + 1];
    if (jumps.has(op)) {
      next.push(Number(operands.at(-1)));
    }
    edges.push(
      next.filter(to => {
        if (to <= pc) {
          backs.push([to, pc]);
          return false;
        }
        return to < body.end;
      }),
    );
    raises.push(
      unit.unwind
        .filter(
          u =>
            u.kind !== 'offer' &&
            u.start <= pc &&
            pc < u.end &&
            pc < u.target &&
            u.target < body.end,
        )
        .map(u => u.target),
    );
  }
  return { backs, edges, raises };
};

/** Estimates every body but the initialiser, which Load runs uncharged. */
export const estimateFuel = (
  code: FuelCode,
  declared: DeclaredFuel = () => undefined,
): FuelEstimate[] => {
  const estimator = new Estimator(declared);
  return code.unit.bodies
    .filter(body => body.kind !== 'init')
    .map(body => estimator.body(code, body));
};

/**
 * The caps a Fuel Bound assumes. Each applies to every value, counting nested
 * items together: no text longer, no number with more digits, no collection
 * with more items or entries, no Bytes longer, and no computed `repeat n
 * times` count larger.
 */
export type FuelCaps = {
  bytes: number;
  collection: number;
  digits: number;
  text: number;
  times: number;
};

export const defaultFuelCaps: FuelCaps = {
  bytes: 1024,
  collection: 100,
  digits: 20,
  text: 256,
  times: 100,
};

/**
 * A Capability Operation's declared result Shape: null if it has no result,
 * undefined if the Host Manifest doesn't say.
 */
export type DeclaredResult = (
  grant: string,
  operation: string,
) => Shape | null | undefined;

// The most a value of `shape` can count as, under the caps.
const shapeSize = (shape: Shape | null, caps: FuelCaps): number => {
  if (!shape) {
    return 8;
  }
  switch (shape.k) {
    case 'optional':
      return Math.max(8, shapeSize(shape.of, caps));
    case 'oneOf':
      return Math.max(...shape.of.map(s => shapeSize(s, caps)));
    case 'object':
      return 16;
    case 'quantity':
    case 'unitKind':
      return 24;
    case 'kind': {
      const sizes: Record<string, number> = {
        boolean: 8,
        bytes: 16 + caps.bytes,
        integer: 16,
        nothing: 8,
        number: 16,
        text: 16 + 4 * caps.text,
      };
      return sizes[shape.kind] ?? sizeCap(caps);
    }
    default:
      return sizeCap(caps);
  }
};

/** A Fuel Bound, or every reason it has none. */
export type FuelBound =
  | { fuel: number; kind: 'bounded' }
  | { kind: 'unbounded'; reasons: FuelTerm[] };

/**
 * Each body's Fuel Bound under `caps`, but the initialiser's, in the order
 * `estimateFuel` gives their estimates.
 */
export const boundFuel = (
  code: FuelCode,
  caps: FuelCaps = defaultFuelCaps,
  declared: DeclaredFuel = () => undefined,
  results: DeclaredResult = () => undefined,
): FuelBound[] => {
  const estimator = new Estimator(declared, caps, results);
  const bodies = code.unit.bodies;
  return bodies
    .filter(body => body.kind !== 'init')
    .map(body => {
      const bound = estimator.bound(code, body);
      // A message reaches a clause after trying each clause before it.
      const tried = bodies.filter(
        b =>
          b.kind === 'handler' && b.name === body.name && b.index <= body.index,
      ).length;
      return bound.kind === 'bounded'
        ? { ...bound, fuel: bound.fuel + clauseFuel * tried }
        : bound;
    });
};

// The cap on the logical size of any value: the [[size]] table's largest
// scalar, text or Bytes, as items of collections whose items all count
// against the collection cap, with a header for each container.
const sizeCap = ({ bytes, collection, text }: FuelCaps) =>
  (collection + 1) * 16 + collection * (8 + 16 + Math.max(4 * text, bytes));

class Estimator {
  private readonly done = new Map<Body, FuelEstimate>();
  private readonly active = new Set<Body>();

  private readonly bounds = new Map<Body, FuelBound>();

  constructor(
    private readonly declared: DeclaredFuel,
    private readonly caps: FuelCaps = defaultFuelCaps,
    private readonly results: DeclaredResult = () => undefined,
  ) {}

  bound(code: FuelCode, body: Body): FuelBound {
    const known = this.bounds.get(body);
    if (known) {
      return known;
    }
    this.active.add(body);
    const bound = this.limit(code, body);
    this.active.delete(body);
    this.bounds.set(body, bound);
    return bound;
  }

  /** A term's value under the caps, or undefined if they don't bound it. */
  private capped(
    key: string,
    term: string,
    resultSize?: number,
  ): number | undefined {
    const { bytes, collection, digits, text } = this.caps;
    const parts =
      /^(?:(\d+) \* )?([\da-z]+)(?:\([\da-z]+\))?(?: \/ (\d+))?$/.exec(term);
    if (!parts) {
      return undefined;
    }
    // A comparison at every depth examines at most the largest capped value.
    const compared = Math.max(text, bytes, collection);
    const scanned: Record<string, number> = {
      compare: compared,
      'chunk-get': Math.max(text, collection),
      member: collection * (1 + compared),
      'builtin.min': collection * (1 + compared),
      'builtin.max': collection * (1 + compared),
    };
    const measures: Record<string, number | undefined> = {
      bytes,
      characters: text,
      contents: sizeCap(this.caps),
      digits,
      entries: collection,
      items: collection,
      scalars: text,
      scanned: scanned[key],
      size:
        resultSize !== undefined && term.includes('(result)')
          ? resultSize
          : sizeCap(this.caps),
      utf8: 4 * text,
    };
    const measure = measures[parts[2]!];
    return measure === undefined
      ? undefined
      : Math.ceil((Number(parts[1] ?? 1) * measure) / Number(parts[3] ?? 1));
  }

  /** How many times the loop whose header is `from` can run, if bounded. */
  private iterations(unit: Unit, from: number): number | undefined {
    if (unit.code[from]!.op !== 'next') {
      return undefined;
    }
    const start = unit.code[from - 1]!;
    const before = unit.code[from - 2];
    if (start.op === 'iterate-times') {
      const constant =
        before?.op === 'const'
          ? Number(unit.constants[Number(before.operands[0])])
          : Number.NaN;
      return Number.isSafeInteger(constant)
        ? Math.max(constant, 0)
        : this.caps.times;
    }
    if (start.op !== 'iterate') {
      return undefined;
    }
    // A list of a value's chunks has as many items as the text or Bytes has
    // Characters or bytes.
    if (before?.op === 'property') {
      return String(before.operands[0]).includes('byte')
        ? this.caps.bytes
        : Math.max(this.caps.text, this.caps.collection);
    }
    return this.caps.collection;
  }

  private limit(code: FuelCode, body: Body): FuelBound {
    const unit = code.unit;
    const at = (pc: number): FuelAt => ({
      col: unit.code[pc]!.col,
      line: unit.code[pc]!.line,
      unit: unit.name,
    });
    const reasons: FuelTerm[] = [];
    const weight: number[] = [];
    for (let pc = body.start; pc < body.end; pc++) {
      const { op, operands, rate } = unit.code[pc]!;
      const { fixed, key, open } = fuelRates[rate]!;
      let fuel = fixed;
      for (const term of open) {
        // A declared result Shape caps a Capability result's size further.
        const result = capabilityCalls.has(op)
          ? this.results(String(operands[0]), String(operands[1]))
          : undefined;
        const cost =
          this.known(op, operands, term) ??
          (term === 'declared'
            ? undefined
            : this.capped(
                key,
                term,
                result === undefined ? undefined : shapeSize(result, this.caps),
              ));
        if (cost === undefined) {
          reasons.push({ at: at(pc), key, term });
        } else {
          fuel += cost;
        }
      }
      if (
        op.startsWith('call') &&
        op !== 'call-builtin' &&
        op !== 'call-restricted'
      ) {
        const found = this.callees(code, op, operands);
        const usable =
          typeof found === 'string'
            ? undefined
            : found.bodies.every(([, b]) => !this.active.has(b)) && found;
        if (usable) {
          let most = 0;
          usable.bodies.forEach(([c, b], i) => {
            const callee = this.bound(c, b);
            if (callee.kind === 'unbounded') {
              reasons.push(...callee.reasons);
            } else {
              const dispatch = usable.dispatch ? clauseFuel * (i + 1) : 0;
              most = Math.max(most, callee.fuel + dispatch);
            }
          });
          fuel += most;
        } else {
          const name =
            typeof found === 'string'
              ? found
              : (found.bodies[0]?.[1].name ?? 'a function');
          reasons.push({
            at: at(pc),
            key: 'call',
            term: `the call to ${name}`,
          });
        }
      }
      if (op === 'wait-for' || op === 'wait-for-any') {
        reasons.push({ at: at(pc), key, term: 'its event tests' });
      } else if (op === 'choose-offer') {
        reasons.push({ at: at(pc), key, term: 'the chosen action' });
      }
      weight.push(fuel);
    }
    for (const u of unit.unwind) {
      if (u.kind === 'catch' && body.start <= u.start && u.start < body.end) {
        reasons.push({ at: at(u.start), key: 'unwind', term: '4 * frames' });
      }
    }
    const index = (pc: number) => pc - body.start;
    const { backs, edges, raises } = graphOf(unit, body);
    // Fold loops into their headers, innermost first: a header then costs
    // its own pass for every iteration, nested loops' passes included.
    for (const [from, to] of [...backs].sort(
      (a, b) => a[1] - a[0] - (b[1] - b[0]),
    )) {
      const times = this.iterations(unit, from);
      if (times === undefined) {
        reasons.push({
          at: at(from),
          key: 'loop',
          term: 'a loop with no bound',
        });
        continue;
      }
      const most = new Map([[from, weight[index(from)]!]]);
      for (let pc = from; pc < to; pc++) {
        const here = most.get(pc);
        if (here === undefined) {
          continue;
        }
        for (const t of [...edges[index(pc)]!, ...raises[index(pc)]!]) {
          if (t <= to) {
            most.set(t, Math.max(most.get(t) ?? 0, here + weight[index(t)]!));
          }
        }
      }
      weight[index(from)]! += times * (most.get(to) ?? 0);
    }
    if (reasons.length) {
      return { kind: 'unbounded', reasons };
    }
    const toMax: number[] = [];
    for (let pc = body.end - 1; pc >= body.start; pc--) {
      const i = index(pc);
      const exits = ends.has(unit.code[pc]!.op) && unit.code[pc]!.op !== 'jump';
      toMax[i] =
        weight[i]! +
        Math.max(
          exits
            ? 0
            : Math.max(-Infinity, ...edges[i]!.map(t => toMax[index(t)]!)),
          ...raises[i]!.map(t => toMax[index(t)]!),
        );
    }
    return {
      fuel: Math.max(toMax[0] ?? 0, 0),
      kind: 'bounded',
    };
  }

  body(code: FuelCode, body: Body): FuelEstimate {
    const known = this.done.get(body);
    if (known) {
      return known;
    }
    this.active.add(body);
    const estimate = this.measure(code, body);
    this.active.delete(body);
    this.done.set(body, estimate);
    return estimate;
  }

  /** The bodies a call reaches, or a description of why it can't tell. */
  private callees(
    code: FuelCode,
    op: string,
    operands: readonly unknown[],
  ): { bodies: [FuelCode, Body][]; dispatch: boolean } | string {
    if (op === 'call') {
      const body = code.unit.bodies[Number(operands[0])];
      return body ? { bodies: [[code, body]], dispatch: false } : 'a function';
    }
    if (op === 'call-handler' || op === 'call-handler-wait') {
      const name = String(operands[0]);
      const clauses = code.unit.bodies.filter(
        b => b.kind === 'handler' && b.name === name,
      );
      return clauses.length
        ? { bodies: clauses.map(b => [code, b]), dispatch: true }
        : name;
    }
    if (op === 'call-import') {
      const [library, name] = String(operands[0]).split(':') as [
        string,
        string,
      ];
      const from = code.libraries.get(library);
      const bodies = (from?.unit.bodies ?? []).filter(
        b => b.kind !== 'init' && b.name === name,
      );
      return bodies.length
        ? {
            bodies: bodies.map(b => [from!, b]),
            dispatch: bodies[0]!.kind === 'handler',
          }
        : `${library}:${name}`;
    }
    return 'a Function Value';
  }

  /** A term's Fuel when the instruction itself or the Manifest fixes it. */
  private known(
    op: string,
    operands: readonly unknown[],
    term: string,
  ): number | undefined {
    if (term === 'declared' && capabilityCalls.has(op)) {
      return this.declared(String(operands[0]), String(operands[1]));
    }
    const counted = /^(?:(\d+) \* )?count(?: \/ (\d+))?$/.exec(term);
    const at = countAt[op];
    if (counted && at !== undefined) {
      const factor = Number(counted[1] ?? 1);
      return Math.ceil(
        (factor * Number(operands[at])) / Number(counted[2] ?? 1),
      );
    }
    return undefined;
  }

  private measure(code: FuelCode, body: Body): FuelEstimate {
    const unit = code.unit;
    const at = (pc: number): FuelAt => ({
      col: unit.code[pc]!.col,
      line: unit.code[pc]!.line,
      unit: unit.name,
    });
    const loops: FuelLoop[] = [];
    const terms: FuelTerm[] = [];
    // Each instruction's constant Fuel range: a callee's adds its own.
    const low: number[] = [];
    const high: number[] = [];
    for (let pc = body.start; pc < body.end; pc++) {
      const { op, operands, rate } = unit.code[pc]!;
      const { fixed, key, open } = fuelRates[rate]!;
      let min = fixed;
      let max = fixed;
      for (const term of open) {
        const cost = this.known(op, operands, term);
        if (cost === undefined) {
          terms.push({ at: at(pc), key, term });
        } else {
          min += cost;
          max += cost;
        }
      }
      if (
        op.startsWith('call') &&
        op !== 'call-builtin' &&
        op !== 'call-restricted'
      ) {
        const found = this.callees(code, op, operands);
        const usable =
          typeof found === 'string'
            ? undefined
            : found.bodies.every(([, b]) => !this.active.has(b)) && found;
        if (usable) {
          const each = usable.bodies.map(([c, b], i) => {
            const e = this.body(c, b);
            loops.push(...e.loops);
            terms.push(...e.terms);
            const dispatch = usable.dispatch ? clauseFuel * (i + 1) : 0;
            return { max: e.max + dispatch, min: e.min + dispatch };
          });
          min += Math.min(...each.map(e => e.min));
          max += Math.max(...each.map(e => e.max));
        } else {
          const name =
            typeof found === 'string'
              ? found
              : (found.bodies[0]?.[1].name ?? 'a function');
          terms.push({ at: at(pc), key: 'call', term: `the call to ${name}` });
        }
      }
      // Work the lowering doesn't show: another body's event tests and an
      // offer action reached by transfer.
      if (op === 'wait-for' || op === 'wait-for-any') {
        terms.push({ at: at(pc), key, term: 'its event tests' });
      } else if (op === 'choose-offer') {
        terms.push({ at: at(pc), key, term: 'the chosen action' });
      }
      low.push(min);
      high.push(max);
    }
    const index = (pc: number) => pc - body.start;
    const { backs, edges, raises } = graphOf(unit, body);
    // Catch search charges `unwind` for the frames it leaves, at no
    // instruction's rate.
    for (const u of unit.unwind) {
      if (u.kind === 'catch' && body.start <= u.start && u.start < body.end) {
        terms.push({ at: at(u.start), key: 'unwind', term: '4 * frames' });
      }
    }
    // Cheapest and dearest constant Fuel from each instruction to an exit. A
    // path that only goes round a loop has no exit: it doesn't count.
    const toMin: number[] = [];
    const toMax: number[] = [];
    for (let pc = body.end - 1; pc >= body.start; pc--) {
      const i = index(pc);
      const exits = ends.has(unit.code[pc]!.op) && unit.code[pc]!.op !== 'jump';
      const out = edges[i]!.map(index);
      const caught = raises[i]!.map(index);
      toMin[i] = Math.min(
        low[i]! + (exits ? 0 : Math.min(Infinity, ...out.map(t => toMin[t]!))),
        ...caught.map(t => toMin[t]!),
      );
      toMax[i] =
        high[i]! +
        Math.max(
          exits ? 0 : Math.max(-Infinity, ...out.map(t => toMax[t]!)),
          ...caught.map(t => toMax[t]!),
        );
    }
    for (const [from, to] of backs) {
      const most = new Map([[from, high[index(from)]!]]);
      const least = new Map([[from, low[index(from)]!]]);
      for (let pc = from; pc < to; pc++) {
        const up = most.get(pc);
        const down = least.get(pc);
        if (up === undefined || down === undefined) {
          continue;
        }
        for (const t of edges[index(pc)]!) {
          if (t <= to) {
            most.set(
              t,
              Math.max(most.get(t) ?? -Infinity, up + high[index(t)]!),
            );
            least.set(
              t,
              Math.min(least.get(t) ?? Infinity, down + low[index(t)]!),
            );
          }
        }
      }
      loops.push({
        at: at(from),
        max: most.get(to) ?? 0,
        min: least.get(to) ?? 0,
      });
    }
    return {
      at: at(body.start),
      clause: body.kind === 'handler' ? clauseFuel : 0,
      kind: body.kind,
      loops,
      max: toMax[0] ?? 0,
      min: toMin[0] ?? 0,
      name: body.name,
      terms,
    };
  }
}

const range = (min: number, max: number) =>
  min === max ? `${min}` : `${min}..${max}`;

/**
 * The hover's account of an estimate, naming positions by line. `full` lists
 * every value-dependent term; otherwise a key that recurs is counted, so a
 * large function's hover stays short.
 */
export const fuelText = (
  estimate: FuelEstimate,
  { full = false }: { full?: boolean } = {},
): string => {
  const where = whereIn(estimate.at.unit);
  const lines = [
    `Fuel estimate: ${range(estimate.min, estimate.max)}` +
      (estimate.clause
        ? `, plus ${estimate.clause} per Handler Clause tried`
        : ''),
  ];
  for (const loop of estimate.loops) {
    lines.push(
      `+ ${range(loop.min, loop.max)} per pass of the loop at ${where(loop.at)}`,
    );
  }
  const calls = estimate.terms.filter(t => t.key === 'call');
  const values = estimate.terms.filter(t => t.key !== 'call');
  if (values.length) {
    lines.push(
      `+ more with larger values: ${(full ? listed : counted)(values, where)}`,
    );
  }
  if (calls.length) {
    lines.push(
      `+ calls not counted: ${[
        ...new Set(
          calls.map(
            t => `${t.term.replace(/^the call to /, '')} (${where(t.at)})`,
          ),
        ),
      ].join(', ')}`,
    );
  }
  return lines.join('\n');
};

const whereIn =
  (home: string) =>
  ({ line, unit }: FuelAt) =>
    unit === home ? `line ${line}` : `${unit} line ${line}`;

const listed = (terms: FuelTerm[], where: (at: FuelAt) => string) =>
  [...new Set(terms.map(t => `${t.key} (${where(t.at)})`))].join(', ');

// Each key once, with its lines while there are at most three of them.
const counted = (terms: FuelTerm[], where: (at: FuelAt) => string) => {
  const byKey = new Map<string, string[]>();
  for (const t of terms) {
    const at = where(t.at);
    const seen = byKey.get(t.key) ?? [];
    if (!seen.includes(at)) {
      byKey.set(t.key, [...seen, at]);
    }
  }
  return [...byKey]
    .map(([key, at]) =>
      at.length <= 3 ? `${key} (${at.join(', ')})` : `${key} ×${at.length}`,
    )
    .join(', ');
};

const capsText = ({ bytes, collection, digits, text, times }: FuelCaps) =>
  `text ≤ ${text} Characters, numbers ≤ ${digits} digits, ` +
  `collections ≤ ${collection} items, Bytes ≤ ${bytes.toLocaleString('en')}, ` +
  `repeat n times ≤ ${times}`;

// What makes a bound unbounded, as a phrase: a term names its measure.
const reasonText = ({ key, term }: FuelTerm) => {
  const named: Record<string, string> = {
    '4 * frames': 'catch search',
    'a loop with no bound': 'a loop with no bound',
    declared: `${key}'s undeclared cost`,
    'its event tests': 'event tests',
    'the chosen action': 'an offer action',
  };
  return (
    named[term] ??
    (term === 'steps' && key !== 'join'
      ? 'Text Pattern matching'
      : undefined) ??
    (key === 'call'
      ? term
      : `${key} ${/[a-z]+/.exec(term.replace(/^\d+ \* /, ''))![0]}`)
  );
};

/**
 * The hover's account of a Fuel Bound: the number and the caps it assumes,
 * or unbounded with each reason. With `frame`, the Fuel a Host's Pump spends
 * each frame, a bound over it says how many frames it may spread over.
 */
export const fuelBoundText = (
  bound: FuelBound,
  home: string,
  caps: FuelCaps = defaultFuelCaps,
  frame?: number,
): string => {
  if (bound.kind === 'unbounded') {
    const where = whereIn(home);
    const reasons = [
      ...new Set(bound.reasons.map(t => `${reasonText(t)} at ${where(t.at)}`)),
    ];
    const shown = reasons.slice(0, 5);
    const more = reasons.length - shown.length;
    return `Fuel Bound: unbounded (${shown.join('; ')}${more ? `; ${more} more` : ''})`;
  }
  const fuel = bound.fuel.toLocaleString('en');
  const frames =
    frame && bound.fuel > frame
      ? `, more than one frame's ${frame.toLocaleString('en')} (it may spread over ${Math.ceil(bound.fuel / frame)} frames)`
      : '';
  return `Fuel Bound: ${fuel}${frames}\nwith ${capsText(caps)}`;
};
