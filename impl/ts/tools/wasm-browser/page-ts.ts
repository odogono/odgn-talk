// The browser figures page on the TS Core.
import { run } from '../../examples/core-switch/ts';
// eslint-disable-next-line import-x/no-namespace -- the Host takes the whole package.
import * as northtalk from '../../src/index';
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
  results.resolve({ scenario: await run(), bench: await bench(nt) });
} catch (error) {
  results.reject(error);
}
page.memory = memoryProbe(nt);
