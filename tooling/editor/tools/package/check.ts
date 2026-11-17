#!/usr/bin/env bun
// Check the package as npm consumers get it: pack dist/ with the built
// @northtalk/ts it is a peer of, install both in a scratch project outside the
// workspace with CodeMirror from the registry, then run it under Node and Bun,
// typecheck a consumer against each supported TypeScript, and bundle a field
// with Bun for Chromium, where it must highlight and underline.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

/** The oldest TypeScript the declarations support, and the newest. */
const typescripts = ['5.9', 'latest'];

const root = resolve(import.meta.dir, '../..');
const dist = resolve(root, 'dist');
const coreDist = resolve(root, '../../impl/ts/dist');
const scratch = mkdtempSync(join(tmpdir(), 'northtalk-editor-package-'));

if (!existsSync(join(coreDist, 'package.json'))) {
  throw new Error('Build @northtalk/ts first: bun run --cwd impl/ts build');
}

const run = (command: string, args: string[], cwd = scratch) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
};

const pack = (directory: string) =>
  join(
    scratch,
    JSON.parse(
      run('npm', ['pack', directory, '--json', '--pack-destination', scratch]),
    )[0].filename,
  );

const version = (directory: string): string =>
  JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version;

cpSync(resolve(import.meta.dir, 'consumer'), scratch, { recursive: true });
writeFileSync(
  join(scratch, 'package.json'),
  JSON.stringify({ private: true, type: 'module' }),
);
// The CodeMirror peers come from the registry, as a Host installs them.
run('npm', [
  'install',
  '--no-audit',
  '--no-fund',
  pack(coreDist),
  pack(dist),
  '@codemirror/language@6',
  '@codemirror/lint@6',
  '@codemirror/state@6',
  '@codemirror/view@6',
]);
// One copy of @codemirror/state, or extensions fail at runtime.
const states = run('npm', ['ls', '@codemirror/state', '--all', '--parseable']);
if (new Set(states.split('\n')).size !== 1) {
  throw new Error(`more than one @codemirror/state:\n${states}`);
}
console.log(
  `Packed and installed @northtalk/editor ${version(dist)} with @northtalk/ts ${version(coreDist)} in ${scratch}`,
);

console.log(`node: ${run('node', ['node.js'])}`);
console.log(`bun: ${run(process.execPath, ['node.js'])}`);

for (const typescript of typescripts) {
  writeFileSync(
    join(scratch, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        verbatimModuleSyntax: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: false,
        noEmit: true,
        lib: ['ES2022', 'DOM'],
        types: [],
      },
      files: ['types.ts'],
    }),
  );
  run('npx', ['--yes', '-p', `typescript@${typescript}`, 'tsc', '-p', '.']);
  console.log(`types: TypeScript ${typescript}`);
}

// The browser loads one bundle, built from the installed packages as a Host's
// bundler would build it.
const bundle = await Bun.build({
  entrypoints: [join(scratch, 'browser.js')],
  target: 'browser',
  format: 'esm',
});
if (!bundle.success) {
  throw new AggregateError(bundle.logs, 'browser bundle failed');
}
const script = await bundle.outputs[0]!.text();
const page = `<!doctype html>
<meta charset="utf-8">
<div id="field"></div>
<script type="module">${script.replaceAll('</script', String.raw`<\/script`)}</script>`;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => new Response(page, { headers: { 'content-type': 'text/html' } }),
});
const browser = await chromium.launch();
try {
  const tab = await browser.newPage();
  await tab.goto(server.url.href);
  await tab.waitForFunction(() => document.title.length > 0);
  const title = await tab.title();
  if (!title.startsWith('ok: ')) {
    throw new Error(`browser: ${title}`);
  }
  console.log(`browser: ${title.slice(4)}`);
} finally {
  await browser.close();
  await server.stop();
}
