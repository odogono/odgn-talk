// Chapter 12: the Session Host, an ordinary Host that turns Entries into
// Host Inputs on one Session Script, and prints what comes back. It does no
// I/O of its own: its Environment supplies the Clock and takes the Trace.
import type { Call } from '../capabilities';
import { checkSource } from '../checker';
import { HostError, LoadError, type LoadDiagnostic } from '../errors';
import {
  newGroup,
  observeRuns,
  type Group,
  type Location,
  type Report,
  type RunEvent,
  type Script,
} from '../group';
import { textForm } from '../operations';
import { parseEntry, parseSource } from '../parser';
import type { SemanticElement } from '../semantic';
import { consoleCapability } from '../standard-capabilities';
import type { SyntaxNode } from '../syntax';
import { listValues, map, text, type Value } from '../values';
import { viewSource } from '../view';

export type SessionEnvironment = {
  /** A real Clock reading, in epoch nanoseconds. */
  now(): bigint;
  /** Receives each line of the Group's Trace, without its LF. */
  trace?(line: string): void;
};

/** What the Session Host waits for before it returns the prompt. */
export type Waiting =
  | { k: 'prompt' }
  /** The Foreground Run waits on `console`'s `read`. */
  | { k: 'read' }
  /** The Foreground Run waits only for a deadline, so the Host sleeps. */
  | { at: bigint; k: 'deadline' };

const NAME = 'session';

// One declaration of the session source, with the names it declares.
type Declaration = {
  kind: 'use' | 'handler' | 'function' | 'constant' | 'variable';
  /** For a `use` line: its Library, and each imported name with its local name. */
  library?: string;
  names: string[];
  source: string;
  uses?: { local: string; name: string }[];
};

// Where an Entry's lines sit in the code unit made for it.
type Placement = { col: number; line: number };

const lineCount = (source: string) => source.split('\n').length;
const lines = (t: string) => t.split(/\r\n|\n|\r/);
const nodes = (node: SyntaxNode) =>
  node.children.filter((c): c is SyntaxNode => c.kind === 'node');

/** A Session Host for one session (chapter 12). */
export class SessionHost {
  private group: Group | null = null;
  private script: Script | null = null;
  private declarations: Declaration[] = [];
  // The implicit Handlers the Script still has, until a Reload drops them.
  private implicit = new Set<string>();
  private lastEntry = 0;
  private lastClock: bigint | null = null;
  // Code units made for statement and expression Entries.
  private placements = new Map<string, Placement>();
  private expressions = new Set<string>(); // deliveries of expression Entries
  private foreground: { delivery: string; run?: string } | null = null;
  private lastSeg = new Map<string, Extract<RunEvent, { k: 'seg' }>>();
  private writes = new Map<string, Value>();
  private reads = new Map<string, { call: Call<unknown>; run?: string }>();
  private events: RunEvent[] = [];
  private state: Waiting = { k: 'prompt' };
  // The Script's code units: an extension is named after their count.
  private units = 1;
  private deadline: bigint | undefined;

  constructor(private readonly env: SessionEnvironment) {}

  /** What the Host waits for before returning the prompt. */
  get waiting(): Waiting {
    return this.state;
  }

  /** The session source: its declarations, in the order entered. */
  get source(): string {
    return this.sessionSource(this.declarations);
  }

  /** The next deadline a background Pump is due at, if any. */
  get nextDeadline(): bigint | undefined {
    return this.deadline;
  }

  /** An Entry or a Session Command. Returns the lines it printed. */
  input(source: string): string[] {
    if (source.startsWith(':')) {
      return ['! unknown command'];
    }
    this.start();
    const parsed = parseEntry(source, name => this.isHandler(name));
    if (parsed.error) {
      const t = parsed.error.tok;
      return [`! ${parsed.error.code} at ${t.line}:${t.col}`];
    }
    if (parsed.kind === null) {
      return [];
    }
    if (parsed.kind === 'declaration') {
      return this.declare(source.replace(/\n+$/, ''));
    }
    return this.run(source.replace(/\n+$/, ''), parsed.kind === 'expression')
      .out;
  }

  /** Answers the Foreground Run's `read` with a line the user typed. */
  read(line: string): string[] {
    const pending = [...this.reads].find(
      ([, r]) => r.run !== undefined && r.run === this.foreground?.run,
    );
    if (!pending) {
      return [];
    }
    this.reads.delete(pending[0]);
    pending[1].call.answer(text(line));
    return this.pump();
  }

