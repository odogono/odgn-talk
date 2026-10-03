import {
  formatInstant,
  list,
  type CodeUnit,
  type Group,
  type PumpOptions,
  type PumpResult,
} from '@odgn/northtalk';
import type {
  DebugController,
  DebugInstruction,
  DebugPause,
  DebugSnapshot,
  DebugSource,
} from '@odgn/northtalk/debug';
import {
  replayTrace,
  same,
  type ReplayAction,
  type ReplayEvent,
  type Setup,
} from '@odgn/northtalk/replay';
export type { Setup as ReplaySetup } from '@odgn/northtalk/replay';

export type SourceBreakpoint = {
  col?: number;
  /** One-based source positions, as in the Core source map. */
  line: number;
  run?: string;
  script?: string;
  unit: string;
};
export type ResolvedBreakpoint = SourceBreakpoint & {
  instruction?: DebugInstruction;
  verified: boolean;
};
/** A paused result is provisional: the retained Pump has not completed. */
export type DebugResult = PumpResult | { pause: DebugPause; state: 'paused' };
export type ReplayResult =
  | { pause: DebugPause; state: 'paused' }
  | { applied?: boolean; hostInputIndex: number; state: 'input' }
  | { state: 'ended' };

/** Recorded Host only: rewind constructs a fresh Group and never calls a live Host. */
export class ReplayDebugger {
  private driver!: Generator<ReplayEvent, string[], ReplayAction | undefined>;
  private event: ReplayEvent | null = null;
  private debug: LiveDebugger | null = null;
  private group: Group | null = null;
  private loadedSources: DebugSource[] = [];
  private output: string[] = [];
  private breaks: SourceBreakpoint[] = [];
  private faults = { error: false, limitFault: false };
  private scanning = false;
  private ended = false;
  private readonly lines: string[];
  private readonly setup: Setup;
  private readonly sources = new Map<string, string>();
  private inputIndex = 0;
  private completedReports: PumpResult['reports'] = [];
  readonly hostInputCount: number;

  constructor(
    setup: Setup,
    trace: string | readonly string[],
    readSource?: (file: string) => string,
  ) {
    this.setup = structuredClone(setup);
    this.lines = typeof trace === 'string' ? trace.split('\n') : [...trace];
    this.hostInputCount = this.lines.filter(l => l.startsWith('> ')).length;
    for (const s of [
      ...(this.setup.scripts ?? []),
      ...(this.setup.libraries ?? []),
    ]) {
      if (s.text === undefined) {
        if (!readSource) {
          throw new Error(`Missing source ${s.source}`);
        }
        s.text = readSource(s.source);
      }
      this.sources.set(s.source, s.text);
    }
    this.restart();
  }
  get trace(): string[] {
    return [...this.output];
  }
  get reports(): PumpResult['reports'] {
    return [...this.completedReports];
  }
  get hostInputIndex(): number {
    return this.inputIndex;
  }
  get isPaused(): boolean {
    return this.event?.state === 'paused';
  }
  get current(): DebugPause | null {
    return this.event?.state === 'paused' ? { ...this.event.pause } : null;
  }
  snapshot(): DebugSnapshot {
    if (!this.isPaused) {
      throw new Error('The Group is not debug-paused');
    }
    return this.debug!.snapshot();
  }
  setBreakpoints(
    breakpoints: readonly SourceBreakpoint[],
  ): ResolvedBreakpoint[] {
    // Use the same validation and resolution as live mode, even before Load.
    const resolved = this.debug!.setBreakpoints(breakpoints);
    this.breaks = breakpoints.map(b => ({ ...b }));
    this.configure();
    return resolved;
  }
  clearBreakpoints(): void {
    this.setBreakpoints([]);
  }
  pauseOn(options: { error?: boolean; limitFault?: boolean }): void {
    this.faults = {
      error: options.error ?? false,
      limitFault: options.limitFault ?? false,
    };
    this.configure();
  }
  resume(): ReplayResult {
    return this.advance('resume');
  }
  step(): ReplayResult {
    return this.forward('step');
  }
  stepOver(): ReplayResult {
    return this.forward('stepOver');
  }
  stepOut(): ReplayResult {
    return this.forward('stepOut');
  }

