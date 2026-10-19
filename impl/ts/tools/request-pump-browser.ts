#!/usr/bin/env bun
// Repository browser verification workflow: real transferred ArrayBuffers to
// a worker running the TS Core, and both callback layouts in a WASM worker.
// Build .cache/zig-wasi/bin/talk.wasm first, then:
// bun impl/ts/tools/request-pump-browser.ts
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const bundle = async (entry: string) => {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, entry)],
    target: 'browser',
  });
  if (!build.success) {
    throw new AggregateError(build.logs, 'Browser bundle failed');
  }
  return build.outputs[0]!;
};
const page = await bundle('request-pump-browser/page.ts');
const worker = await bundle('../tests/fixtures/request-pump.worker.ts');
const wasmWorker = await bundle('../tests/fixtures/wasm-callbacks.worker.ts');
const wasm = readFileSync(
  resolve(import.meta.dirname, '../../../.cache/zig-wasi/bin/talk.wasm'),
);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: request => {
    const path = new URL(request.url).pathname;
    if (path === '/talk.wasm') {
      return new Response(wasm, {
        headers: { 'content-type': 'application/wasm' },
      });
    }
    if (path === '/wasm-worker.js') {
      return new Response(wasmWorker, {
        headers: { 'content-type': 'text/javascript' },
      });
    }
    if (path === '/page.js') {
      return new Response(page, {
        headers: { 'content-type': 'text/javascript' },
      });
    }
    if (path === '/worker.js') {
      return new Response(worker, {
        headers: { 'content-type': 'text/javascript' },
      });
    }
    return new Response(
      '<!doctype html><title>Request/Pump worker interoperability</title><script type="module" src="/page.js"></script>',
      { headers: { 'content-type': 'text/html' } },
    );
  },
});
const browser = await chromium.launch({ executablePath: process.env.CHROME });
try {
  const tab = await browser.newPage();
  await tab.goto(server.url.toString());
  await tab.waitForFunction(() => 'results' in globalThis);
  const result = await tab.evaluate(
    () => (globalThis as { results?: Promise<unknown> }).results,
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await server.stop();
}