  /** Pumps at a deadline, under a real Clock. */
  tick(): string[] {
    return this.group ? this.pump() : [];
  }

  // ------------------------------------------------------------- starting

  private start() {
    if (this.group) {
      return;
    }
    const group = newGroup({
      name: NAME,
      trace: line => this.env.trace?.(line),
    });
    group[observeRuns](e => this.events.push(e));
    const console = consoleCapability(
      {
        write: (call, value) => {
          this.writes.set(call.id, value);
        },
        read: call => {
          this.reads.set(call.id, { call });
        },
      },
      { write: { fuel: 0 }, read: { fuel: 0 } },
    );
    this.group = group;
    this.script = group.load({
      name: NAME,
      source: '',
      grants: { console: console.grant('all', undefined) },
    });
  }

  // ------------------------------------------------------------- names

  private isHandler(name: string): boolean {
    return (
      this.implicit.has(name) ||
      this.declarations.some(d => d.kind === 'handler' && d.names[0] === name)
    );
  }

  private has(name: string): boolean {
    return (
      this.implicit.has(name) ||
      this.declarations.some(d => d.names.includes(name))
    );
  }

  private sessionSource(declarations: readonly Declaration[]): string {
    return declarations.map(d => `${d.source}\n`).join('');
  }

  // ------------------------------------------------------------- declarations

  private declare(source: string): string[] {
    const decl = describe(source);
    if (!decl.names.some(n => this.has(n))) {
      try {
        this.script!.extend(source);
      } catch (error) {
        return this.refused(error, { line: 0, col: 0 });
      }
      this.units++;
      this.declarations.push(decl);
      return [];
    }
    if (
      decl.kind === 'variable' &&
      this.declarations.some(
        d => d.kind === 'variable' && d.names[0] === decl.names[0],
      )
    ) {
      return this.redeclareVariable(source, decl);
    }
    return this.redefine(decl);
  }

  // `script variable x = e` for an `x` the Script has: the initialiser
  // changes in the session source, and `put e into x` runs as an Entry.
  private redeclareVariable(source: string, decl: Declaration): string[] {
    const name = decl.names[0]!;
    const tree = parseSource(source).tree!;
    const declaration = nodes(tree)[0]!;
    const init = nodes(declaration).find(n => n.rule === 'Expression');
    const statement = init
      ? `put ${source.slice(init.start, init.end)} into ${name}`
      : `put nothing into ${name}`;
    const index = this.declarations.findIndex(
      d => d.kind === 'variable' && d.names[0] === name,
    );
    const before = this.declarations;
    this.declarations = before.map((d, i) => (i === index ? decl : d));
    const { loaded, out } = this.run(statement, false);
    if (!loaded) {
      this.declarations = before;
    }
    return out;
  }

  private redefine(decl: Declaration): string[] {
    const next: Declaration[] = [];
    let placed = false;
    for (const d of this.declarations) {
      const reused = d.names.filter(n => decl.names.includes(n));
      if (!reused.length) {
        next.push(d);
      } else if (d.kind === 'use') {
        const left = d.uses!.filter(u => !reused.includes(u.local));
        if (left.length) {
          next.push(usesDeclaration(d.library!, left));
        }
      } else if (!placed && decl.kind !== 'use') {
        next.push(decl);
        placed = true;
      }
    }
    if (!placed) {
      next.push(decl);
    }
    const start = next.indexOf(decl);
    const line = next
      .slice(0, start)
      .reduce((n, d) => n + lineCount(d.source), 0);
    let reports: Report[];
    try {
      reports = this.script!.reload(
        this.sessionSource(next),
        'carry variables',
      );
    } catch (error) {
      return this.refused(error, { line, col: 0 }, lineCount(decl.source));
    }
    this.declarations = next;
    this.implicit.clear();
    this.placements.clear();
    this.units = 1;
    // The Reload discarded every Run, and every deadline with them.
    this.deadline = undefined;
    return this.discarded(reports);
  }

  private discarded(reports: readonly Report[]): string[] {
    const out: string[] = [];
    for (const r of reports) {
      if (r.kind === 'stop') {
        for (const run of r.discardedRuns) {
          out.push(`! discarded ${run}`);
          if (this.foreground?.run === run) {
            this.foreground = null;
            this.state = { k: 'prompt' };
          }
        }
      }
    }
    return out;
  }

