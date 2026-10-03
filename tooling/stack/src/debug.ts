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
} from '@odgn/northtalk/debug';

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
