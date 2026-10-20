#!/usr/bin/env bun
// Build @northtalk/ts into dist/: ESM and declarations for each published
// subpath, the package manifest, and the licences. Publishing runs from dist/.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'tsdown';
import { entries, outputName, type Subpath } from './entries';
import { manifest } from './manifest';

const root = resolve(import.meta.dir, '../..');
const dist = resolve(root, 'dist');
const subpaths = Object.keys(entries) as Subpath[];

await build({
  config: false,
  cwd: root,
  entry: Object.fromEntries(
    subpaths.map(subpath => [outputName(subpath), entries[subpath]]),
  ),
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  // Declaration bundling drops the driver's source-level lib reference.
  banner: ({ fileName }) =>
    fileName === 'driver.d.ts'
      ? { dts: '/// <reference lib="esnext.disposable" />' }
      : undefined,
  outDir: dist,
  clean: true,
  deps: { neverBundle: [/^node:/] },
  logLevel: 'warn',
});

const source = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
writeFileSync(
  resolve(dist, 'package.json'),
  JSON.stringify(manifest(source, subpaths), null, 2) + '\n',
);
copyFileSync(resolve(root, '../../LICENSE'), resolve(dist, 'LICENSE'));
copyFileSync(
  resolve(root, 'src/generated/UNICODE-LICENSE.txt'),
  resolve(dist, 'UNICODE-LICENSE.txt'),
);
copyFileSync(resolve(import.meta.dir, 'README.md'), resolve(dist, 'README.md'));
console.log(
  `Built @northtalk/ts ${manifest(source, subpaths).version} in dist/`,
);
