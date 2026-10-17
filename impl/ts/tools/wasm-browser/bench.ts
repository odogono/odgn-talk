// Figures for one Core in a browser page (#1121): startup, Pump throughput,
// Capability crossings, a compute-bound Run, and memory per Group. The same
// code measures both Cores; page-ts.ts and page-wasm.ts pass each package.
import type { NorthTalk } from '../../examples/core-switch/host';
import type { Value } from '../../src/index';

type Group = {
  deliver?: unknown;
  load(o: {
    grants?: Record<string, unknown>;
    limits?: Record<string, number>;
    name: string;
    source: string;
  }): {
    deliver(m: { args?: Value[]; name: string }): string;
    request(m: { args?: Value[]; name: string }): { result: Promise<Value> };
  };
  memoryBytes?(): number;
  pump(now: bigint): { fuelUsed: number; reports: { kind: string }[] };
};
type Core = {
  defineCapability(
    name: string,
    ops: Record<string, unknown>,
  ): { grant(ops: 'all', binding: undefined): unknown };
  newGroup(o: { name: string }): Group;
};
/** Either package; each page passes its own. */
export type Bench = Omit<NorthTalk, 'createCore'> & {
  createCore(o?: { wasm?: unknown }): Core | Promise<Core>;
};

const tick = 'on tick n\n  return n + 1\nend tick';
const call = 'on tick n\n  ask io to echo n\n  return it\nend tick';
const spin =
  'on spin n\n  put 0 into t\n  repeat for each i in 1..n\n    add i to t\n  end repeat\n  return t\nend spin';
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;

export const bench = async (nt: Bench, wasm?: unknown) => {
  let clock = 1_000_000n;
  const now = () => (clock += 1000n);
  const t0 = performance.now();
  const core = await nt.createCore(wasm === undefined ? undefined : { wasm });
  const t1 = performance.now();
  const io = core.defineCapability('io', {
    echo: {
      mode: 'immediate',
      args: [nt.shape.number],
      result: nt.shape.number,
      cost: { fuel: 1 },
      do: (_c: unknown, n: Value) => n,
    },
  });
  const first = core.newGroup({ name: 'first' });
  const script = first.load({ name: 's', source: tick });
  const t2 = performance.now();
  script.deliver({ name: 'tick', args: [nt.num(1)] });
  first.pump(now());
  const t3 = performance.now();

  // Messages per second: N Deliveries, then one Pump that runs them all.
  const rate = (source: string, grants?: Record<string, unknown>) => {
    const n = 2000;
    const g = core.newGroup({ name: `rate-${source.length}` });
    const s = g.load({
      name: 's',
      source,
      grants,
      limits: { mailboxDepth: n },
    });
    const rounds: number[] = [];
    for (let round = 0; round < 7; round++) {
      for (let i = 0; i < n; i++) {
        s.deliver({ name: 'tick', args: [nt.num(i)] });
      }
      const start = performance.now();
      g.pump(now());
      rounds.push((n * 1000) / (performance.now() - start));
    }
    return Math.round(median(rounds.slice(2)));
  };
  const pumps = rate(tick);
  const crossings = rate(call, { io: io.grant('all', undefined) });

  const compute = core.newGroup({ name: 'compute' });
  const spinner = compute.load({ name: 's', source: spin });
  const spins: number[] = [];
  let fuel = 0;
  for (let round = 0; round < 5; round++) {
    spinner.deliver({ name: 'spin', args: [nt.num(100_000)] });
    const start = performance.now();
    fuel = compute.pump(now()).fuelUsed;
    spins.push(performance.now() - start);
  }

  return {
    createCoreMs: +(t1 - t0).toFixed(2),
    firstGroupAndLoadMs: +(t2 - t1).toFixed(2),
    firstPumpMs: +(t3 - t2).toFixed(2),
    sincePageStartMs: +t3.toFixed(1),
    pumpMessagesPerSecond: pumps,
    capabilityCallsPerSecond: crossings,
    spin100kMs: +median(spins).toFixed(1),
    spin100kFuel: fuel,
  };
};

/**
 * Groups made on demand, each with a Script and one Run, for the runner to
 * weigh: it reads the JS heap around grow(), which returns the guests'
 * linear memory, none on the TS Core.
 */
export const memoryProbe = async (nt: Bench, wasm?: unknown) => {
  const core = await nt.createCore(wasm === undefined ? undefined : { wasm });
  const groups: Group[] = [];
  let clock = 1_000_000n;
  return {
    grow(n: number): number {
      let linear = 0;
      for (let i = 0; i < n; i++) {
        const g = core.newGroup({ name: `m${groups.length}` });
        g.load({ name: 's', source: tick }).deliver({
          name: 'tick',
          args: [nt.num(i)],
        });
        g.pump((clock += 1000n));
        groups.push(g);
        linear += g.memoryBytes?.() ?? 0;
      }
      return linear;
    },
  };
};
