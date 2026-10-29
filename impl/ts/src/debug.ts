// TS tooling state lives outside machine state and never enters a save.
import type { CodeUnit, Instruction } from './code-unit';
import type { Inspection, Location, PumpResult } from './group';
import type { LimitName, Run } from './machine';
import type { Value } from './values';

export const statementStarts = new WeakSet<Instruction>();
export type DebugInstruction = {
  pc: number;
  run?: string;
  script?: string;
  unit?: string;
};
export type DebugPause = Location & {
  error?: Value;
  hostInputIndex?: number;
  limit?: LimitName;
  reason: 'breakpoint' | 'step' | 'error' | 'limitFault' | 'replay';
  run: string;
  script: string;
};
export type DebugFrame = Location & {
  locals: [string, Value][];
  /** Zero-based index of the shared-local owner in this Run's frame view. */
  owner?: number;
  role?: 'retained' | 'dispatch';
};
/** An effect a Rewind leaves done, so it happens again (ADR 0068). */
export type RepeatedEffect =
  | { id: string; kind: 'call'; op: string }
  | { kind: 'send'; message?: string; to: string };
export type DebugSnapshot = Omit<Inspection, 'scripts'> & {
  scripts: (Omit<Inspection['scripts'][number], 'runs'> & {
    runs: (Inspection['scripts'][number]['runs'][number] & {
      frames: DebugFrame[];
      fuel: number;
      /** Effects so far that a Rewind would repeat; empty unless rewindable. */
      repeated: RepeatedEffect[];
      /** It hasn't passed a Suspension Point, so it can be rewound. */
      rewindable: boolean;
      segment: number;
    })[];
  })[];
};
/**
 * What `evaluate` gave: the body's result, or why it failed. A failure to
 * compile gives each diagnostic's line in the body, from 1.
 */
export type DebugEvaluation =
  { error: string; line?: number } | { value: Value };
export type DebugSource = {
  script?: string;
  statements: number[];
  unit: CodeUnit;
};
type Fault = {
  error?: Value;
  limit?: LimitName;
  reason: 'error' | 'limitFault';
  /** No catch or guard covers the error, so it will end the Run. */
  uncaught?: boolean;
};
type MachineDebug = {
  fault: Fault | null;
  pending: (() => void) | null;
  wants(fault: Fault): boolean;
};
export const machineDebug = new WeakMap<Run, MachineDebug>();
export const deferFault = (
  run: Run,
  fault: Fault,
  continueRun: () => void,
): boolean => {
  const state = machineDebug.get(run);
  if (!state?.wants(fault)) {
    return false;
  }
  state.fault = fault;
  state.pending = continueRun;
  return true;
};

/** Tooling only; chapter 9's embedding declarations do not expose this API. */
export class DebugController {
  paused: ((pause: DebugPause) => void) | null = null;
  private breaks = new Map<number, DebugInstruction[]>();
  private faults = { error: false, limitFault: false, uncaughtError: false };
  private stepping: {
    depth: number;
    mode: 'in' | 'over' | 'out';
    run: string;
  } | null = null;
  private parents = new Map<string, string>();
  private landing: {
    /** Its pc fell inside a hold, so it lands once the hold closes. */
    deferred?: boolean;
    hostInputIndex: number;
    pc: DebugInstruction;
  } | null = null;
  /** Pause at the next Run of this Script to start, once (Fix and Continue). */
  private restart: string | null = null;
  private readonly seen = new WeakSet<Run>();
  private pause: DebugPause | null = null;
  private pauseDepth = 0;
  private notifying = false;
  private since = 0;
  private elapsed = 0;