  /** Stop before a zero-based Host Input; seeking backwards replays from the start. */
  runToHostInput(index: number): ReplayResult {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.hostInputCount
    ) {
      throw new Error('Host Input index is out of range');
    }
    this.restart();
    for (;;) {
      const event = this.event;
      if (!event) {
        throw new Error('Host Input was not reached');
      }
      if (
        (event.state === 'input' ||
          (event.state === 'paused' &&
            event.pause.hostInputIndex !== undefined)) &&
        (event.state === 'paused'
          ? event.pause.hostInputIndex
          : event.hostInputIndex) === index
      ) {
        this.inputIndex = index;
        return event.state === 'paused'
          ? { state: 'paused', pause: event.pause }
          : {
              state: 'input',
              hostInputIndex: index,
              ...(event.applied ? { applied: true } : {}),
            };
      }
      this.next();
    }
  }

  /** Previous statement in execution order, reconstructed without a recording. */
  reverseStep(): ReplayResult {
    if (!this.hostInputCount) {
      return { state: 'ended' };
    }
    const target = this.isPaused ? this.position() : null;
    if (!target && !this.ended) {
      throw new Error('Reverse step requires a pause or the end of the Trace');
    }
    this.scanning = true;
    this.restart();
    let previous: string | null = null;
    for (;;) {
      const event = this.next();
      if (!event) {
        break;
      }
      if (event.state !== 'paused') {
        continue;
      }
      const position = this.position();
      if (position === target) {
        break;
      }
      const p = event.pause;
      if (
        this.loadedSources.some(
          s => s.unit.name === p.unit && s.statements.includes(p.pc),
        )
      ) {
        previous = position;
      }
    }
    this.restart();
    if (!previous) {
      this.scanning = false;
      this.configure();
      return this.runToHostInput(0);
    }
    for (;;) {
      const event = this.next();
      if (!event) {
        throw new Error('Reverse statement was not reached');
      }
      if (event.state === 'paused' && this.position() === previous) {
        this.scanning = false;
        this.configure();
        return { state: 'paused', pause: event.pause };
      }
    }
  }

  private position(): string {
    const p = this.current!;
    const run = this.snapshot()
      .scripts.flatMap(s => s.runs)
      .find(r => r.id === p.run)!;
    return JSON.stringify([
      this.output.length,
      p.run,
      p.unit,
      p.pc,
      run.fuel,
      p.error?.toString(),
      p.limit,
    ]);
  }
  private forward(action: ReplayAction): ReplayResult {
    if (!this.isPaused) {
      throw new Error('The Group is not debug-paused');
    }
    return this.advance(action);
  }
  private advance(action: ReplayAction): ReplayResult {
    for (;;) {
      const event = this.next(action);
      action = 'resume';
      if (!event) {
        return { state: 'ended' };
      }
      if (event.state === 'paused') {
        return { state: 'paused', pause: event.pause };
      }
    }
  }
  private next(action: ReplayAction = 'resume'): ReplayEvent | null {
    this.configure();
    const next = this.driver.next(action);
    if (next.done) {
      this.event = null;
      this.ended = true;
      this.inputIndex = this.hostInputCount;
      const expected = this.lines.filter(l => l && !l.startsWith('#'));
      for (let i = 0; i < Math.max(expected.length, this.output.length); i++) {
        if (
          expected[i] === undefined ||
          this.output[i] === undefined ||
          !same(expected[i]!, this.output[i]!)
        ) {
          throw new Error(
            `Trace diverged at record ${i + 1}: expected ${expected[i] ?? '(end)'}, got ${this.output[i] ?? '(end)'}`,
          );
        }
      }
      return null;
    }
    this.event = next.value;
    if (next.value.state === 'pumped') {
      this.completedReports.push(...next.value.result.reports);
    }
    this.inputIndex =
      (next.value.state === 'paused'
        ? next.value.pause.hostInputIndex
        : undefined) ?? next.value.hostInputIndex;
    this.configure(next.value.state === 'input');
    return next.value;
  }
  private configure(refresh = false): void {
    if (!this.group || !this.debug) {
      return;
    }
    if (refresh) {
      // Replace registrations too: a Reload can remove extension units.
      this.debug = new LiveDebugger(this.group, { now: () => 0n });
      this.loadedSources = this.group.debug().sources();
      for (const s of this.loadedSources) {
        this.debug.registerSource(s.unit, s.script);
      }
    }
    const resolved = this.debug.setBreakpoints(this.breaks);
    this.debug.pauseOn(this.faults);
    if (this.scanning) {
      this.group.debug().breakAt([
        ...resolved.flatMap(b => (b.instruction ? [b.instruction] : [])),
        ...this.loadedSources.flatMap(s =>
          s.statements.map(pc => ({
            pc,
            unit: s.unit.name,
            script: s.script,
          })),
        ),
      ]);
    }
  }
  private restart(): void {
    this.output = [];
    this.event = null;
    this.ended = false;
    this.inputIndex = 0;
    this.completedReports = [];
    this.driver = replayTrace(
      file => this.sources.get(file)!,
      this.setup,
      this.lines,
      {
        trace: this.output,
        configureDebug: group => {
          this.group = group;
          this.debug = new LiveDebugger(group, { now: () => 0n });
          this.configure(true);
        },
      },
    );
    // Start at the first input, before Load, so setting breakpoints runs no Script.
    const next = this.driver.next();
    if (next.done) {
      this.ended = true;
    } else {
      this.event = next.value;
    }
  }
}

/** Browser-safe live Host facade. Script lifecycle and Grants belong to the Host. */
export class LiveDebugger {
  private readonly controller: DebugController;
  private readonly sources = new Map<
    string,
    { script?: string; unit: CodeUnit }
  >();
  private breakpoints: SourceBreakpoint[] = [];
  private readonly pausedBaseline: number;
  private lastClock: bigint | null = null;