  // A rejected Entry: each diagnostic in the Entry's own lines, where it
  // falls in them, and a refused one's Host error code.
  private refused(error: unknown, at: Placement, length = Infinity): string[] {
    if (error instanceof LoadError) {
      return error.diagnostics.map(
        d => `! ${d.code} at ${where(d, at, length)}`,
      );
    }
    if (error instanceof HostError) {
      return [`! ${error.code}`];
    }
    throw error;
  }

  // ------------------------------------------------------------- statements

  private run(
    source: string,
    expression: boolean,
  ): { loaded: boolean; out: string[] } {
    let n = this.lastEntry + 1;
    while (this.has(`entry${n}`)) {
      n++;
    }
    const handler = `entry${n}`;
    const bound = this.implicitVariables(source, handler);
    const body = lines(source);
    if (expression) {
      body[0] = `return ${body[0]}`;
    }
    const unit = [
      ...bound.map(v => `script variable ${v}`),
      `on ${handler}`,
      ...body,
      `end ${handler}`,
    ]
      .map(l => `${l}\n`)
      .join('');
    const placement = {
      line: bound.length + 1,
      col: expression ? 'return '.length : 0,
    };
    try {
      this.script!.extend(unit);
    } catch (error) {
      return {
        loaded: false,
        out: this.refused(error, placement, body.length),
      };
    }
    this.lastEntry = n;
    this.implicit.add(handler);
    this.placements.set(`${NAME}+${this.units++}`, placement);
    for (const v of bound) {
      this.declarations.push({
        kind: 'variable',
        names: [v],
        source: `script variable ${v}`,
      });
    }
    const { id } = this.script!.request({ name: handler });
    this.foreground = { delivery: id };
    if (expression) {
      this.expressions.add(id);
    }
    return { loaded: true, out: this.pump() };
  }

  // Each name the Entry puts into, or binds with a Capture, outside its
  // Lambdas, that the Script doesn't have, in the order it first binds them.
  // A pattern's names stay the Run's locals, since a pattern may not bind a
  // Script Variable.
  private implicitVariables(source: string, handler: string): string[] {
    const probe = `${this.source}on ${handler}\n${source}\nend ${handler}\n`;
    const checked = checkSource(probe);
    if (!checked.tree) {
      return [];
    }
    const scope = checked.tree.scopes
      .filter(s => s.kind === 'handler' && s.parent === 0)
      .at(-1);
    const sites = new Map<number, { first: number; pattern: boolean }>();
    const pending: SemanticElement[] = [checked.tree.root];
    while (pending.length) {
      const e = pending.pop()!;
      if (e.kind === 'node') {
        pending.push(...e.children);
      } else if (
        e.kind === 'name' &&
        e.binding?.kind === 'local' &&
        e.binding.scope === scope?.id
      ) {
        const site = sites.get(e.binding.id) ?? {
          first: Infinity,
          pattern: false,
        };
        if (e.role === 'binding') {
          site.pattern = true;
        } else if (e.role === 'write' || e.role === 'capture') {
          site.first = Math.min(site.first, e.span.start);
        }
        sites.set(e.binding.id, site);
      }
    }
    return (scope?.bindings ?? [])
      .filter(b => {
        const site = sites.get(b.id);
        return site && !site.pattern && site.first < Infinity;
      })
      .sort((a, b) => sites.get(a.id)!.first - sites.get(b.id)!.first)
      .map(b => b.name);
  }

  // ------------------------------------------------------------- pumping

  private pump(): string[] {
    const reading = this.env.now();
    const now =
      this.lastClock !== null && reading < this.lastClock
        ? this.lastClock
        : reading;
    this.lastClock = now;
    this.events = [];
    const result = this.group!.pump(now);
    this.deadline = result.nextDeadline;
    const out = this.print(result.reports);
    this.settleForeground();
    return out;
  }

