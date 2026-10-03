// The Playground's session: a Session Host and the tabs over it. Everything a
// session prints and records comes from the Session Host (chapter 12); this
// module only decides which Entries and Session Commands to give it, and maps
// debugger positions between tabs and loaded code units. It does no I/O.
import { parseEntry, type Value } from '@odgn/northtalk';
import type {
  DebugController,
  DebugInstruction,
  DebugPause,
} from '@odgn/northtalk/debug';
import {
  replayTranscript,
  SessionHost,
  writeTranscript,
  parseTranscript,
  type DebugAction,
  type SessionEnvironment,
  type TranscriptItem,
} from '@odgn/northtalk/session';
import { sessionSetup, type Setup } from '@odgn/northtalk/replay';
import { renderDebugView } from '@odgn/northtalk-tooling/debug';
import {
  planApply,
  splitDeclarations,
  type TabDeclaration,
} from './declarations';

export const SESSION_TAB = 'session';

export type Library = { name: string; source: string };
export type Tabs = { libraries: Library[]; script: string };

/** The Playground Host's Clock and built-in Capabilities. */
export type PlaygroundEnvironment = Pick<SessionEnvironment, 'builtIns'> & {
  /** Milliseconds from a monotonic clock, for subtracting paused time. */
  monotonic(): number;
  now(): bigint;
};

/** A breakpoint on a tab line, from 1. */
export type TabBreakpoint = { line: number; tab: string };
export type Faults = { error: boolean; limitFault: boolean };

/** Where a debug pause is, shown against the tabs when it falls in one. */
export type PauseView = {
  error?: string;
  frames: { handler?: string; line: number; locals: string[]; unit: string }[];
  limit?: string;
  line: number;
  reason: DebugPause['reason'];
  run: string;
  /** The tab and its line, or none for a prompt Entry's own code. */
  tab?: { line: number; name: string };
  unit: string;
  views: { mailbox: string[]; runs: string[]; vars: string[] };
};

export type ApplyResult =
  | { error: string; kind: 'syntax' }
  /** The tab dropped declarations, which only a Restart removes. */
  | { kind: 'restart'; removed: string[] }
  | {
      /** Declarations that would not load, with what the Session Host printed. */
      failed: { key: string; lines: string[] }[];
      kind: 'applied';
      lines: string[];
      /** Declarations left when a debugger paused the session part way. */
      pending: number;
    };

const SETUP = /^:(grant|mock)\b/u;
const refusedOrDiagnostic = (lines: readonly string[]) =>
  lines.some(l => l.startsWith('! ') && !l.startsWith('! discarded'));
const libraryCommand = (how: 'add' | 'replace', library: Library) =>
  `:library ${how} ${library.name}\n${library.source.replace(/\n+$/u, '')}`;

export class PlaygroundSession {
  readonly host: SessionHost;
  /** The session's Session Transcript so far. */
  readonly transcript: TranscriptItem[] = [];
  /** The Group's Trace so far. */
  readonly trace: string[] = [];
  /** The `:grant` and `:mock` commands the session started with. */
  readonly setup: string[] = [];
  // Each user Library's source as last added or replaced.
  private readonly libraries = new Map<string, string>();
  private breakpoints: TabBreakpoint[] = [];
  private faults: Faults = { error: false, limitFault: false };
  private pausedNs = 0n;
  private pausedSince: number | null = null;
  // The tab sources the last breakpoint sync saw, for mapping positions back.
  private tabs: Tabs = { script: '', libraries: [] };

  constructor(
    private readonly env: PlaygroundEnvironment,
    host?: SessionHost,
  ) {
    this.host =
      host ??
      new SessionHost({
        now: () => this.now(),
        ...(env.builtIns ? { builtIns: env.builtIns } : {}),
        record: item => this.transcript.push(item),
        trace: line => this.trace.push(line),
      });
  }

