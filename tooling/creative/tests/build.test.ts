import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { build, dist } from '../tools/build';

test('the build writes the page, its script and the LSP worker', async () => {
  await build({ minify: false });
  for (const file of [
    'index.html',
    'style.css',
    'main.js',
    'lsp.worker.js',
    'UNICODE-LICENSE.txt',
  ]) {
    expect(existsSync(resolve(dist, file))).toBe(true);
  }
}, 60_000);
