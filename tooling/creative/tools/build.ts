#!/usr/bin/env bun
// Build the creative tool into a static `dist/`: the page script, the LSP
// worker, the page and its styles. Any static host can serve the result.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
export const dist = resolve(root, 'dist');

export const build = async ({ minify = true } = {}): Promise<void> => {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const result = await Bun.build({
    entrypoints: [
      resolve(root, 'src/main.ts'),
      resolve(root, '../editor/src/lsp.worker.ts'),
    ],
    outdir: dist,
    target: 'browser',
    format: 'esm',
    naming: '[name].[ext]',
    minify,
    sourcemap: 'linked',
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'Creative tool build failed');
  }
  for (const file of ['index.html', 'style.css']) {
    copyFileSync(resolve(root, 'static', file), resolve(dist, file));
  }
  copyFileSync(
    resolve(root, '../../impl/ts/src/generated/UNICODE-LICENSE.txt'),
    resolve(dist, 'UNICODE-LICENSE.txt'),
  );
};

if (import.meta.main) {
  await build();
  console.log(`Built the creative tool in ${dist}`);
}
