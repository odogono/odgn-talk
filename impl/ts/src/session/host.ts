// Chapter 12: the Session Host, an ordinary Host that turns Entries into
// Host Inputs on one Session Script, and prints what comes back. It does no
// I/O of its own: its Environment supplies the Clock and takes the Trace.
import {
  defineCapability,
  shape,
  type Call,
  type CapabilityDef,
  type Grant,
  type Operation,
} from '../capabilities';
import { checkSource } from '../checker';
import { formatInstant, parseInstant } from '../dates';
import {
  HostError,
  LoadError,
  ScriptError,
  type LoadDiagnostic,
} from '../errors';
import {
  newGroup,
  observeRuns,
  restore,
  type Group,
  type Inspection,
  type LimitOverride,
  type Location,
  type Report,
  type RunEvent,
  type Script,
} from '../group';
import { defaultLimits } from '../machine';
import { compileLibrary, type Library } from '../library';
import { textForm, waitNs } from '../operations';
import { parseEntry, parseSource } from '../parser';
import type { SemanticElement } from '../semantic';
import { localeCapability, type LocaleImpl } from '../locale-capability';
import {
  calendarCapability,
  clockCapability,
  consoleCapability,
  type CalendarImpl,
} from '../standard-capabilities';
import type { SyntaxNode } from '../syntax';
import { readDisplay } from '../readers';
import { listValues, map, text, type Value } from '../values';
import { viewSource } from '../view';
import { hostFailure, stubLine, Stubs, type Stub } from './stubs';
import type { TranscriptItem } from './transcript';

export type SessionEnvironment = {
  /**
   * The Host functions of the Standard Capabilities this Host has built in
   * for `:grant`, besides `clock`; each answer is recorded as a `~` line.
   */
  builtIns?: { calendar?: CalendarImpl; locale?: LocaleImpl };
  /** A real Clock reading, in epoch nanoseconds. */
  now(): bigint;
  /** A user Library's source, for `:library` given a path. */
  readFile?(path: string): string;
  /**
   * Receives the session as its Session Transcript records it, item by item:
   * each Entry and Session Command in its recorded form, each real Clock
   * reading before its Pump, each line typed for `read`, and each line printed.
   */
  record?(item: TranscriptItem): void;
  /** Receives each line of the Group's Trace, without its LF. */
  trace?(line: string): void;
  /** Writes a file of `:export`, given a directory. */
  writeFile?(directory: string, file: string, text: string): void;
};

/** What the Session Host waits for before it returns the prompt. */
export type Waiting =
  | { k: 'prompt' }
  /** The Foreground Run waits on `console`'s `read`. */
  | { k: 'read' }
  /** The Foreground Run waits only for a deadline, so the Host sleeps. */
  | { at: bigint; k: 'deadline' };

const NAME = 'session';
/** How many arguments a mock Operation takes, each an Optional `any`. */
export const MOCK_ARGUMENTS = 8;

/** A mock Operation `:mock` defined (chapter 12, Session Commands). */
export type Mock = {
  capability: string;
  mode: 'immediate' | 'suspending' | 'fire-and-forget';
  operation: string;
};
const MODES = new Set<string>(['immediate', 'suspending', 'fire-and-forget']);
// The Standard Capabilities a Session Host may build in, for `:grant`, and
// the binding each takes when `:grant` gives none.
const BUILT_IN = new Set(['clock', 'calendar', 'locale']);
const DEFAULT_BINDING: Record<string, string> = {
  calendar: 'UTC',
  locale: 'und',
};
// The Operations of each Standard Capability the Host answers.
const OPERATIONS: Record<string, readonly string[]> = {
  calendar: ['today', 'now', 'toCivil', 'toInstant', 'offset', 'zone'],
  locale: [
    'compare',
    'rank',
    'upper',
    'lower',
    'numberSymbols',
    'monthNames',
    'dayNames',
    'tag',
  ],
};
const free = (operations: readonly string[]) =>
  Object.fromEntries(operations.map(op => [op, { fuel: 0 }]));
