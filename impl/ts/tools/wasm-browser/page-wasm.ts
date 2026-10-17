// The browser figures page on the Zig reactor. Only the imports and the
// reactor's URL differ from page-ts.ts.
import { run } from '../../examples/core-switch/wasm';
// eslint-disable-next-line import-x/no-namespace -- the Host takes the whole package.
import * as northtalk from '../../src/wasm/index';
import { bench, memoryProbe, type Bench } from './bench';

// The runner reads both through the DevTools protocol.
const page = globalThis as {
  memory?: ReturnType<typeof memoryProbe>;
  results?: Promise<unknown>;
};
const results = Promise.withResolvers<unknown>();
page.results = results.promise;
const nt = northtalk as unknown as Bench;
try {
  results.resolve({
    scenario: await run('/talk.wasm'),
    bench: await bench(nt, '/talk.wasm'),
  });
} catch (error) {
  results.reject(error);
}
page.memory = memoryProbe(nt, '/talk.wasm');
