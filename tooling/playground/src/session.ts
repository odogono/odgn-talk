// The Playground's session: a Session Host and the tabs over it. Everything a
// session prints and records comes from the Session Host (chapter 12); this
// module only decides which Entries and Session Commands to give it, and maps
// debugger positions between tabs and loaded code units. It does no I/O.
import { parseEntry } from '@odgn/northtalk';
import { canvasCapabilities } from '@odgn/northtalk-tooling/canvas';
import type { Value } from '@odgn/northtalk';
import {
  isReadable,
  sourceForm,
  type DebugController,
  type DebugFrame,
  type DebugInstruction,
  type DebugPause,
  type DebugSnapshot,
  type RepeatedEffect,
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
export type PlaygroundEnvironment = Pick<
  SessionEnvironment,
  'builtIns' | 'readStoreFile' | 'writeStoreFile'
> & {
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
  frames: {
    handler?: string;
    line: number;
    locals: string[];
    /** Zero-based index in this displayed (innermost-first) frame list. */
    owner?: number;
    role?: DebugFrame['role'];
    /** Each local's {@link copySource}, in `locals` order. */
    sources: (string | null)[];
    unit: string;
  }[];
  limit?: string;
  line: number;
  reason: DebugPause['reason'];
  /**
   * Live only, while the paused Run can be rewound: Fix and Continue's
   * effects that happen again (ADR 0068).
   */
  repeated?: string[];
  run: string;
  /** The tab and its line, or none for a prompt Entry's own code. */
  tab?: { line: number; name: string };
  unit: string;
  views: {
    mailbox: string[];
    runs: string[];
    /** Each Script Variable's {@link copySource}, in `vars` order. */
    sources: (string | null)[];
    vars: string[];
  };
};

/**
 * A value as a copy action copies it: its source form, or null when it holds a
 * Function Value or Host Object, so it has none (#479).
 */
export const copySource = (value: Value): string | null =>
  isReadable(value) ? sourceForm(value) : null;

/** Script Variables' {@link copySource}, in `renderDebugView` `vars` order. */
export const varSources = (snapshot: DebugSnapshot): (string | null)[] =>
  snapshot.scripts.flatMap(s => s.vars.map(([, value]) => copySource(value)));

/** Frame views shared by the live and replay panels, innermost first. */
export const frameViews = (
  frames: readonly DebugFrame[],
): PauseView['frames'] =>
  [...frames].reverse().map(f => ({
    unit: f.unit,
    line: f.line,
    ...(f.handler ? { handler: f.handler } : {}),
    ...(f.role ? { role: f.role } : {}),
    ...(f.owner === undefined ? {} : { owner: frames.length - 1 - f.owner }),
    locals: f.locals.map(([name, value]) => `${name} = ${value.toString()}`),
    sources: f.locals.map(([, value]) => copySource(value)),
  }));

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
    }
  /** Fix and Continue entered `:fix` at a pause (ADR 0072). */
  | { kind: 'fixed'; lines: string[] };

/** An effect Fix and Continue makes happen again, as the panel lists it. */
const repeatedText = (e: RepeatedEffect): string =>
  e.kind === 'call'
    ? `call ${e.op} (${e.id})`
    : `send ${e.message ?? 'a message'} to ${e.to}`;

/** Do it, print it or inspect it: what running a selection shows. */
export type SelectionAction = 'do' | 'print' | 'inspect';

// A selection's lines without the indentation they all share.
const dedent = (source: string): string => {
  const lines = source.split('\n');
  const indent = Math.min(
    ...lines.filter(l => l.trim()).map(l => /^[ \t]*/u.exec(l)![0].length),
  );
  return lines.map(l => l.slice(Math.min(indent, l.length))).join('\n');
};

const SETUP = /^:(grant|mock)\b/u;
const refusedOrDiagnostic = (lines: readonly string[]) =>
  lines.some(l => l.startsWith('! ') && !l.startsWith('! discarded'));
