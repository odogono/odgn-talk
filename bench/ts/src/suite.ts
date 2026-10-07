// The Benchmark Suite's manifest and its Scripts on the TS Core. Its design
// and reasons are in ADR 0054; bench/README.md describes how to run it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  newGroup,
  defineCapability,
  defineObjectKind,
  encodeJson,
  decodeJson,
  shape,
  num,
  parseInstant,
  type ScriptHandle,
  type LoadOptions,
} from '@odgn/northtalk';

export const scriptsDir = join(import.meta.dir, '..', '..', 'scripts');

/** One size a Benchmark runs at, and the display form its Run returns. */
export type Size = { expect: string; n: number };

/** One manifest entry. Its Script is `<name>.talk`, and its Handler `run` takes N. */
export type Benchmark = Size & {
  host?: 'immediate' | 'suspending' | 'properties' | 'conversion';
  name: string;
  /** Runners that can't run it yet, each with the reason. */
  skip?: Record<string, string>;
  smoke: Size;
};

export const manifest = (): Benchmark[] =>
  (
    JSON.parse(readFileSync(join(scriptsDir, 'benchmarks.json'), 'utf8')) as {
      benchmarks: Benchmark[];
    }
  ).benchmarks;

/** Whether a Benchmark is selected by a `--filter`: a substring of its name. */
export const selected = (b: Benchmark, filter: string | undefined) =>
  !filter || b.name.includes(filter);

/** The runners among `runners` that skip a Benchmark, with their reasons. */
export const skipped = (b: Benchmark, runners: readonly string[]) =>
  runners.flatMap(runner => {
    const reason = b.skip?.[runner];
    return reason ? [{ benchmark: b.name, reason, runner }] : [];
  });

export const sizeOf = (b: Benchmark, smoke: boolean): Size =>
  smoke ? b.smoke : b;

export const sourceOf = (b: Benchmark) =>
  readFileSync(join(scriptsDir, `${b.name}.talk`), 'utf8');

// Each limit's conformance minimum, which every Core supports, so that no
// Benchmark trips one.
const limits = {
  allocPerRun: 268_435_456,
  callDepth: 1000,
  fuelPerRun: 1_000_000_000,
};

// The Clock reading every Pump uses. Benchmarks never wait on time.
const clock = parseInstant('2026-01-01T00:00:00Z');

/** What one Run reported. */
export type RunReport = {
  alloc: number;
  fuel: number;
  outcome: string;
  result?: string;
};

/** A Benchmark's Script loaded into its own Group, ready to Run. */
export class Loaded {
  private readonly group = newGroup({ name: 'bench' });
  private readonly script: ScriptHandle;
  constructor(name: string, source: string, host?: Benchmark['host']) {
    const bindings: Partial<LoadOptions> = {};
    if (host === 'properties') {
      const kind = defineObjectKind({
        name: 'BenchmarkMeter',
        props: {
          value: {
            shape: shape.number,
            getCost: { fuel: 1 },
            get: () => num(1),
          },
        },
      });
      bindings.objects = { meter: this.group.object(kind, 'meter', undefined) };
    } else if (host) {
      const capability = defineCapability('BenchmarkHost', {
        echo: {
          mode: 'immediate',
          args: [shape.number],
          result: shape.number,
          cost: { fuel: 1 },
          do: (_call, value) => value,
        },
        later: {
          mode: 'suspending',
          args: [shape.number],
          result: shape.number,
          cost: { fuel: 1 },
          start: (call, value) => call.answer(value),
        },
        convert: {
          mode: 'immediate',
          args: [shape.any],
          result: shape.any,
          cost: { fuel: 1 },
          do: (_call, value) => decodeJson(encodeJson(value)),
        },
      });
      bindings.grants = { host: capability.grant('all', undefined) };
    }
    this.script = this.group.load({ limits, name, source, ...bindings });
  }
  run(n: number): RunReport {
    this.script.deliver({ args: [num(n)], name: 'run' });
    // Answers queued by Start are consumed by the next Pump. Bound the loop
    // so an accidentally unanswerable workload fails instead of hanging.
    for (let pumps = 0; pumps <= n + 1; pumps++) {
      const end = this.group
        .pump(clock)
        .reports.find(report => report.kind === 'run end');
      if (end) {
        return {
          alloc: end.alloc,
          fuel: end.fuel,
          outcome: end.outcome,
          ...(end.result ? { result: String(end.result) } : {}),
        };
      }
    }
    throw new Error('the Pump ended no Run');
  }
}

/** Run a Benchmark once and confirm it completes with its expected output. */
export const check = (b: Benchmark, smoke: boolean): RunReport => {
  const size = sizeOf(b, smoke);
  const report = new Loaded(b.name, sourceOf(b), b.host).run(size.n);
  if (report.outcome !== 'completed') {
    throw new Error(`${b.name}: Run did not complete: ${report.outcome}`);
  }
  if (report.result !== size.expect) {
    throw new Error(
      `${b.name}: output ${report.result}, expected ${size.expect}`,
    );
  }
  return report;
};
