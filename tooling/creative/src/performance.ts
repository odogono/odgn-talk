// Passive, typed Run accounting for the Folio Performance window. Live Run
// baselines survive while capture is off; aggregates and history do not.
import { type Report } from '@northtalk/ts';

export type PerformanceRow = {
  active: number;
  completed: number;
  discarded: number;
  failed: number;
  fuel: number;
  last?: number;
  peak?: number;
  rate: number;
  sampleFuel: number;
  samples: number;
  started: number;
};
export type OriginPerformance = PerformanceRow & { origin: string };
export type ScriptPerformance = PerformanceRow & {
  frames?: { delivered: number; rate: number; skipped: number };
  origins: OriginPerformance[];
  owner?: number;
  script: string;
};
export type PerformanceBucket = {
  fuel: number;
  pumpPeak: number;
  second: number;
};
export type PerformanceSnapshot = {
  elapsed: number;
  epoch: number;
  fuel: number;
  history: PerformanceBucket[];
  pumpCap: number;
  pumpPeak: number;
  scripts: ScriptPerformance[];
  status: 'capturing' | 'stopped' | 'incomplete';
};
type LiveRun = {
  fuel: number;
  origin: string;
  outcome?: string;
  partial: boolean;
  script: string;
};
type Counts = PerformanceRow & { recent: Map<number, number> };
type ScriptCounts = {
  frames?: { delivered: number; recent: Map<number, number>; skipped: number };
  origins: Map<string, Counts>;
};
const counts = (): Counts => ({
  active: 0,
  completed: 0,
  failed: 0,
  discarded: 0,
  fuel: 0,
  rate: 0,
  started: 0,
  samples: 0,
  sampleFuel: 0,
  recent: new Map(),
});

export class PerformanceCapture {
  readonly #live = new Map<string, LiveRun>();
  readonly #scripts = new Map<string, ScriptCounts>();
  readonly #frameScripts = new Set<string>();
  readonly #history = new Map<number, PerformanceBucket>();
  #start: number | undefined;
  #end: number | undefined;
  #epoch = 0;
  #fuel = 0;
  #pumpPeak = 0;
  constructor(private readonly now: () => number = () => performance.now()) {}

  get enabled(): boolean {
    return this.#start !== undefined;
  }

  frameScript(script: string): void {
    this.#frameScripts.add(script);
    if (this.enabled) {
      this.#script(script);
    }
  }

  start(epoch: number): void {
    this.#epoch = epoch;
    this.#start = this.now();
    this.#end = undefined;
    this.#fuel = 0;
    this.#pumpPeak = 0;
    this.#scripts.clear();
    this.#history.clear();
    for (const script of this.#frameScripts) {
      this.#script(script);
    }
    for (const run of this.#live.values()) {
      run.partial = true;
      this.#row(run).active++;
    }
  }