const libraryCommand = (how: 'add' | 'replace', library: Library) =>
  `:library ${how} ${library.name}\n${library.source.replace(/\n+$/u, '')}`;

// The page's Store slots, as `:store load` and `:store save` name them.
const storeFiles = (env: PlaygroundEnvironment) => ({
  ...(env.readStoreFile ? { readStoreFile: env.readStoreFile } : {}),
  ...(env.writeStoreFile ? { writeStoreFile: env.writeStoreFile } : {}),
});

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
        capabilities: canvasCapabilities,
        ...storeFiles(env),
        ...(env.builtIns ? { builtIns: env.builtIns } : {}),
        record: item => this.transcript.push(item),
        result: (run, value) => this.echoed(run, value),
        transcriptEnds: dropped => this.endTranscript(dropped),
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
      capabilities: canvasCapabilities,
      trace: line => (session ? session.trace : trace).push(line),
      live: {
        now: () => session!.now(),
        ...storeFiles(env),
        ...(env.builtIns ? { builtIns: env.builtIns } : {}),
        record: item => session!.transcript.push(item),
        result: (run, value) => session!.echoed(run, value),
        transcriptEnds: dropped => session!.endTranscript(dropped),
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

  private endTranscript(dropped: number) {
    this.transcriptEnd ??= this.transcript.length - dropped;
  }

  /** A real Clock reading less the time the debugger held the session paused. */
  private now(): bigint {
    return this.env.now() - this.pausedNs;
  }

  get started(): boolean {
    return this.host.started;
  }

  /** The Session Transcript: up to a Fix and Continue made at a pause. */
  get transcriptText(): string {
    return writeTranscript(
      this.transcript.slice(0, this.transcriptEnd ?? this.transcript.length),
    );
  }

  /** Whether `source` is an unfinished Entry, so the prompt goes on at `|`. */
  incomplete(source: string): boolean {
    return this.host.incomplete(source);
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

  // ------------------------------------------------------------- selections

  // Each selection run so far: its input item in the Transcript, its Run
  // while it goes on in the background, and the Run that echoes its value.
  private readonly selections: { at: number; echo?: string; run?: string }[] =
    [];
  // The values the latest Runs echoed, oldest first, for copy actions.
  private readonly results = new Map<string, Value>();
  private latestResult: Value | null = null;

  private echoed(run: string, value: Value) {
    this.results.delete(run);
    this.results.set(run, value);
    if (this.results.size > 64) {
      this.results.delete(this.results.keys().next().value!);
    }
    this.latestResult = value;
  }

  /**
   * The latest echoed value's {@link copySource}, or undefined before any
   * Entry has echoed one.
   */
  get latestCopy(): string | null | undefined {
    return this.latestResult ? copySource(this.latestResult) : undefined;
  }

  /** A selection's echoed value's {@link copySource}, once it has one. */
  copyOf(selection: number): string | null | undefined {
    const echo = this.selections[selection]?.echo;
    const value = echo ? this.results.get(echo) : undefined;
    return value ? copySource(value) : undefined;
  }

  /**
   * Runs a tab's selection against the live session as an ordinary Entry, or
   * as `:inspect` for inspect it. A declaration selected in the Script tab is
   * entered like one at the prompt, so it applies; a Library tab's
   * declarations load only by saving the tab. Returns the selection's number,
   * for {@link printedBy}, or why it was refused without an Entry.
   */
  runSelection(
    selected: string,
    how: SelectionAction,
    tab: string = SESSION_TAB,
  ): { selection: number } | { refused: string } {
    const source = dedent(selected.replace(/^\s*\n/u, '').replace(/\s+$/u, ''));
    if (!source.trim()) {
      return { refused: 'Select an expression, a statement or a declaration.' };
    }
    if (source.trimStart().startsWith(':')) {
      return {
        refused: 'A selection runs as an Entry, not a Session Command.',
      };
    }
    if (this.incomplete(source)) {
      return { refused: 'The selection is not a complete Entry.' };
    }
    const parsed = tab === SESSION_TAB ? null : parseEntry(source, () => false);
    if (parsed && !parsed.error && parsed.kind === 'declaration') {
      return {
        refused: `Save the ${tab} tab to load its declarations.`,
      };
    }
    const entry = how === 'inspect' ? `:inspect ${source}` : source;
    const from = this.transcript.length;
    const before = this.host.latestRun;
    this.input(entry);
    const at = this.transcript.findIndex(
      (item, i) => i >= from && item.k === 'input' && item.source === entry,
    );
    const run = this.host.latestRun;
    const own = run !== before && run ? run : undefined;
    this.selections.push({
      at: at < 0 ? from : at,
      ...(own ? { echo: own } : {}),
      ...(how !== 'inspect' && own ? { run: own } : {}),
    });
    return { selection: this.selections.length - 1 };
  }

  /**
   * What a selection's Entry has printed so far: the lines that follow it
   * while it keeps the prompt, and its Run's lines once that goes on in the
   * background, without their `[<run>] `.
   */
  printedBy(selection: number): string[] {
    const { at, run } = this.selections[selection]!;
    const out: string[] = [];
    let foreground = true;
    for (const item of this.transcript.slice(at + 1)) {
      if (item.k === 'input') {
        foreground = false;
      } else if (item.k === 'output') {
        const background = /^\[([^\]]+)\] (.*)$/su.exec(item.text);
        if (background) {
          if (background[1] === run) {
            out.push(background[2]!);
          }
        } else if (foreground) {
          out.push(item.text);
        }
      }
    }
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

  /**
   * Fix and Continue at a pause (ADR 0072): enters `:fix` of the paused Run
   * with the Script tab's new and changed declarations, so its message runs
   * again on them. The Transcript ends before the Host call that paused.
   */
  fix(script: string): ApplyResult {
    const pause = this.pauseView();
    if (!pause?.repeated) {
      throw new Error('Fix and Continue needs a pause in a Run it can rewind');
    }
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
    if (!plan.enter.length) {
      return { kind: 'fixed', lines: [] };
    }
    const lines = this.host.input(
      `:fix ${pause.run}\n${plan.enter.map(d => d.source).join('\n')}`,
    );
    // The Reload replaced the code the breakpoints were bound to.
    this.syncBreakpoints();
    this.settled();
    return { kind: 'fixed', lines };
  }

  // How many items of `transcript` the Session Transcript keeps, once a Fix
  // and Continue at a pause has ended it (ADR 0072).
  private transcriptEnd: number | null = null;

  /** The Transcript stops at a Fix and Continue made at a pause (ADR 0072). */
  get transcriptEnded(): boolean {
    return this.transcriptEnd !== null;
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

  /** Stage a fresh session; a failed load never replaces the live session. */
  prepareFresh(tabs: Tabs): {
    result: ApplyResult;
    session: PlaygroundSession | null;
  } {
    const next = this.restart(tabs);
    if (refusedOrDiagnostic(next.lines)) {
      return {
        session: null,
        result: { kind: 'syntax', error: next.lines.join('; ') },
      };
    }
    const ok =
      next.result.kind === 'applied' &&
      !next.result.failed.length &&
      !next.result.pending;
    return { session: ok ? next.session : null, result: next.result };
  }

  // Asks the old session for its state; what it prints is dropped with it.
  private peek(command: string): string[] {
    const length = this.transcript.length;
    try {
      return this.host.input(command);
    } finally {
      this.transcript.length = length;
    }
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
      ...(run?.rewindable ? { repeated: run.repeated.map(repeatedText) } : {}),
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
        sources: varSources(snapshot),
      },
      frames: frameViews(run?.frames ?? []),
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
