// Bundles the extension and the `northtalk` CLI it launches into dist/, so the
// packaged extension needs no checkout, Bun or node_modules.
import { copyFileSync, rmSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
rmSync(dist, { force: true, recursive: true });

const bundle = async (
  entry: string,
  outfile: string,
  format: 'cjs' | 'esm',
  external: string[] = [],
) => {
  const result = await Bun.build({
    entrypoints: [new URL(entry, import.meta.url).pathname],
    external,
    format,
    outdir: dist.pathname,
    naming: outfile,
    target: 'node',
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Cannot bundle ${entry}`);
  }
};

// VS Code loads extensions as CommonJS and supplies `vscode` itself.
await bundle('../src/extension.ts', 'extension.js', 'cjs', ['vscode']);
await bundle('../../cli/src/main.ts', 'server.mjs', 'esm');
copyFileSync(
  new URL(
    '../../../impl/ts/src/generated/UNICODE-LICENSE.txt',
    import.meta.url,
  ),
  new URL('UNICODE-LICENSE.txt', dist),
);
