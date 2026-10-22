// Runs the http test kit in whichever runtime runs this file, bundled, so
// the HTTP router is held to the kit under Node as well as Bun. Reads the
// cases as JSON from the path given, and prints each failure as a JSON line.
//   node http-kit-runtime.js cases.json
import { readFileSync } from 'node:fs';
import { runHttpKitCase, type HttpKitCase } from './http-kit';

const cases = JSON.parse(
  readFileSync(process.argv[2]!, 'utf8'),
) as HttpKitCase[];
let failed = 0;
for (const c of cases) {
  const failure = await runHttpKitCase(c);
  if (failure) {
    failed++;
    console.log(JSON.stringify({ case: c.name, ...failure }));
  }
}
console.log(`${cases.length - failed} of ${cases.length} cases passed`);
process.exitCode = failed ? 1 : 0;
