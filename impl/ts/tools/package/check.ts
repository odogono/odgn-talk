#!/usr/bin/env bun
// Check the package as npm consumers get it: pack dist/, install the tarball
// in a scratch project outside the workspace, then run it under Node and Bun,
// load it unbundled in a browser through an import map, and typecheck a
// consumer against each supported TypeScript.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { entries, outputName, type Subpath } from './entries';

/** The oldest TypeScript the declarations support, and the newest. */
const typescripts = ['5.9', 'latest'];

const root = resolve(import.meta.dir, '../..');
const dist = resolve(root, 'dist');
const scratch = mkdtempSync(join(tmpdir(), 'northtalk-package-'));

const run = (command: string, args: string[], cwd = scratch) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
};

const { version } = JSON.parse(
  readFileSync(join(dist, 'package.json'), 'utf8'),
);
const tarball = join(
  scratch,
  JSON.parse(
    run('npm', ['pack', dist, '--json', '--pack-destination', scratch]),
  )[0].filename,
);
cpSync(resolve(import.meta.dir, 'consumer'), scratch, { recursive: true });
writeFileSync(
  join(scratch, 'package.json'),
  JSON.stringify({ private: true, type: 'module' }),
);
run('npm', ['install', '--no-audit', '--no-fund', tarball]);
console.log(`Packed and installed @northtalk/ts ${version} in ${scratch}`);

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

// The browser fetches each module as it is, as an unbundled Host serves them.
const browserSubpaths = (Object.keys(entries) as Subpath[]).filter(
  subpath => subpath !== './sqlite',
);
const imports = Object.fromEntries(
  browserSubpaths.map(subpath => [
    subpath === '.' ? '@northtalk/ts' : `@northtalk/ts/${subpath.slice(2)}`,
    `/node_modules/@northtalk/ts/${outputName(subpath)}.js`,
  ]),
);
const page = `<!doctype html>
<script type="importmap">${JSON.stringify({ imports })}</script>
<script type="module">
  import { smoke } from '/smoke.js';
  smoke().then(r => (document.title = 'ok: ' + r), e => (document.title = 'error: ' + e.stack));
</script>`;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') {
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    }
    const file = Bun.file(join(scratch, path));
    return file.size ? new Response(file) : new Response('', { status: 404 });
  },
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