  #script(script: string): ScriptCounts {
    let row = this.#scripts.get(script);
    if (!row) {
      row = {
        origins: new Map(),
        ...(this.#frameScripts.has(script)
          ? { frames: { delivered: 0, skipped: 0, recent: new Map() } }
          : {}),
      };
      this.#scripts.set(script, row);
    }
    if (this.#frameScripts.has(script) && !row.frames) {
      row.frames = { delivered: 0, skipped: 0, recent: new Map() };
    }
    return row;
  }
  #row(run: LiveRun): Counts {
    const script = this.#script(run.script);
    let row = script.origins.get(run.origin);
    if (!row) {
      row = counts();
      script.origins.set(run.origin, row);
    }
    return row;
  }
  #second(): number {
    return Math.floor(((this.#end ?? this.now()) - this.#start!) / 1000);
  }
  #add(recent: Map<number, number>, value: number): void {
    const second = this.#second();
    recent.set(second, (recent.get(second) ?? 0) + value);
    for (const key of recent.keys()) {
      if (key < second - 59) {
        recent.delete(key);
      }
    }
  }
  #bucket(): PerformanceBucket {
    const second = this.#second();
    let bucket = this.#history.get(second);
    if (!bucket) {
      bucket = { second, fuel: 0, pumpPeak: 0 };
      this.#history.set(second, bucket);
    }
    for (const key of this.#history.keys()) {
      if (key < second - 59) {
        this.#history.delete(key);
      }
    }
    return bucket;
  }

  reports(reports: readonly Report[], pumpFuel?: number): void {
    if (this.enabled && pumpFuel !== undefined) {
      this.#pumpPeak = Math.max(this.#pumpPeak, pumpFuel);
      const bucket = this.#bucket();
      bucket.pumpPeak = Math.max(bucket.pumpPeak, pumpFuel);
    }
    for (const report of reports) {
      if (report.kind === 'run started') {
        const fn = report.fn?.asFunction();
        const run: LiveRun = {
          script: report.script,
          origin:
            report.selector ??
            `Function ${fn?.displayHome ?? fn?.home ?? report.script}:${fn?.place ?? '?'}`,
          fuel: 0,
          partial: !this.enabled,
        };
        this.#live.set(report.run, run);
        if (this.enabled) {
          const row = this.#row(run);
          row.started++;
          row.active++;
        }
      } else if (report.kind === 'run end' && report.run) {
        const run = this.#live.get(report.run);
        if (run) {
          run.outcome = report.outcome;
        }
      } else if (report.kind === 'run accounting') {
        const run = this.#live.get(report.run);
        if (!run) {
          continue;
        }
        if (this.enabled) {
          const row = this.#row(run);
          const delta = report.fuel - run.fuel;
          row.fuel += delta;
          this.#fuel += delta;
          this.#bucket().fuel += delta;
          this.#add(row.recent, delta);
          if (report.state !== 'live') {
            row.active--;
            if (report.state === 'discarded') {
              row.discarded++;
            } else {
              row.completed++;
              if (
                ['errored', 'limit fault', 'effect failed'].includes(
                  run.outcome ?? '',
                )
              ) {
                row.failed++;
              }
              if (!run.partial) {
                row.samples++;
                row.sampleFuel += report.fuel;
                row.last = report.fuel;
                row.peak = Math.max(row.peak ?? 0, report.fuel);
              }
            }
          }
        }
        run.fuel = report.fuel;
        if (report.state !== 'live') {
          this.#live.delete(report.run);
        }
      }
    }
  }

  frame(script: string, skipped: boolean): void {
    if (!this.enabled) {
      return;
    }
    const row = this.#script(script).frames!;
    if (skipped) {
      row.skipped++;
    } else {
      row.delivered++;
      this.#add(row.recent, 1);
    }
  }
  stop(): void {
    if (this.enabled) {
      this.#end ??= this.now();
    }
  }

  snapshot(pumpCap: number): PerformanceSnapshot | undefined {
    if (!this.enabled) {
      return undefined;
    }
    const elapsed = Math.max(
      0,
      ((this.#end ?? this.now()) - this.#start!) / 1000,
    );
    const second = Math.floor(elapsed);
    // The current and previous bucket give a responsive 1–2 second rate.
    const duration = Math.max(0.001, elapsed - Math.max(0, second - 1));
    const rate = (recent: Map<number, number>) => {
      for (const key of recent.keys()) {
        if (key < second - 59) {
          recent.delete(key);
        }
      }
      return (
        ((recent.get(second) ?? 0) + (recent.get(second - 1) ?? 0)) / duration
      );
    };
    const scripts = [...this.#scripts]
      .map(([script, data]): ScriptPerformance => {
        const total = counts();
        const origins = [...data.origins]
          .map(([origin, { recent, ...row }]) => ({
            ...row,
            origin,
            rate: rate(recent),
          }))
          .sort((a, b) => b.rate - a.rate || a.origin.localeCompare(b.origin));
        for (const row of origins) {
          for (const key of [
            'active',
            'completed',
            'failed',
            'discarded',
            'fuel',
            'started',
            'samples',
            'sampleFuel',
            'rate',
          ] as const) {
            total[key] += row[key];
          }
          if (row.peak !== undefined) {
            total.peak = Math.max(total.peak ?? 0, row.peak);
          }
        }
        const { recent: _recent, ...summary } = total;
        return {
          ...summary,
          script,
          origins,
          ...(data.frames
            ? {
                frames: {
                  delivered: data.frames.delivered,
                  skipped: data.frames.skipped,
                  rate: rate(data.frames.recent),
                },
              }
            : {}),
        };
      })
      .sort((a, b) => b.rate - a.rate || a.script.localeCompare(b.script));
    const history: PerformanceBucket[] = [];
    for (let i = Math.max(0, second - 59); i <= second; i++) {
      history.push(this.#history.get(i) ?? { second: i, fuel: 0, pumpPeak: 0 });
    }
    return {
      elapsed,
      epoch: this.#epoch,
      fuel: this.#fuel,
      pumpCap,
      pumpPeak: this.#pumpPeak,
      scripts,
      history,
      status: this.#end === undefined ? 'capturing' : 'stopped',
    };
  }
}