  constructor(
    private readonly group: Group,
    private readonly environment: { now(): bigint },
  ) {
    this.controller = group.debug();
    this.pausedBaseline = this.controller.pausedTime();
  }
  get isPaused(): boolean {
    return this.controller.isPaused;
  }
  get current(): DebugPause | null {
    return this.controller.current;
  }

  /** Register the exact lowering used by the Host, including Library units.
   * Register replacement code after a successful Reload to rebind breakpoints.
   */
  registerSource(unit: CodeUnit, script?: string): void {
    this.sources.set(JSON.stringify([unit.name, script]), {
      unit,
      ...(script ? { script } : {}),
    });
    this.resolveBreakpoints();
  }
  setBreakpoints(
    breakpoints: readonly SourceBreakpoint[],
  ): ResolvedBreakpoint[] {
    for (const b of breakpoints) {
      if (
        !Number.isSafeInteger(b.line) ||
        b.line < 1 ||
        (b.col !== undefined && (!Number.isSafeInteger(b.col) || b.col < 1))
      ) {
        throw new Error('Breakpoint positions must be positive integers');
      }
    }
    this.breakpoints = breakpoints.map(b => ({ ...b }));
    return this.resolveBreakpoints();
  }
  clearBreakpoints(): void {
    this.setBreakpoints([]);
  }
  pauseOn(options: { error?: boolean; limitFault?: boolean }): void {
    this.controller.pauseOn(options);
  }
  snapshot(): DebugSnapshot {
    return this.controller.snapshot();
  }
  /** Epoch nanoseconds supplied by the Host, less cumulative paused wall time. */
  clock(): bigint {
    const reading =
      this.environment.now() -
      BigInt(
        Math.floor(
          (this.controller.pausedTime() - this.pausedBaseline) * 1_000_000,
        ),
      );
    // Coarse Host clocks and separately sampled monotonic paused time can
    // otherwise regress by a fraction of a millisecond after a pause.
    if (this.lastClock === null || reading > this.lastClock) {
      this.lastClock = reading;
    }
    return this.lastClock;
  }
  pump(now = this.clock(), options?: PumpOptions): DebugResult {
    return this.result(this.group.pump(now, options));
  }
  resume(): DebugResult {
    return this.result(this.controller.resume());
  }
  step(): DebugResult {
    return this.result(this.controller.step());
  }
  stepOver(): DebugResult {
    return this.result(this.controller.stepOver());
  }
  stepOut(): DebugResult {
    return this.result(this.controller.stepOut());
  }

  private result(result: PumpResult): DebugResult {
    const pause = this.controller.current;
    return pause ? { state: 'paused', pause } : result;
  }
  private resolveBreakpoints(): ResolvedBreakpoint[] {
    const resolved = this.breakpoints.map((b): ResolvedBreakpoint => {
      const source =
        this.sources.get(JSON.stringify([b.unit, b.script])) ??
        this.sources.get(JSON.stringify([b.unit, undefined])) ??
        (!b.script
          ? [...this.sources.values()].find(s => s.unit.name === b.unit)
          : undefined);
      // Keep breakpoints on their requested line. A blank line is unverified.
      // A line-only breakpoint uses its first emitted instruction. With a column,
      // pick the nearest mapped column at or after the requested column, then
      // the first instruction at that position in execution order.
      const columns =
        source?.unit.code
          .filter(i => i.line === b.line && i.col >= (b.col ?? 1))
          .map(i => i.col) ?? [];
      if (!columns.length) {
        return { ...b, verified: false };
      }
      const col =
        b.col === undefined
          ? source!.unit.code.find(i => i.line === b.line)!.col
          : Math.min(...columns);
      const pc = source!.unit.code.findIndex(
        i => i.line === b.line && i.col === col,
      );
      const instruction: DebugInstruction = {
        pc,
        unit: b.unit,
        ...(b.script ? { script: b.script } : {}),
        ...(b.run ? { run: b.run } : {}),
      };
      return { ...b, col, verified: true, instruction };
    });
    this.controller.breakAt(
      resolved.flatMap(b => (b.instruction ? [b.instruction] : [])),
    );
    return resolved;
  }
}

/** Session-style views of every Script, read without the Inspect Host Input. */
export const renderDebugView = (
  snapshot: DebugSnapshot,
  what: 'runs' | 'mailbox' | 'vars',
): string[] =>
  snapshot.scripts.flatMap(script => {
    const prefix = `[${script.name}] `;
    if (what === 'vars') {
      return script.vars.map(
        ([name, value]) => `${prefix}${name} = ${value.toString()}`,
      );
    }
    if (what === 'mailbox') {
      return script.mailbox.map(
        m =>
          `${prefix}${m.delivery ?? m.from} ${m.message.name} ${list(...(m.message.args ?? [])).toString()}`,
      );
    }
    return script.runs.map(
      r =>
        prefix +
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
          'segment',
          r.segment,
          'fuel',
          r.fuel,
        ].join(' '),
    );
  });
