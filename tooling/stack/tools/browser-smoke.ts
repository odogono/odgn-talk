#!/usr/bin/env bun
import { resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const build = await Bun.build({
  entrypoints: [
    resolve(root, 'tests/verify.ts'),
    resolve(root, 'tests/verify-lsp.ts'),
  ],
  target: 'browser',
});
if (!build.success) {
  throw new Error('Browser fixture build failed', { cause: build.logs });
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 3927,
  fetch(request) {
    if (
      ['/verify.js', '/verify-lsp.js'].includes(new URL(request.url).pathname)
    ) {
      return new Response(
        build.outputs.find(output =>
          output.path.endsWith(new URL(request.url).pathname),
        ),
        {
          headers: { 'content-type': 'text/javascript' },
        },
      );
    }
    return new Response(
      `<!doctype html><html><title>NorthTalk Lint browser smoke</title><body><pre id="result">Running…</pre><script type="module">
import { verifyLintFixtures } from '/verify.js';
import { verifyLspFeatures } from '/verify-lsp.js';
try { document.querySelector('#result').textContent = 'PASS: ' + verifyLintFixtures() + ' Lint fixtures and ' + verifyLspFeatures() + ' LSP checks in a browser'; }
catch (error) { document.querySelector('#result').textContent = 'FAIL: ' + error.message; throw error; }
</script></body></html>`,
      { headers: { 'content-type': 'text/html' } },
    );
  },
});
console.log(`Lint browser smoke test: ${server.url}`);
