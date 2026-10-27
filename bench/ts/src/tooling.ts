// TS-only Benchmarks of the authoring tools, which run no Script: no Fuel, no
// parity check, and only the TS runner. bench/README.md describes each.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeWorkspace } from '../../../tooling/stack/src/lsp/workspace';
import { measure } from './measurement';
import { type Measurement, statsOf } from './report';

// `import.meta.dirname` rather than Bun's `dir`, so the Node build in
// bench/ts/dist finds the same project.
const projectDir = join(
  import.meta.dirname,
  '..',
  '..',
  'scripts',
  'tooling',
  'lsp-project',
);
const project = ['steps', 'first', 'second'].map(name => ({
  uri: `file:///lsp-project/${name}.talk`,
  text: readFileSync(join(projectDir, `${name}.talk`), 'utf8'),
  ...(name === 'steps' ? { library: name } : {}),
}));

/**
 * An LSP edit-and-reanalyse cycle: one line of `first.talk` changes, then the
 * whole project is parsed, checked, linted and lowered again, as `didChange`
 * does. Each call alternates the line; every open document has a version,
 * so no Analysis is reused.
 */
const lspReanalyse = () => {
  const [steps, first, second] = project;
  const edits = [
    first!.text,
    first!.text.replace('put 0 into total', 'put 1 into total'),
  ];
  let version = 0;
  return () => {
    version++;
    const documents = [
      { ...steps!, version: 1 },
      { ...first!, text: edits[version % 2]!, version },
      { ...second!, version: 1 },
    ];
    return analyzeWorkspace(documents, null, 'standard');
  };
};

export const toolingBenchmarks = [
  { name: 'tooling/lsp-reanalyse', cycle: lspReanalyse },
];

/** Check each selected tooling Benchmark's project is clean, then time it. */
export const measureTooling = async (
  filter: string | undefined,
  options: Parameters<typeof measure>[1],
  runner: string,
): Promise<Measurement[]> => {
  const out: Measurement[] = [];
  for (const b of toolingBenchmarks.filter(
    b => !filter || b.name.includes(filter),
  )) {
    const cycle = b.cycle();
    for (const [uri, analysis] of cycle()) {
      const failed =
        analysis.diagnostics.find(d => d.severity === 1) ??
        (analysis.document.version !== undefined && !analysis.loaded
          ? { message: 'not lowered' }
          : undefined);
      if (failed) {
        throw new Error(`${b.name}: ${uri}: ${failed.message}`);
      }
    }
    const run = await measure(cycle, options);
    out.push({
      benchmark: b.name,
      ...(run.heap ? { hostBytes: Math.max(0, run.heap.avg) } : {}),
      run: statsOf(run.samples),
      runner,
    });
  }
  return out;
};