  private print(reports: readonly Report[]): string[] {
    const ends = new Map<string, Extract<Report, { kind: 'run end' }>>();
    for (const r of reports) {
      if (r.kind === 'run end' && r.run) {
        ends.set(r.run, r);
      }
    }
    // A Run's calls come before the record of the stretch that made them.
    for (const e of this.events) {
      if (e.k === 'seg' && e.delivery) {
        if (this.foreground?.delivery === e.delivery) {
          this.foreground.run = e.run;
        }
      }
    }
    const out: string[] = [];
    for (const e of this.events) {
      if (e.k === 'seg') {
        this.lastSeg.set(e.run, e);
      } else if (e.k === 'call') {
        const written = this.writes.get(e.call);
        if (written) {
          this.writes.delete(e.call);
          out.push(
            ...lines(textForm(written)).map(l => this.prefix(e.run) + l),
          );
        }
        const read = this.reads.get(e.call);
        if (read) {
          read.run = e.run;
        }
      } else if (e.k === 'unhandled') {
        out.push(
          `${e.run ? this.prefix(e.run) : ''}! unhandled ${e.message} ${listValues(e.args).toString()}`,
        );
      } else {
        this.lastSeg.delete(e.run);
        const line = this.ended(e, ends.get(e.run));
        if (line !== null) {
          out.push(this.prefix(e.run) + line);
        }
        if (e.delivery) {
          this.expressions.delete(e.delivery);
        }
      }
    }
    return out;
  }

  private ended(
    e: Extract<RunEvent, { k: 'run' }>,
    report: Extract<Report, { kind: 'run end' }> | undefined,
  ): string | null {
    switch (e.outcome) {
      case 'completed':
        return e.delivery && this.expressions.has(e.delivery)
          ? (report?.result?.toString() ?? 'nothing')
          : null;
      case 'errored': {
        const error = map(
          e.error!.entries().filter(([k]) => k !== 'message' && k !== 'at'),
        );
        return `! error ${error.toString()} at ${this.where(report?.at)}`;
      }
      case 'limit-fault':
        return `! limit fault ${report?.limit} at ${this.where(report?.at)}`;
      case 'cancelled':
        return '! cancelled';
      default:
        return null;
    }
  }

  private where(at: Location | undefined): string {
    if (!at) {
      return '?';
    }
    const placement = this.placements.get(at.unit);
    return placement
      ? where(at, placement, Infinity)
      : `${at.unit}:${at.line}:${at.col}`;
  }

  // A Run's lines are printed plainly while the Host keeps the prompt for it.
  private prefix(run: string): string {
    return this.foreground?.run === run ? '' : `[${run}] `;
  }

  // After a Pump, the Host keeps the prompt while the Foreground Run waits
  // on `read`, or only for a deadline; otherwise it goes on in the
  // background.
  private settleForeground() {
    const run = this.foreground?.run;
    if (!run || !this.lastSeg.has(run)) {
      this.foreground = null;
      this.state = { k: 'prompt' };
      return;
    }
    if ([...this.reads.values()].some(r => r.run === run)) {
      this.state = { k: 'read' };
      return;
    }
    const seg = this.lastSeg.get(run)!;
    if (
      ['wait', 'wait-for', 'wait-for-any'].includes(seg.end) &&
      seg.calls.length === 0 &&
      seg.until !== undefined
    ) {
      this.state = { k: 'deadline', at: seg.until };
      return;
    }
    this.foreground = null;
    this.state = { k: 'prompt' };
  }
}

// An Entry's declaration, with the names it declares.
const describe = (source: string): Declaration => {
  const checked = checkSource(source);
  const decl = viewSource(checked.tree!.root)[0]!;
  if (decl.k === 'use') {
    const uses = decl.imports.map(i => ({ local: i.local.text, name: i.name }));
    return {
      kind: 'use',
      library: decl.library,
      names: uses.map(u => u.local),
      uses,
      source,
    };
  }
  if (decl.k === 'handler' || decl.k === 'function') {
    return { kind: decl.k, names: [decl.name], source };
  }
  return { kind: decl.k, names: [decl.name.text], source };
};

const usesDeclaration = (
  library: string,
  uses: { local: string; name: string }[],
): Declaration => ({
  kind: 'use',
  library,
  names: uses.map(u => u.local),
  uses,
  source:
    uses.length === 1 && uses[0]!.local !== uses[0]!.name
      ? `use ${uses[0]!.name} from ${library} as ${uses[0]!.local}`
      : `use ${uses.map(u => u.name).join(', ')} from ${library}`,
});

// A position in a code unit, in the Entry's own lines where it falls in them.
const where = (
  at: Pick<LoadDiagnostic, 'line' | 'col' | 'unit'>,
  placement: Placement,
  length: number,
): string => {
  const line = at.line - placement.line;
  if (line < 1 || line > length) {
    return `${at.unit}:${at.line}:${at.col}`;
  }
  const col = line === 1 ? Math.max(1, at.col - placement.col) : at.col;
  return `${line}:${col}`;
};