  /**
   * Opens a shared Transcript: replays it with its recorded readings and
   * answers, then goes on live. A replay that prints differently never goes
   * live; its first differing line is returned instead.
   */
  static replay(
    env: PlaygroundEnvironment,
    text: string,
  ):
    | { session: PlaygroundSession }
    | {
        difference: { actual: string; expected: string; line: number };
        /** What did replay, for replay debugging. */
        setup: Setup;
        trace: string[];
      } {
    const recorded = parseTranscript(text);
    const trace: string[] = [];
    let session: PlaygroundSession | null = null;
    const { host, items } = replayTranscript(recorded, {
      trace: line => (session ? session.trace : trace).push(line),
      live: {
        now: () => session!.now(),
        ...(env.builtIns ? { builtIns: env.builtIns } : {}),
        record: item => session!.transcript.push(item),
      },
    });
    const expected = writeTranscript(recorded).split('\n');
    const actual = writeTranscript(items).split('\n');
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      if (expected[i] !== actual[i]) {
        return {
          difference: {
            line: i + 1,
            expected: expected[i] ?? '(end of the Transcript)',
            actual: actual[i] ?? '(end of the Transcript)',
          },
          setup: sessionSetup(host),
          trace,
        };
      }
    }
    session = new PlaygroundSession(env, host);
    session.transcript.push(...items);
    session.trace.push(...trace);
    for (const item of items) {
      if (item.k === 'input') {
        session.noteInput(item.source, []);
      }
    }
    return { session };
  }

  /** A real Clock reading less the time the debugger held the session paused. */
  private now(): bigint {
    return this.env.now() - this.pausedNs;
  }

  get started(): boolean {
    return this.host.started;
  }

  get transcriptText(): string {
    return writeTranscript(this.transcript);
  }

  /** Whether `source` is an unfinished Entry, so the prompt goes on at `|`. */
  static incomplete(source: string): boolean {
    const parsed = parseEntry(source, () => false);
    return Boolean(parsed.error && parsed.incomplete);
  }

  // ------------------------------------------------------------- input

  input(source: string): string[] {
    const out = this.host.input(source);
    this.noteInput(source, out);
    this.settled();
    return out;
  }

  private noteInput(source: string, out: readonly string[]) {
    if (SETUP.test(source) && !refusedOrDiagnostic(out)) {
      this.setup.push(source);
    }
    const library = /^:library (add|replace) (\S+)\n/u.exec(source);
    if (library && !refusedOrDiagnostic(out)) {
      this.libraries.set(library[2]!, `${source.slice(library[0].length)}\n`);
    }
  }

  read(line: string): string[] {
    const out = this.host.read(line);
    this.settled();
    return out;
  }

  tick(): string[] {
    const out = this.host.tick();
    this.settled();
    return out;
  }

  // ------------------------------------------------------------- tabs

  /** Enters each new or changed declaration of the Script tab (ADR 0051). */
  apply(script: string): ApplyResult {
    const tab = splitDeclarations(script);
    if (tab.error) {
      return {
        kind: 'syntax',
        error: `${tab.error.code} at ${tab.error.line}:${tab.error.col}`,
      };
    }
    const plan = planApply(tab.declarations, this.sessionDeclarations());
    if (plan.removed.length) {
      return { kind: 'restart', removed: plan.removed.map(d => d.key) };
    }
    return this.enter(plan.enter);
  }

  // Enters declarations, retrying any that fail while others still load, so
  // a declaration may use one later in the tab.
  private enter(declarations: readonly TabDeclaration[]): ApplyResult {
    const lines: string[] = [];
    let pending = [...declarations];
    let failed: { key: string; lines: string[] }[] = [];
    for (;;) {
      failed = [];
      const left: TabDeclaration[] = [];
      for (const [i, d] of pending.entries()) {
        if (this.host.waiting.k === 'paused') {
          left.push(...pending.slice(i));
          break;
        }
        const out = this.input(d.source);
        lines.push(...out.map(l => l));
        if (this.has(d)) {
          continue;
        }
        failed.push({ key: d.key, lines: out });
        left.push(d);
      }
      if (this.host.waiting.k === 'paused') {
        return { kind: 'applied', lines, failed: [], pending: left.length };
      }
      if (!left.length || left.length === pending.length) {
        return { kind: 'applied', lines, failed, pending: 0 };
      }
      pending = left;
    }
  }

  private has(d: TabDeclaration): boolean {
    return this.sessionDeclarations().some(
      s => s.key === d.key && s.source === d.source,
    );
  }

  private sessionDeclarations(): TabDeclaration[] {
    const split = splitDeclarations(this.host.source);
    return split.error ? [] : split.declarations;
  }

  /** Saving a Library tab: `:library add` the first time, then `replace`. */
  saveLibrary(library: Library): string[] {
    const held = this.libraries.get(library.name);
    const source = `${library.source.replace(/\n+$/u, '')}\n`;
    if (held === source) {
      return [];
    }
    return this.input(
      libraryCommand(held === undefined ? 'add' : 'replace', library),
    );
  }

  /** The user Libraries the session has, as last saved. */
  get savedLibraries(): Library[] {
    return [...this.libraries].map(([name, source]) => ({ name, source }));
  }

  /**
   * A Restart: a fresh session with the setup commands, the Clock and limits
   * this one has, each Library tab added, and the Script tab applied.
   */
  restart(tabs: Tabs): {
    lines: string[];
    result: ApplyResult;
    session: PlaygroundSession;
  } {
    if (this.paused) {
      throw new Error('A paused session cannot restart');
    }
    const next = new PlaygroundSession(this.env);
    const lines: string[] = [];
    for (const command of this.setup) {
      lines.push(...next.input(command));
    }
    if (this.host.started) {
      const [clock] = this.peek(':clock');
      if (clock?.startsWith('virtual ')) {
        lines.push(...next.input(`:clock ${clock}`));
      }
      const defaults = new Set(
        new SessionHost({ now: () => 0n }).input(':limits'),
      );
      for (const limit of this.peek(':limits')) {
        if (!defaults.has(limit)) {
          lines.push(...next.input(`:limits ${limit}`));
        }
      }
    }
    for (const library of tabs.libraries) {
      lines.push(...next.saveLibrary(library));
    }
    next.breakpoints = this.breakpoints;
    next.faults = this.faults;
    const result = next.apply(tabs.script);
    next.syncBreakpoints(tabs);
    return { session: next, lines, result };
  }

  // Asks the old session for its state; what it prints is dropped with it.
  private peek(command: string): string[] {
    return this.host.input(command);
  }

  // ------------------------------------------------------------- debugging

  get paused(): boolean {
    return this.host.waiting.k === 'paused';
  }

  setBreakpoints(breakpoints: TabBreakpoint[], faults: Faults, tabs: Tabs) {
    this.breakpoints = breakpoints;
    this.faults = faults;
    this.syncBreakpoints(tabs);
  }

  private resolved: { line: number; tab: string; verified: boolean }[] = [];

  /** Each breakpoint, and whether it maps to loaded code. */
  get breakpointStatus(): { line: number; tab: string; verified: boolean }[] {
    return this.resolved;
  }

  /** Resolves tab breakpoints against the code loaded now. */
  syncBreakpoints(
    tabs: Tabs = this.tabs,
  ): { line: number; tab: string; verified: boolean }[] {
    this.tabs = tabs;
    const wanted =
      this.breakpoints.length > 0 ||
      this.faults.error ||
      this.faults.limitFault;
    const controller = wanted ? this.host.debugController() : null;
    if (!controller) {
      this.resolved = this.breakpoints.map(b => ({ ...b, verified: false }));
      return this.resolved;
    }
    const sources = controller.sources();
    const resolved = this.breakpoints.map(b => {
      const at = this.unitPosition(b);
      const source = at && sources.find(s => s.unit.name === at.unit);
      const pc = source?.unit.code.findIndex(i => i.line === at!.line) ?? -1;
      return {
        ...b,
        verified: pc >= 0,
        instruction:
          pc >= 0 ? ({ pc, unit: at!.unit } as DebugInstruction) : null,
      };
    });
    controller.breakAt(
      resolved.flatMap(r => (r.instruction ? [r.instruction] : [])),
    );
    controller.pauseOn(this.faults);
    this.resolved = resolved.map(({ line, tab, verified }) => ({
      line,
      tab,
      verified,
    }));
    return this.resolved;
  }

  // A tab line's code unit and line, for a Library tab or a Script tab whose
  // declaration is loaded as the tab has it.
  private unitPosition(
    b: TabBreakpoint,
  ): { line: number; unit: string } | null {
    if (b.tab !== SESSION_TAB) {
      const library = this.tabs.libraries.find(l => l.name === b.tab);
      return library &&
        this.libraries.get(b.tab) === `${library.source.replace(/\n+$/u, '')}\n`
        ? { unit: b.tab, line: b.line }
        : null;
    }
    const tab = declarationLines(this.tabs.script);
    const declaration = tab.find(
      d => b.line >= d.line && b.line < d.line + d.lines,
    );
    if (!declaration) {
      return null;
    }
    const placed = this.placedDeclarations().find(
      p => p.key === declaration.key && p.source === declaration.source,
    );
    return placed
      ? {
          unit: placed.unit,
          line: placed.unitLine + (b.line - declaration.line),
        }
      : null;
  }

  private placedDeclarations() {
    const placements = this.host.placementsOfSource;
    const declarations = this.sessionDeclarations();
    return declarations.length === placements.length
      ? declarations.map((d, i) => ({ ...d, ...placements[i]! }))
      : [];
  }

  // A code unit's line, as a tab's line.
  private tabPosition(
    unit: string,
    line: number,
  ): { line: number; name: string } | undefined {
    if (this.libraries.has(unit)) {
      return { name: unit, line };
    }
    const placed = this.placedDeclarations().find(
      p => p.unit === unit && line >= p.unitLine && line < p.unitLine + p.lines,
    );
    const tab =
      placed &&
      declarationLines(this.tabs.script).find(
        d => d.key === placed.key && d.source === placed.source,
      );
    return tab && placed
      ? { name: SESSION_TAB, line: tab.line + (line - placed.unitLine) }
      : undefined;
  }

  /** The current pause, with its views, or null. */
  pauseView(): PauseView | null {
    const controller: DebugController | null = this.paused
      ? this.host.debugController()
      : null;
    const pause = controller?.current;
    if (!controller || !pause) {
      return null;
    }
    const snapshot = controller.snapshot();
    const run = snapshot.scripts
      .flatMap(s => s.runs)
      .find(r => r.id === pause.run);
    const tab = this.tabPosition(pause.unit, pause.line);
    return {
      reason: pause.reason,
      run: pause.run,
      unit: pause.unit,
      line: pause.line,
      ...(tab ? { tab } : {}),
      ...(pause.error ? { error: pause.error.toString() } : {}),
      ...(pause.limit ? { limit: pause.limit } : {}),
      views: {
        runs: renderDebugView(snapshot, 'runs'),
        mailbox: renderDebugView(snapshot, 'mailbox'),
        vars: renderDebugView(snapshot, 'vars'),
      },
      frames: [...(run?.frames ?? [])].reverse().map(f => ({
        unit: f.unit,
        line: f.line,
        ...(f.handler ? { handler: f.handler } : {}),
        locals: f.locals.map(
          ([name, value]: [string, Value]) => `${name} = ${value.toString()}`,
        ),
      })),
    };
  }

  /** Continues a paused Pump; its lines print once it completes. */
  continueDebug(action: DebugAction): string[] {
    if (this.pausedSince !== null) {
      this.pausedNs += BigInt(
        Math.floor((this.env.monotonic() - this.pausedSince) * 1_000_000),
      );
      this.pausedSince = null;
    }
    const out = this.host.continueDebug(action);
    this.settled();
    return out;
  }

  // After each Host call: note a new pause, and rebind breakpoints to code a
  // declaration, Reload or restore may have replaced.
  private settled() {
    if (this.paused) {
      this.pausedSince ??= this.env.monotonic();
    } else {
      this.syncBreakpoints();
    }
  }
}

/** Each declaration of a tab with its first line and line count. */
export const declarationLines = (
  source: string,
): (TabDeclaration & { line: number; lines: number })[] => {
  const split = splitDeclarations(source);
  if (split.error) {
    return [];
  }
  const out: (TabDeclaration & { line: number; lines: number })[] = [];
  let from = 0;
  for (const d of split.declarations) {
    const at = source.indexOf(d.source, from);
    if (at < 0) {
      return [];
    }
    out.push({
      ...d,
      line: source.slice(0, at).split('\n').length,
      lines: d.source.split('\n').length,
    });
    from = at + d.source.length;
  }
  return out;
};
