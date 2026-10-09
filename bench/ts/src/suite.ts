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
  restore,
  type Group,
  type Report,
  type ScriptHandle,
  type LoadOptions,
} from '@odgn/northtalk';

export const scriptsDir = join(import.meta.dir, '..', '..', 'scripts');

/** One size a Benchmark runs at, and the display form its Run returns. */
export type Size = { expect: string; n: number };

/** One manifest entry. Its Script is `<name>.talk`, and its Handler `run` takes N. */
export type Benchmark = Size & {
  host?:
    | 'immediate'
    | 'suspending'
    | 'properties'
    | 'conversion'
    | 'partner'
    | 'parents'
    | 'restore';
  name: string;
  /** False keeps it out of the Cost Model outliers. */
  outlier?: boolean;
  /** Its Script, when that isn't its name: a sweep runs its base's. */
  script?: string;
  /** Runners that can't run it yet, each with the reason. */
  skip?: Record<string, string>;
  /** The Fuel Slice of each Pump of a sweep Benchmark. */
  slice?: number;
  /** The sweep's Fuel Slices: `manifest` adds a Benchmark for each. */
  slices?: number[];
  smoke: Size;
};

/** Why the Peer Languages skip a Fuel Slice sweep. */
export const sweepSkip =
  'A Fuel Slice is a NorthTalk Pump option; no peer counterpart.';

export const manifest = (): Benchmark[] =>
  (
    JSON.parse(readFileSync(join(scriptsDir, 'benchmarks.json'), 'utf8')) as {
      benchmarks: Benchmark[];
    }
  ).benchmarks.flatMap(({ slices, ...b }) => [
    b,
    ...(slices ?? []).map(slice => ({
      ...b,
      name: `${b.name}@slice=${slice}`,
      script: b.name,
      skip: { peers: sweepSkip, ...b.skip },
      slice,
    })),
  ]);

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

const readScript = (name: string) =>
  readFileSync(join(scriptsDir, `${name}.talk`), 'utf8');

export const sourceOf = (b: Benchmark) => readScript(b.script ?? b.name);

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
  /** The `restore` Host: the N its rows were last filled for. */
  private filled: number | undefined;
  constructor(
    private readonly b: Pick<Benchmark, 'host' | 'slice'>,
    name: string,
    source: string,
  ) {
    const { host } = b;
    const bindings: Partial<LoadOptions> = {};
    if (host === 'partner') {
      this.group.load({
        limits,
        name: 'partner',
        source: readScript('messaging/partner'),
      });
    } else if (host === 'parents') {
      // leaf → branch → root, and only root has an Owning Script: the
      // Benchmark's.
      const kind = defineObjectKind({
        name: 'BenchmarkNode',
        parentKinds: ['BenchmarkNode'],
        props: {},
      });
      const root = this.group.object(kind, 'root', undefined);
      const branch = this.group.object(kind, 'branch', undefined);
      const leaf = this.group.object(kind, 'leaf', undefined);
      this.group.setParent(branch, root);
      this.group.setParent(leaf, branch);
      bindings.owner = root;
      bindings.objects = { leaf };
    } else if (host === 'properties') {
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
    } else if (host && host !== 'restore') {
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
  /**
   * Deliver `run n` and pump until its Run ends and the Group is idle. Under
   * the `restore` Host, the Run is on a Group restored from a save of the
   * loaded one.
   */
  run(n: number): RunReport {
    if (this.b.host !== 'restore') {
      return pump(this.group, this.script, 'run', n, this.b.slice);
    }
    if (this.filled !== n) {
      pump(this.group, this.script, 'fill', n);
      this.filled = n;
    }
    const { group } = restore(this.group.save(), {
      grants: () => undefined,
      libraries: [],
      name: 'bench',
      onMismatch: 'reject',
      resolve: () => undefined,
    });
    return pump(group, group.script(this.script.name)!, 'run', n);
  }
}

/** What one Run reported, with the Fuel and allocation of every Run the
 * Group's Pumps ended on its way. */
const pump = (
  group: Group,
  script: ScriptHandle,
  message: string,
  n: number,
  fuelSlice?: number,
): RunReport => {
  const delivery = script.deliver({ args: [num(n)], name: message });
  let fuel = 0;
  let alloc = 0;
  let mine: Extract<Report, { kind: 'run end' }> | undefined;
  for (;;) {
    const result = group.pump(clock, fuelSlice ? { fuelSlice } : {});
    fuel += result.fuelUsed;
    for (const report of result.reports) {
      if (report.kind === 'run end') {
        alloc += report.alloc;
        if (report.delivery === delivery) {
          mine = report;
        }
      }
    }
    if (mine && result.state === 'idle' && result.nextDeadline === undefined) {
      return {
        alloc,
        fuel,
        outcome: mine.outcome,
        ...(mine.result ? { result: String(mine.result) } : {}),
      };
    }
    // A Pump that does no work can't end the Run: fail instead of hanging.
    if (result.fuelUsed === 0 && result.reports.length === 0) {
      throw new Error('the Pump ended no Run');
    }
  }
};

/** Run a Benchmark once and confirm it completes with its expected output. */
export const check = (b: Benchmark, smoke: boolean): RunReport => {
  const size = sizeOf(b, smoke);
  const report = new Loaded(b, b.name, sourceOf(b)).run(size.n);
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
