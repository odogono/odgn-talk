// Node spot-check for #1581; bundle with build-node.ts before running.
import { Loaded, manifest, sourceOf } from '../../ts/src/suite';
const rows = [];
for (const b of manifest().filter(b => /^(text|macro)\//.test(b.name))) {
  const loaded = new Loaded(b, b.name, sourceOf(b));
  const checked = loaded.run(b.n);
  if (checked.outcome !== 'completed' || checked.result !== b.expect) {
    throw new Error(JSON.stringify(checked));
  }
  const run = () => {
    const actual = loaded.run(b.n);
    if (JSON.stringify(actual) !== JSON.stringify(checked)) {
      throw new Error('Output/accounting changed');
    }
  };
  for (let i = 0; i < 30; i++) {
    run();
  }
  const samples = [];
  for (let i = 0; i < 15; i++) {
    const start = performance.now();
    let runs = 0;
    do {
      run();
      runs++;
    } while (performance.now() - start < 50);
    samples.push(((performance.now() - start) * 1e6) / runs);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  rows.push({
    benchmark: b.name,
    checked,
    samplesNs: samples,
    medianNs: sorted[7],
  });
}
process.stdout.write(JSON.stringify(rows) + '\n');
