#!/usr/bin/env bun
// Serve the built Playground locally. With `--watch`, rebuild on each change
// under src/ and static/ (the Core and tooling are rebuilt with it).
import { watch } from 'node:fs';
import { extname, resolve } from 'node:path';
import { build } from './build';

const root = resolve(import.meta.dir, '..');
const dist = resolve(root, 'dist');
const watching = Bun.argv.includes('--watch');
const port = Number(process.env.PORT ?? 3927);

await build({ minify: !watching });
if (watching) {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const rebuild = () => {
    if (pending) {
      clearTimeout(pending);
    }
    pending = setTimeout(() => {
      pending = null;
      build({ minify: false }).then(
        () => console.log('Rebuilt'),
        (error: unknown) => console.error(error),
      );
    }, 100);
  };
  for (const dir of ['src', 'static', '../stack/src', '../../impl/ts/src']) {
    watch(resolve(root, dir), { recursive: true }, rebuild);
  }
}

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(dist) || !(await Bun.file(file).exists())) {
      return new Response('Not found', { status: 404 });
    }
    return new Response(Bun.file(file), {
      headers: {
        'content-type': types[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      },
    });
  },
});
console.log(`NorthTalk Playground: ${server.url}`);
