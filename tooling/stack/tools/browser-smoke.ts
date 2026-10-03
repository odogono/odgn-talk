#!/usr/bin/env bun
import { resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const build = await Bun.build({
  entrypoints: [resolve(root, 'tests/verify.ts')],
  target: 'browser',
});
if (!build.success) {
  throw new Error('Browser fixture build failed', { cause: build.logs });
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 3927,
  fetch(request) {
    if (new URL(request.url).pathname === '/verify.js') {
      return new Response(build.outputs[0], {
        headers: { 'content-type': 'text/javascript' },
      });
    }
    return new Response(
      `<!doctype html><html><title>NorthTalk Lint browser smoke</title><body><pre id="result">Running…</pre><script type="module">
import { verifyLintFixtures } from '/verify.js';
try { document.querySelector('#result').textContent = 'PASS: ' + verifyLintFixtures() + ' Lint fixtures in a browser'; }
catch (error) { document.querySelector('#result').textContent = 'FAIL: ' + error.message; throw error; }
</script></body></html>`,
      { headers: { 'content-type': 'text/html' } },
    );
  },
});
console.log(`Lint browser smoke test: ${server.url}`);