// A user Library's version; replacing one keeps it.
const LIBRARY_VERSION = '1';
// The limits a Delivery may override, by their `ts` names (chapter 12, `:limits`).
const OVERRIDABLE = [
  'fuelPerRun',
  'allocPerRun',
  'maxWaitMs',
  'maxJoin',
] as const;
const NAME_TEXT = /^[\p{L}_][\p{L}\p{N}_]*$/u;

// What `:save` keeps: the Group's save, and the Session Host's own state.
type Saved = {
  bytes: Uint8Array;
  deadline: bigint | undefined;
  declarations: Declaration[];
  expressions: Set<string>;
  implicit: Set<string>;
  lastClock: bigint | null;
  lastEntry: number;
  lastSeg: Map<string, Extract<RunEvent, { k: 'seg' }>>;
  latest: { delivery: string; run?: string } | null;
  limits: LimitOverride;
  placements: Map<string, Placement>;
  stubs: Stubs;
  units: number;
  virtual: bigint | null;
};

// A Library file's source as a Transcript can record it: its lines, each
// ended by an LF.
const librarySource = (file: string): string =>
  file.endsWith('\n') ? file : `${file}\n`;

// A refused Session Command or Entry (chapter 12, Output).
class RefusedError extends Error {}
const refuse = (reason: string): never => {
  throw new RefusedError(reason);
};

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
  private readonly mocks: Mock[] = [];
  // Each Grant `:grant` and `:mock` made, by name, and the Capability it grants.
  private readonly granted = new Map<string, string>();
  // The binding of each Grant `:grant` gave one, by name.
  private readonly bindings = new Map<string, string>();
  private stubs = new Stubs();
  // Mock calls, whose `call` lines print at their `call` records.
  private mockCalls = new Map<string, { args: Value[]; operation: string }>();
  // Suspending mock calls waiting for `:answer` or `:fail`.
  private readonly pending = new Map<string, Call<unknown>>();
  // A virtual Clock's instant, or null for the real Clock.
  private virtual: bigint | null = null;
  // The limit override later Entries are requested with.
  private limits: LimitOverride = {};
  // The latest Entry's Delivery, and its Run once it starts.
  private latest: { delivery: string; run?: string } | null = null;
  // The Session Script's Grants by name, fixed when the session starts.
  private grantsByName: Record<string, Grant<unknown>> = {};
  private declarations0: Record<string, CapabilityDef<unknown>> = {};
  // User Libraries, in the order added: each as added, and as it is now.
  private readonly libraries = new Map<
    string,
    { added: string; library: Library }
  >();
  private readonly saves = new Map<string, Saved>();

  constructor(private readonly env: SessionEnvironment) {}

  /** What the Host waits for before returning the prompt. */
  get waiting(): Waiting {
    return this.state;
  }

  /** The session source: its declarations, in the order entered. */
  get source(): string {
    return this.sessionSource(this.declarations);
  }

  /** Whether the Clock is virtual, so only `:clock` commands move it. */
  get virtualClock(): boolean {
    return this.virtual !== null;
  }

  /** The next deadline a background Pump is due at, if any. */
  get nextDeadline(): bigint | undefined {
    return this.deadline;
  }

  /** The mock Operations, and every Grant by name, the session started with. */
  get grants(): { granted: Record<string, string>; mocks: readonly Mock[] } {
    return { granted: Object.fromEntries(this.granted), mocks: this.mocks };
  }

  /** An Entry or a Session Command. Returns the lines it printed. */
  input(source: string): string[] {
    this.recording = source.replace(/\n+$/, '');
    const out = this.entry(source);
    this.recorded();
    return this.printed(out);
  }

  // The Entry or Session Command, as its Transcript records it, until the
  // Pump it causes or the lines it prints.
  private recording: string | null = null;
  private recorded() {
    if (this.recording !== null) {
      this.env.record?.({ k: 'input', source: this.recording });
      this.recording = null;
    }
  }
  private printed(out: string[]): string[] {
    for (const text of out) {
      this.env.record?.({ k: 'output', text });
    }
    return out;
  }

  private entry(source: string): string[] {
    if (source.startsWith(':')) {
      try {
        return this.command(source);
      } catch (error) {
        if (error instanceof RefusedError) {
          return [`! ${error.message}`];
        }
        throw error;
      }
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
    this.env.record?.({ k: 'read', line });
    pending[1].call.answer(text(line));
    return this.printed(this.pump());
  }

  /** `Inspect()`, which is the Host Input `vars`; null before the session starts. */
  inspect(): Inspection | null {
    return this.group?.inspect() ?? null;
  }

  /** Pumps at a deadline, under a real Clock. */
  tick(): string[] {
    return this.group ? this.printed(this.pump()) : [];
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
    const capabilities = this.mockCapabilities();
    capabilities.set('console', console);
    const granted = new Set(this.granted.values());
    if (granted.has('clock')) {
      capabilities.set('clock', clockCapability({ now: { fuel: 0 } }));
    }
    const { calendar, locale } = this.env.builtIns ?? {};
    if (granted.has('calendar') && calendar) {
      capabilities.set(
        'calendar',
        calendarCapability(
          this.answered(calendar, OPERATIONS.calendar!),
          free(OPERATIONS.calendar!),
        ) as CapabilityDef<unknown>,
      );
    }
    if (granted.has('locale') && locale) {
      capabilities.set(
        'locale',
        localeCapability(
          this.answered(locale, OPERATIONS.locale!),
          free(OPERATIONS.locale!),
        ) as CapabilityDef<unknown>,
      );
    }
    const grants: Record<string, Grant<unknown>> = {
      console: console.grant('all', undefined),
    };
    for (const [name, capability] of this.granted) {
      grants[name] = capabilities
        .get(capability)!
        .grant('all', this.bindings.get(name) ?? DEFAULT_BINDING[capability]);
    }
    this.grantsByName = grants;
    this.declarations0 = Object.fromEntries(capabilities);
    this.group = group;
    this.script = group.load({ name: NAME, source: '', grants });
  }

  // A built-in Capability's Host functions, each answer recorded as the `~`
  // line of its call: its value, or `fail` and its error map, with `{}` for
  // a failure that isn't a Script error.
  private answered<T extends object>(
    impl: T,
    operations: readonly string[],
  ): T {
    const wrapped: Record<string, unknown> = {};
    for (const op of operations) {
      const host = (impl as Record<string, (...a: unknown[]) => Value>)[op]!;
      wrapped[op] = (call: { id: string }, ...args: unknown[]) => {
        let value: Value;
        try {
          value = host.call(impl, call, ...args);
        } catch (error) {
          this.env.record?.({
            k: 'answer',
            call: call.id,
            answer: `fail ${
              error instanceof ScriptError
                ? map([
                    ['code', text(error.code)],
                    ['message', text(error.message)],
                    ...(error.data.kind === 'map' ? error.data.entries() : []),
                  ]).toString()
                : '{}'
            }`,
          });
          throw error;
        }
        this.env.record?.({
          k: 'answer',
          call: call.id,
          answer: value.toString(),
        });
        return value;
      };
    }
    return wrapped as T;
  }

  // What the Library compiler checks a Library's Capability calls against.
  private libraryDeclarations() {
    return Object.fromEntries(
      Object.entries(this.declarations0).map(([name, capability]) => [
        name,
        Object.fromEntries(
          [...capability.operations].map(([operation, op]) => [
            operation,
            { args: op.args ?? [], mode: op.mode },
          ]),
        ),
      ]),
    );
  }

  // Each mocked Capability: its Operations take up to eight arguments, give
  // any result and cost nothing, and each call prints a `call` line.
  private mockCapabilities(): Map<string, CapabilityDef<unknown>> {
    const operations = new Map<string, Record<string, Operation<unknown>>>();
    for (const { capability, operation, mode } of this.mocks) {
      const key = `${capability}.${operation}`;
      const base = {
        args: Array.from({ length: MOCK_ARGUMENTS }, () =>
          shape.optional(shape.any),
        ),
        cost: { fuel: 0 },
      };
      const op: Operation<unknown> =
        mode === 'immediate'
          ? {
              ...base,
              mode,
              result: shape.any,
              do: (call, ...args) => {
                this.mockCalls.set(call.id, { operation: key, args });
                return this.stubs.take(key, call, true);
              },
            }
          : mode === 'suspending'
            ? {
                ...base,
                mode,
                result: shape.any,
                start: (call, ...args) => {
                  this.mockCalls.set(call.id, { operation: key, args });
                  this.pending.set(call.id, call);
                },
              }
            : {
                ...base,
                mode,
                fire: (call, ...args) => {
                  this.mockCalls.set(call.id, { operation: key, args });
                },
              };
      operations.set(capability, {
        ...operations.get(capability),
        [operation]: op,
      });
    }
    return new Map(
      [...operations].map(([name, ops]) => [
        name,
        defineCapability<unknown>(name, ops),
      ]),
    );
  }

  // ------------------------------------------------------------- commands

  private command(source: string): string[] {
    const [, name = '', rest = ''] = /^:(\S*)\s*(.*)$/su.exec(source) ?? [];
    switch (name) {
      case 'grant': {
        const w = rest.trim().split(/\s+/u).filter(Boolean);
        return this.grant(w.length === 3 ? w : words(rest, 2));
      }
      case 'mock':
        return this.mock(words(rest, 2));
      case 'stub':
        this.start();
        return this.stub(rest);
      case 'answer':
      case 'fail':
        this.start();
        return this.settle(name, rest);
      case 'clock':
        this.start();
        return this.clock(rest);
      case 'limits':
        this.start();
        return this.limit(rest);
      case 'cancel':
        this.start();
        return this.cancel(rest);
      case 'save':
        this.start();
        return this.save(words(rest, rest.trim() ? 1 : 0)[0] ?? 'default');
      case 'restore':
        this.start();
        return this.restore(words(rest, rest.trim() ? 1 : 0)[0] ?? 'default');
      case 'library':
        this.start();
        return this.library(rest);
      case 'export':
        this.start();
        return this.export(words(rest, rest.trim() ? 1 : 0)[0]);
      case 'runs':
      case 'mailbox':
      case 'vars':
        if (rest.trim()) {
          refuse('bad arguments');
        }
        this.start();
        return this.inspected(name);
      default:
        return refuse('unknown command');
    }
  }

  private beforeStart() {
    if (this.group) {
      refuse('session started');
    }
  }

  private grant([name, capability, binding]: string[]): string[] {
    this.beforeStart();
    if (
      !NAME_TEXT.test(name!) ||
      name === 'console' ||
      !(
        this.builtIn(capability!) ||
        this.mocks.some(m => m.capability === capability)
      ) ||
      (binding !== undefined && !(capability! in DEFAULT_BINDING))
    ) {
      refuse('bad arguments');
    }
    this.granted.set(name!, capability!);
    if (binding === undefined) {
      this.bindings.delete(name!);
    } else {
      this.bindings.set(name!, binding);
    }
    return [];
  }

  // `clock` is always built in, and `calendar` and `locale` when the
  // environment supplies their Host functions.
  private builtIn(capability: string): boolean {
    return (
      capability === 'clock' ||
      (capability === 'calendar' && Boolean(this.env.builtIns?.calendar)) ||
      (capability === 'locale' && Boolean(this.env.builtIns?.locale))
    );
  }

  private mock([target, mode]: string[]): string[] {
    this.beforeStart();
    const [capability, operation, more] = target!.split('.');
    if (
      more !== undefined ||
      !NAME_TEXT.test(capability ?? '') ||
      !NAME_TEXT.test(operation ?? '') ||
      capability === 'console' ||
      BUILT_IN.has(capability!) ||
      !MODES.has(mode!)
    ) {
      refuse('bad arguments');
    }
    const mock = { capability, operation, mode } as Mock;
    const i = this.mocks.findIndex(
      m => m.capability === capability && m.operation === operation,
    );
    if (i < 0) {
      this.mocks.push(mock);
    } else {
      this.mocks[i] = mock;
    }
    this.granted.set(capability!, capability!);
    return [];
  }

  private stub(rest: string): string[] {
    const [target = '', after = ''] = split(rest);
    const mock = this.mocks.find(
      m => `${m.capability}.${m.operation}` === target,
    );
    if (mock?.mode !== 'immediate') {
      refuse('bad arguments');
    }
    const [word, error] = split(after);
    const stub: Stub =
      word === 'fail'
        ? { charge: 0, error: errorMap(error!) }
        : { charge: 0, value: display(after) };
    this.stubs.add(target, stub);
    this.env.trace?.(stubLine(target, stub));
    return [];
  }

  private settle(how: 'answer' | 'fail', rest: string): string[] {
    const [id = '', value = ''] = split(rest);
    const call = this.pending.get(id);
    const settled =
      how === 'answer' ? display(value) : hostFailure(errorMap(value));
    if (!call || call.signal.aborted) {
      return refuse('no such call');
    }
    this.pending.delete(id);
    if (settled instanceof Error) {
      call.fail(settled);
    } else {
      call.answer(settled);
    }
    return this.pump();
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

  private clock(rest: string): string[] {
    const [word = '', arg = ''] = split(rest);
    if (word === '') {
      return [
        this.virtual === null
          ? `real${this.lastClock === null ? '' : ` ${formatInstant(this.lastClock)}`}`
          : `virtual ${formatInstant(this.virtual)}`,
      ];
    }
    if (word === 'real' && !arg) {
      this.virtual = null;
      return [];
    }
    if (word === 'virtual') {
      let at: bigint;
      try {
        at = arg ? parseInstant(arg) : (this.lastClock ?? this.env.now());
        // A Transcript always records the instant.
        this.recording = `:clock virtual ${formatInstant(at)}`;
      } catch {
        return refuse('bad arguments');
      }
      if (this.lastClock !== null && at < this.lastClock) {
        refuse('clock backwards');
      }
      this.virtual = at;
      return [];
    }
    if (word === 'advance') {
      if (this.virtual === null) {
        refuse('clock is real');
      }
      let ns: bigint;
      try {
        ns = waitNs(display(arg));
      } catch {
        return refuse('bad arguments');
      }
      if (ns < 0n) {
        refuse('bad arguments');
      }
      this.virtual! += ns;
      return this.pump();
    }
    return refuse('bad arguments');
  }

  private limit(rest: string): string[] {
    const w = rest.trim().split(/\s+/u).filter(Boolean);
    if (!w.length) {
      return OVERRIDABLE.map(
        name => `${name} ${this.limits[name] ?? defaultLimits[name]}`,
      );
    }
    if (w.length === 1 && w[0] === 'reset') {
      this.limits = {};
      return [];
    }
    const [name, value] = w as [(typeof OVERRIDABLE)[number], string];
    if (
      w.length !== 2 ||
      !OVERRIDABLE.includes(name) ||
      !/^\d+$/u.test(value)
    ) {
      refuse('bad arguments');
    }
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n > defaultLimits[name]) {
      refuse('invalid value');
    }
    this.limits = { ...this.limits, [name]: n };
    return [];
  }

  private cancel(rest: string): string[] {
    const named = words(rest, rest.trim() ? 1 : 0)[0];
    const run = named ?? this.latest?.run;
    if (!run || !this.lastSeg.has(run)) {
      refuse('no such run');
    }
    this.script!.cancelRun(run!);
    return this.pump();
  }

  // ------------------------------------------------------------- saving

  private save(name: string): string[] {
    const bytes = this.group!.save();
    this.saves.set(name, {
      bytes,
      declarations: [...this.declarations],
      implicit: new Set(this.implicit),
      lastEntry: this.lastEntry,
      units: this.units,
      placements: new Map(this.placements),
      expressions: new Set(this.expressions),
      lastSeg: new Map(this.lastSeg),
      latest: this.latest && { ...this.latest },
      limits: { ...this.limits },
      virtual: this.virtual,
      lastClock: this.lastClock,
      deadline: this.deadline,
      stubs: this.stubs.clone(),
    });
    return [`saved ${name}`];
  }

  // The session's Group is replaced by one restored with RejectMismatch, and
  // every pending call is adopted.
  private restore(name: string): string[] {
    const saved = this.saves.get(name);
    if (!saved) {
      return refuse('no such save');
    }
    let restored: ReturnType<typeof restore>;
    try {
      restored = restore(saved.bytes, {
        name: NAME,
        trace: line => this.env.trace?.(line),
        libraries: [...this.libraries.values()].map(l => l.library),
        grants: (_, grant) => this.grantsByName[grant],
        resolve: () => undefined,
        onMismatch: 'reject',
      });
    } catch (error) {
      if (error instanceof HostError) {
        return refuse(error.code);
      }
      throw error;
    }
    const { group, result } = restored;
    group[observeRuns](e => this.events.push(e));
    this.group = group;
    this.script = group.script(NAME)!;
    this.declarations = [...saved.declarations];
    this.implicit = new Set(saved.implicit);
    this.lastEntry = saved.lastEntry;
    this.units = saved.units;
    this.placements = new Map(saved.placements);
    this.expressions = new Set(saved.expressions);
    this.lastSeg = new Map(saved.lastSeg);
    this.latest = saved.latest && { ...saved.latest };
    this.limits = { ...saved.limits };
    this.virtual = saved.virtual;
    this.lastClock = saved.lastClock;
    this.deadline = saved.deadline;
    this.stubs = saved.stubs.clone();
    this.foreground = null;
    this.state = { k: 'prompt' };
    this.writes.clear();
    this.reads.clear();
    this.pending.clear();
    this.mockCalls.clear();
    for (const call of result.pending) {
      const adopted = group.settle(call.id, { adopt: true })!;
      const run = call.id.slice(0, call.id.lastIndexOf('.'));
      if (call.grant === 'console') {
        this.reads.set(call.id, { call: adopted, run });
      } else {
        this.pending.set(call.id, adopted);
      }
    }
    for (const run of result.discardedRuns) {
      this.lastSeg.delete(run);
    }
    return [
      `restored ${name}`,
      ...result.discardedRuns.map(run => `! discarded ${run}`),
    ];
  }

  // ------------------------------------------------------------- libraries

  // `:library add <name> <path>`, or as a Transcript records it, the
  // Library's source on the lines after `:library add <name>`.
  private library(rest: string): string[] {
    const newline = rest.indexOf('\n');
    const head = newline < 0 ? rest : rest.slice(0, newline);
    const [how, name, path, more] = head.trim().split(/\s+/u);
    if (
      (how !== 'add' && how !== 'replace') ||
      !NAME_TEXT.test(name ?? '') ||
      more !== undefined ||
      newline < 0 === (path === undefined)
    ) {
      refuse('bad arguments');
    }
    let source: string;
    if (newline >= 0) {
      source = `${rest.slice(newline + 1)}\n`;
    } else {
      try {
        source = librarySource(this.env.readFile!(path!));
      } catch {
        return refuse('bad arguments');
      }
      // A Transcript records the Library's source in place of its path.
      this.recording = `:library ${how} ${name}\n${source.slice(0, -1)}`;
    }
    // Known here, so neither reaches the Core.
    const held = this.libraries.get(name!);
    if (how === 'add' && held) {
      refuse('name reused');
    }
    if (how === 'replace' && !held) {
      refuse('library mismatch');
    }
    let library: Library;
    try {
      library = compileLibrary(
        { name: name!, version: LIBRARY_VERSION, source },
        [...this.libraries.values()]
          .filter(l => l.library.name !== name)
          .map(l => l.library),
        this.libraryDeclarations(),
      );
    } catch (error) {
      if (error instanceof LoadError) {
        return error.diagnostics.map(
          d => `! ${d.code} at ${d.unit}:${d.line}:${d.col}`,
        );
      }
      throw error;
    }
    let reports: Report[] = [];
    try {
      if (how === 'add') {
        this.group!.addLibrary(library);
      } else {
        reports = this.group!.replaceLibrary(library, 'carry variables');
      }
    } catch (error) {
      return this.refused(error, { line: 0, col: 0 });
    }
    this.libraries.set(name!, { added: held?.added ?? source, library });
    return this.discarded(reports);
  }

  /** Each user Library as `:library add` gave it, in the order added. */
  get userLibraries(): { name: string; source: string; version: string }[] {
    return [...this.libraries].map(([name, l]) => ({
      name,
      source: l.added,
      version: LIBRARY_VERSION,
    }));
  }

  private export(directory: string | undefined): string[] {
    if (directory === undefined) {
      return lines(this.source).slice(0, -1);
    }
    if (!this.env.writeFile) {
      refuse('bad arguments');
    }
    const files: [string, string][] = [
      ['session.talk', this.source],
      ...[...this.libraries].map(
        ([name, l]) => [`${name}.talk`, l.library.source] as [string, string],
      ),
    ];
    for (const [file, text] of files) {
      this.env.writeFile!(directory, file, text);
    }
    return files.map(([file]) => `wrote ${file}`);
  }

  // `:runs`, `:mailbox` and `:vars` render `Inspect()`, the Host Input `vars`.
  private inspected(what: 'runs' | 'mailbox' | 'vars'): string[] {
    const script = this.group!.inspect().scripts.find(s => s.name === NAME)!;
    if (what === 'vars') {
      return script.vars.map(
        ([name, value]) => `${name} = ${value.toString()}`,
      );
    }
    if (what === 'mailbox') {
      return script.mailbox.map(
        m =>
          `${m.delivery ?? m.from} ${m.message.name} ${listValues(m.message.args ?? []).toString()}`,
      );
    }
    return script.runs.map(r =>
      [
        r.id,
        r.status,
        r.handler,
        ...(r.status === 'suspended'
          ? [
              r.wait,
              ...(r.until === undefined
                ? []
                : ['until', formatInstant(r.until)]),
              ...(r.calls ?? []),
            ]
          : []),
      ].join(' '),
    );
  }

  private discarded(reports: readonly Report[]): string[] {
    const out: string[] = [];
    for (const r of reports) {
      if (r.kind === 'stop') {
        for (const run of r.discardedRuns) {
          out.push(`! discarded ${run}`);
          this.lastSeg.delete(run);
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
    const { id } = this.script!.request({
      name: handler,
      ...(Object.keys(this.limits).length ? { limits: this.limits } : {}),
    });
    this.foreground = { delivery: id };
    this.latest = { delivery: id };
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
    this.recorded();
    const reading = this.virtual ?? this.env.now();
    if (this.virtual === null) {
      this.env.record?.({ k: 'clock', at: reading });
    }
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
        if (this.latest?.delivery === e.delivery) {
          this.latest.run = e.run;
        }
      }
    }
    const out: string[] = [];
    for (const e of this.events) {
      if (e.k === 'seg') {
        this.lastSeg.set(e.run, e);
      } else if (e.k === 'call') {
        const mock = this.mockCalls.get(e.call);
        if (mock) {
          this.mockCalls.delete(e.call);
          out.push(
            `${this.prefix(e.run)}call ${e.call} ${mock.operation} ${listValues(mock.args).toString()}`,
          );
        }
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
    // Under a virtual Clock, a deadline wait returns the prompt at once.
    if (
      this.virtual === null &&
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

// A command's first words, split on spaces, and refused unless exactly `n`.
const words = (rest: string, n: number): string[] => {
  const w = rest.trim().split(/\s+/u).filter(Boolean);
  return w.length === n ? w : refuse('bad arguments');
};

// A command's first word, and the text after it.
const split = (rest: string): [string, string] => {
  const m = /^(\S+)\s*(.*)$/su.exec(rest.trim());
  return m ? [m[1]!, m[2]!] : ['', ''];
};

// A value written in a Session Command, in the display form.
const display = (source: string): Value => {
  try {
    return readDisplay(source);
  } catch {
    return refuse('bad arguments');
  }
};

// An error map in a Session Command, which needs a text `code`.
const errorMap = (source: string): Value => {
  const error = display(source);
  if (error.kind !== 'map' || error.get('code').kind !== 'text') {
    refuse('bad arguments');
  }
  return error;
};
