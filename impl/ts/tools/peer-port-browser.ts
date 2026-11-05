#!/usr/bin/env bun
// Two peer routers in a real browser (ADR 0165): a page's Host and a Web
// Worker's Host carry Remote Sends over the Worker's own messages.
// bun impl/ts/tools/peer-port-browser.ts
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
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
const scripts: Record<string, Blob> = {
  '/page.js': await bundle('peer-port-browser/page.ts'),
  '/worker.js': await bundle('peer-port-browser/worker.ts'),
};
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: request => {
    const script = scripts[new URL(request.url).pathname];
    if (script) {
      return new Response(script, {
        headers: { 'content-type': 'text/javascript' },
      });
    }
    return new Response(
      '<!doctype html><title>Peer router over a Worker</title><script type="module" src="/page.js"></script>',
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
  assert.deepEqual(result, {
    result: '[[13,"port","billing"],"port","page"]',
    stall: 'unreachable',
  });
  console.log('Browser peer router: a Worker carried Remote Sends');
} finally {
  await browser.close();
  await server.stop();
}
