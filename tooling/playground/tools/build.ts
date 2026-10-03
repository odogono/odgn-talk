#!/usr/bin/env bun
// Build the Playground into a static `dist/`: the page script, its
// workers, the page and its styles. Any static host can serve the result.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const dist = resolve(root, 'dist');

export const build = async ({ minify = true } = {}): Promise<void> => {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const result = await Bun.build({
    entrypoints: [
      'main.ts',
      'session.worker.ts',
      'lsp.worker.ts',
      'syntax.worker.ts',
    ].map(f => resolve(root, 'src', f)),
    outdir: dist,
    target: 'browser',
    format: 'esm',
    naming: '[name].[ext]',
    minify,
    sourcemap: 'linked',
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'Playground build failed');
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
  console.log(`Built the Playground in ${dist}`);
}
