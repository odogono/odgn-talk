#!/usr/bin/env bun
// Serve the built package in an actual browser; see tests/browser-smoke.html.
import { resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const bundlePath = resolve(root, 'dist/index.js');
if (!(await Bun.file(bundlePath).exists())) {
  throw new Error('Run bun run build before the browser smoke test');
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 3926,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') {
      return new Response(Bun.file(resolve(root, 'tests/browser-smoke.html')), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    // dist/ holds the entry modules and the chunks they import.
    const file = Bun.file(resolve(root, 'dist', `.${path}`));
    if (path.endsWith('.js') && !path.includes('..') && (await file.exists())) {
      return new Response(file, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }
    if (path === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }
    return new Response('Not found', { status: 404 });
  },
});
console.log(`Browser smoke test: ${server.url}`);
