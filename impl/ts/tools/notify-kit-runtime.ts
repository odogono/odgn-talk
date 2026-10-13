// Runs the router kit in whichever runtime runs this file, bundled, so the
// router is held to the kit under Node as well as Bun. Reads the
// sequences as JSON from the path given, and prints each failure as a JSON
// line.
//   node notify-kit-runtime.js sequences.json
import { readFileSync } from 'node:fs';
import { runNotifyKitSequence, type NotifyKitSequence } from './notify-kit';

const sequences = JSON.parse(
  readFileSync(process.argv[2]!, 'utf8'),
) as NotifyKitSequence[];
let failed = 0;
for (const sequence of sequences) {
  const failure = runNotifyKitSequence(sequence);
  if (failure) {
    failed++;
    console.log(JSON.stringify({ sequence: sequence.name, ...failure }));
  }
}
console.log(
  `${sequences.length - failed} of ${sequences.length} sequences passed`,
);
process.exitCode = failed ? 1 : 0;
