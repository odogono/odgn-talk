// Interleaved A/B for #1314. Pump executes the shared host/immediate and
// host/properties Scripts; admission and Group creation are outside timing.
// bun bench/ts/src/wasm-callbacks.ts > results.json
// Bundle with target:node to run the identical measurement under Node.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { resolve } from 'node:path';
import {
  createCore,
  num,
  parseInstant,
  shape,
  type WasmCore,
} from '../../../impl/ts/src/wasm/index';

const root =
  process.env.NORTHTALK_ROOT ?? resolve(import.meta.dirname, '../../..');
const wasm = readFileSync(resolve(root, '.cache/zig-wasi/bin/talk.wasm'));
const module = await WebAssembly.compile(wasm);
const n = 1000;
const rounds = 30;
const warmup = 10;
const now = parseInstant('2026-01-01T00:00:00Z');
const make = (core: WasmCore, workload: string) => {
  const group = core.newGroup({ name: workload });
  const cap = core.defineCapability('host', {
    echo: {
      mode: 'immediate',
      args: [shape.number],
      result: shape.number,
      cost: { fuel: 1 },
      do: (_c, value) => value!,
    },
  });
  const kind = core.defineObjectKind({
    name: 'meter',
    props: { value: { shape: shape.number, get: () => num(7) } },
  });
  const script = group.load({
    name: workload,
    source: readFileSync(
      resolve(root, `bench/scripts/${workload}.talk`),
      'utf8',
    ),
    grants: { host: cap.grant('all', undefined) },
    objects: { meter: group.object(kind, 'meter', undefined) },
    limits: { fuelPerRun: 1_000_000_000, allocPerRun: 268_435_456 },
  });
  return () => {
    script.deliver({ name: 'run', args: [num(n)] });
    const start = performance.now();
    const pump = group.pump(now);
    const nsPerCallback = ((performance.now() - start) * 1e6) / n;
    const end = pump.reports.find(r => r.kind === 'run end');
    const expected = workload.endsWith('immediate')
      ? String((n * (n + 1)) / 2)
      : String(n * 7);
    if (
      end?.kind !== 'run end' ||
      end.outcome !== 'completed' ||
      end.result?.toString() !== expected
    ) {
      throw new Error(`Invalid ${workload}: ${JSON.stringify(pump.reports)}`);
    }
    return { nsPerCallback, fuel: end.fuel, alloc: end.alloc };
  };
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const results: Record<string, unknown> = {};
for (const workload of ['host/immediate', 'host/properties']) {
  const json = make(
    await createCore({ wasm: module, binaryCallbacks: false }),
    workload,
  );
  const binary = make(await createCore({ wasm: module }), workload);
  const samples: {
    binary: ReturnType<typeof binary>;
    json: ReturnType<typeof json>;
  }[] = [];
  for (let round = -warmup; round < rounds; round++) {
    let a, b;
    if (round % 2 === 0) {
      a = json();
      b = binary();
    } else {
      b = binary();
      a = json();
    }
    if (round >= 0) {
      samples.push({ json: a, binary: b });
    }
  }
  results[workload] = {
    jsonNsPerCallback: median(samples.map(s => s.json.nsPerCallback)),
    binaryNsPerCallback: median(samples.map(s => s.binary.nsPerCallback)),
    pairedRatio: median(
      samples.map(s => s.binary.nsPerCallback / s.json.nsPerCallback),
    ),
    samples,
  };
}
// eslint-disable-next-line no-console -- this benchmark prints its machine-readable result.
console.log(
  JSON.stringify(
    {
      environment: {
        runtime: process.versions,
        platform: platform(),
        arch: arch(),
        os: release(),
        cpu: cpus()[0]?.model,
      },
      artifactSha256: createHash('sha256').update(wasm).digest('hex'),
      n,
      rounds,
      warmup,
      results,
    },
    null,
    2,
  ),
);
