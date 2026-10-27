// A static Fuel estimate for each body of a compiled Script or Library (#1606).
// It is advisory: the Cost Model charges a Run, and this only reads the
// lowering. Each instruction's Fuel formula splits into a constant and the
// terms that measure values; a body gets the constant Fuel of its cheapest and
// dearest paths to an exit, and of one pass of each loop. Calls to bodies it
// can see add their callee's bounds, and Capability calls add the Host
// Manifest's declared cost.
import type { CodeUnit } from '@northtalk/ts';
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

class Estimator {
  private readonly done = new Map<Body, FuelEstimate>();
  private readonly active = new Set<Body>();

  constructor(private readonly declared: DeclaredFuel) {}

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
    // An Error raised in a catch, finally or guard range goes to its target.
    // The raising instruction may not have paid, so the edge leaves before it.
    const raises: number[][] = [];
    for (let pc = body.start; pc < body.end; pc++) {
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
    // Catch search charges `unwind` for the frames it leaves, at no
    // instruction's rate.
    for (const u of unit.unwind) {
      if (u.kind === 'catch' && body.start <= u.start && u.start < body.end) {
        terms.push({ at: at(u.start), key: 'unwind', term: '4 * frames' });
      }
    }
    // Forward edges only: a backward edge closes a loop.
    const edges: number[][] = [];
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

/** The hover's account of an estimate, naming positions by line. */
export const fuelText = (estimate: FuelEstimate): string => {
  const where = ({ line, unit }: FuelAt) =>
    unit === estimate.at.unit ? `line ${line}` : `${unit} line ${line}`;
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
  const listed = (terms: FuelTerm[]) => [
    ...new Set(terms.map(t => `${t.key} (${where(t.at)})`)),
  ];
  const calls = estimate.terms.filter(t => t.key === 'call');
  const values = listed(estimate.terms.filter(t => t.key !== 'call'));
  if (values.length) {
    lines.push(`+ more with larger values: ${values.join(', ')}`);
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