  constructor(
    private readonly read: () => DebugSnapshot,
    private readonly advance: () => PumpResult,
    private readonly readSources: () => DebugSource[],
    private readonly evaluateIn: (
      body: string,
      frame: number | undefined,
    ) => DebugEvaluation,
  ) {}
  /** Detached lowerings of the code actually loaded, including extensions. */
  sources(): DebugSource[] {
    return this.readSources();
  }
  get isPaused(): boolean {
    return this.pause !== null;
  }
  get current(): DebugPause | null {
    return this.pause ? { ...this.pause } : null;
  }
  breakAt(instructions: readonly DebugInstruction[]): void {
    this.breaks.clear();
    for (const instruction of instructions) {
      const entries = this.breaks.get(instruction.pc) ?? [];
      entries.push({ ...instruction });
      this.breaks.set(instruction.pc, entries);
    }
  }
  clearBreaks(): void {
    this.breaks.clear();
  }
  /**
   * Pause before a raised error unwinds (`error`), only before one no catch
   * or guard covers (`uncaughtError`), or before a Limit Fault. A catch
   * whose tests all decline still counts as covering, so `uncaughtError`
   * can miss an error such a catch lets past, but never stops at one that
   * is caught.
   */
  pauseOn(options: {
    error?: boolean;
    limitFault?: boolean;
    uncaughtError?: boolean;
  }): void {
    this.faults = {
      error: options.error ?? false,
      limitFault: options.limitFault ?? false,
      uncaughtError: options.uncaughtError ?? false,
    };
  }
  snapshot(): DebugSnapshot {
    if (!this.pause) {
      throw new Error('The Group is not debug-paused');
    }
    return this.read();
  }
  /**
   * Runs a Handler body in the paused Run's Script, where Script Variables
   * read and write as in any of its Handlers, and the named locals of the
   * paused Run's frame `frame` (an index into its snapshot's frames, the
   * innermost by default) read as parameters but can't be assigned. The body
   * runs at once, alone, and writes no Trace: a send, wait, random draw or
   * Operation call fails it, as does running out of Fuel.
   */
  evaluate(body: string, frame?: number): DebugEvaluation {
    if (!this.pause) {
      throw new Error('The Group is not debug-paused');
    }
    return this.evaluateIn(body, frame);
  }
  pausedTime(): number {
    return this.elapsed + (this.pause ? performance.now() - this.since : 0);
  }
  resume(): PumpResult {
    this.assertCanContinue();
    this.stepping = null;
    return this.continue();
  }
  step(): PumpResult {
    return this.stepped('in');
  }
  stepOver(): PumpResult {
    return this.stepped('over');
  }
  stepOut(): PumpResult {
    return this.stepped('out');
  }
  /** Pause, as a step, at the first instruction of the Script's next new Run. */
  pauseAtNextStart(script: string): void {
    this.restart = script;
  }
  landAt(hostInputIndex: number, pc: DebugInstruction | number): void {
    if (typeof pc === 'number') {
      pc = { pc };
    }
    if (
      !Number.isSafeInteger(hostInputIndex) ||
      hostInputIndex < 0 ||
      !Number.isSafeInteger(pc.pc) ||
      pc.pc < 0
    ) {
      throw new Error('Invalid replay landing');
    }
    this.landing = { hostInputIndex, pc: { ...pc } };
  }
  private stepped(mode: 'in' | 'over' | 'out'): PumpResult {
    this.assertCanContinue();
    const pause = this.pause;
    if (!pause) {
      throw new Error('The Group is not debug-paused');
    }
    const parent = this.parents.get(pause.run);
    this.stepping =
      mode === 'out' && this.pauseDepth === 1 && parent
        ? { mode: 'over', run: parent, depth: Infinity }
        : { mode, run: pause.run, depth: this.pauseDepth };
    return this.continue();
  }
  private assertCanContinue(): void {
    if (this.notifying) {
      throw new Error('Debug resume is a reentrant call');
    }
    if (!this.pause) {
      throw new Error('The Group is not debug-paused');
    }
  }
  private continue(): PumpResult {
    this.assertCanContinue();
    this.elapsed += performance.now() - this.since;
    this.pause = null;
    return this.advance();
  }
  /** Internal scheduler integration. */
  attach(run: Run, from: string | null): void {
    if (from) {
      this.parents.set(run.id, from.replace(/\.c\d+$/, ''));
    }
    if (!machineDebug.has(run)) {
      machineDebug.set(run, {
        fault: null,
        pending: null,
        wants: f =>
          this.faults[f.reason] ||
          (f.reason === 'error' &&
            f.uncaught === true &&
            this.faults.uncaughtError),
      });
    }
  }
  ended(run: Run): void {
    this.parents.delete(run.id);
    machineDebug.delete(run);
    if (this.stepping?.run === run.id) {
      this.stepping = null;
    }
  }
  boundary(run: Run, script: string): DebugPause | null {
    const frame = run.frames.at(-1);
    if (!frame) {
      return null;
    }
    const ins = frame.code.unit.code[frame.pc]!;
    // A catch dispatch holds its failed callees aside, so the frames are
    // the control path.
    const depth = run.frames.length;
    const matches = (at: DebugInstruction) =>
      (!at.unit || at.unit === frame.code.name) &&
      at.pc === frame.pc &&
      (!at.run || at.run === run.id) &&
      (!at.script || at.script === script);
    const fault = machineDebug.get(run)?.fault;
    let reason: DebugPause['reason'] | null = fault?.reason ?? null;
    let landingIndex: number | undefined;
    // A set's hold is one landing unit (ADR 0135): nothing pauses inside it,
    // so no queued input lands between its Get and its Set, and a replay
    // landing recorded inside one waits for the hold to close.
    if (!reason && run.holding) {
      if (this.landing && matches(this.landing.pc)) {
        this.landing.deferred = true;
      }
      return null;
    }
    if (
      !reason &&
      this.landing &&
      (this.landing.deferred || matches(this.landing.pc))
    ) {
      reason = 'replay';
      landingIndex = this.landing.hostInputIndex;
      this.landing = null;
    }
    if (!reason && (this.breaks.get(frame.pc) ?? []).some(matches)) {
      reason = 'breakpoint';
    }
    const fresh = !this.seen.has(run);
    this.seen.add(run);
    if (this.restart === script && fresh) {
      this.restart = null;
      reason ??= 'step';
    }
    const step = this.stepping;
    let follows = run.id === step?.run;
    for (
      let parent = this.parents.get(run.id);
      parent && !follows;
      parent = this.parents.get(parent)
    ) {
      follows = parent === step?.run;
    }
    if (
      !reason &&
      step &&
      !run.resumingInstruction &&
      statementStarts.has(ins) &&
      ((step.mode === 'in' && follows) ||
        (step.run === run.id &&
          (step.mode === 'over' ? depth <= step.depth : depth < step.depth)))
    ) {
      reason = 'step';
    }
    if (!reason) {
      return null;
    }
    this.pauseDepth = depth;
    return {
      reason,
      run: run.id,
      script,
      unit: frame.code.name,
      handler: frame.handler,
      pc: frame.pc,
      line: ins.line,
      col: ins.col,
      ...(fault?.error ? { error: fault.error } : {}),
      ...(fault?.limit ? { limit: fault.limit } : {}),
      ...(landingIndex === undefined ? {} : { hostInputIndex: landingIndex }),
    };
  }
  enter(pause: DebugPause): void {
    this.pause = pause;
    this.since = performance.now();
    this.stepping = null;
    this.notifying = true;
    try {
      this.paused?.({ ...pause });
    } finally {
      this.notifying = false;
    }
  }
}
