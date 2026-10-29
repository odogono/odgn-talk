// Synthetic snapshot workloads. Run the same file against a baseline checkout
// with --baseline, or bundle it for Node to verify runtime-neutral embedding.
import { readSave } from '../../../impl/ts/src/save-format';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import {
  newGroup,
  restore,
  defineCapability,
  shape,
  num,
  type Operation,
  type SaveOptions,
} from '../../../impl/ts/src/index';

const samples = Number(
  process.argv.find(s => s.startsWith('--samples='))?.split('=')[1] ?? 30,
);
if (!Number.isSafeInteger(samples) || samples < 1) {
  throw new Error('Expected positive --samples');
}
const baseline = process.argv.includes('--baseline');
const median = (ns: number[]) =>
  [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)]!;
const fixtures = [
  {
    name: 'representative',
    scripts: 6,
    sourceSize: 3167,
    operations: 16,
    rows: 0,
    concurrent: 3,
  },
  {
    name: 'one-script',
    scripts: 1,
    sourceSize: 3167,
    operations: 16,
    rows: 0,
    concurrent: 3,
  },
  {
    name: 'twelve-scripts',
    scripts: 12,
    sourceSize: 3167,
    operations: 16,
    rows: 0,
    concurrent: 3,
  },
  {
    name: 'long-sources',
    scripts: 6,
    sourceSize: 10_000,
    operations: 16,
    rows: 0,
    concurrent: 3,
  },
  {
    name: 'one-operation',
    scripts: 6,
    sourceSize: 3167,
    operations: 1,
    rows: 0,
    concurrent: 3,
  },
  {
    name: 'wide-declarations',
    scripts: 6,
    sourceSize: 3167,
    operations: 32,
    rows: 0,
    concurrent: 3,
  },
  {
    name: 'state-100',
    scripts: 6,
    sourceSize: 3167,
    operations: 16,
    rows: 100,
    concurrent: 3,
  },
  {
    name: 'state-500',
    scripts: 6,
    sourceSize: 3167,
    operations: 16,
    rows: 500,
    concurrent: 3,
  },
];
const measurements = [];
for (const fixture of fixtures) {
  const operations: Record<string, Operation<void>> = {
    prompt: {
      mode: 'suspending',
      args: [shape.text],
      result: shape.number,
      cost: { fuel: 1 },
      start: () => {},
    },
  };
  for (let i = 1; i < fixture.operations; i++) {
    operations[`display${i}`] = {
      mode: 'fire-and-forget',
      args: [shape.text, shape.number, shape.listOf(shape.text)],
      cost: { fuel: 1 },
      fire: () => {},
      errors: [
        { code: `display ${i} unavailable`, fields: { reason: shape.text } },
      ],
    };
  }
  const grant = defineCapability('ui', operations).grant('all', undefined);
  let source = `script variable rows = []
on seed count
  repeat count times
    put {value: 42} after rows
  end repeat
end seed
on message
  ask ui to prompt "question" and wait
end message
on timer
  wait 10 s
end timer
`;
  for (let i = 0; i < 30; i++) {
    source += `on unused${i} value\n  return value + ${i}\nend unused${i}\n`;
  }
  source +=
    '-- ' + 'x'.repeat(Math.max(0, fixture.sourceSize - source.length - 3));
  for (const scenario of ['idle', 'message', 'timer', 'concurrent'] as const) {
    const group = newGroup({ name: 'snapshot-bench' });
    for (let i = 0; i < fixture.scripts; i++) {
      const script = group.load({
        name: `s${i}`,
        source,
        grants: { ui: grant },
      });
      if (fixture.rows) {
        script.deliver({ name: 'seed', args: [num(fixture.rows)] });
      }
    }
    group.pump(0n);
    for (const name of group.scriptNames()) {
      if (scenario === 'idle') {
        continue;
      }
      const script = group.script(name)!;
      for (
        let i = 0;
        i < (scenario === 'concurrent' ? fixture.concurrent : 1);
        i++
      ) {
        script.deliver({
          name:
            scenario === 'timer' || (scenario === 'concurrent' && i % 2)
              ? 'timer'
              : 'message',
        });
      }
    }
    group.pump(1n);
    for (const mode of (baseline
      ? ['embedded']
      : ['embedded', 'external']) as SaveOptions['sources'][]) {
      const saveOptions = { sources: mode };
      const bytes = group.save(saveOptions);
      // The state the save holds: every required section's body.
      const state = readSave(bytes)
        .sections.filter(x => !x.optional)
        .reduce((sum, x) => sum + x.body.length, 0);
      const restoreOptions = {
        name: 'snapshot-bench',
        libraries: [],
        grants: () => grant,
        onMismatch: 'reject' as const,
        resolve: () => undefined,
        scriptSources: () => ({ source }),
      };
      const saveTimes: number[] = [],
        restoreTimes: number[] = [];
      for (let i = 0; i < samples + 5; i++) {
        let start = performance.now();
        group.save(saveOptions);
        const saveTime = performance.now() - start;
        start = performance.now();
        const copy = restore(bytes, restoreOptions);
        const restoreTime = performance.now() - start;
        if (copy.result.variablesOnly) {
          throw new Error('Benchmark restore mismatched');
        }
        if (i >= 5) {
          saveTimes.push(saveTime);
          restoreTimes.push(restoreTime);
        }
      }
      measurements.push({
        fixture: fixture.name,
        scenario,
        mode,
        scripts: fixture.scripts,
        sourceChars: source.length * fixture.scripts,
        operations: fixture.operations,
        rows: fixture.rows,
        raw: bytes.length,
        base64: Buffer.from(bytes).toString('base64').length,
        graph: state,
        saveMs: median(saveTimes),
        restoreMs: median(restoreTimes),
      });
    }
  }
}
process.stdout.write(
  JSON.stringify(
    { runtime: process.versions, samples, baseline, measurements },
    null,
    2,
  ) + '\n',
);
