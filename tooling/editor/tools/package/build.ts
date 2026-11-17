#!/usr/bin/env bun
// Build @northtalk/editor into dist/: ESM and declarations for the one
// published entry, the package manifest, and the licence. Publishing runs from
// dist/. The language-server and breakpoint modules stay workspace-only
// (ADR 0182).
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'tsdown';
import { manifest } from './manifest';

const root = resolve(import.meta.dir, '../..');
const dist = resolve(root, 'dist');

await build({
  config: false,
  cwd: root,
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  dts: true,
  outDir: dist,
  clean: true,
  // The Core and CodeMirror are the Host's own copies: never bundle them.
  deps: { neverBundle: [/^@northtalk\//, /^@codemirror\//, /^@lezer\//] },
  logLevel: 'warn',
});

const source = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const published = manifest(source);
writeFileSync(
  resolve(dist, 'package.json'),
  JSON.stringify(published, null, 2) + '\n',
);
copyFileSync(resolve(root, '../../LICENSE'), resolve(dist, 'LICENSE'));
copyFileSync(resolve(import.meta.dir, 'README.md'), resolve(dist, 'README.md'));
console.log(`Built @northtalk/editor ${published.version} in dist/`);
