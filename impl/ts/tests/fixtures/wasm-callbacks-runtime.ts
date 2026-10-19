import { readFileSync } from 'node:fs';
import { callbackScenario } from '../../tools/wasm-callbacks';

// eslint-disable-next-line no-console -- the parent runtime test reads this result.
console.log(
  JSON.stringify(
    await callbackScenario(
      readFileSync(process.argv[2]!),
      process.argv[3] !== 'json',
    ),
  ),
);
