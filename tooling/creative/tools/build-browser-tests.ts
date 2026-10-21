#!/usr/bin/env bun
// Build Folio and every browser test suite into `dist/`: one
// `<suite>.browser.js` per `tests/*.browser.ts`, and a `<suite>-test.html`
// page without the app's own `main.js` for each suite that mounts the UI
// itself. Serve `dist/` with `bun run creative` or `start`, then run each
// suite in its own fresh tab (see NAVIGATION.md). The watch server empties
// `dist/` when it rebuilds the app, so run this again after a rebuild.
// `bun run test:browser` ([browser-tests.ts](browser-tests.ts)) runs them all.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build, dist } from './build';

const tests = resolve(import.meta.dir, '../tests');

/** Suites that run on the normal page, with the app and its service worker. */
const onAppPage = new Set(['offline', 'rich-text', 'storage']);

export type BrowserSuite = { name: string; page: string };

/** Builds the app and every suite; each suite with the page it runs on. */
export const buildBrowserTests = async (): Promise<BrowserSuite[]> => {
  const suites = readdirSync(tests)
    .filter(file => file.endsWith('.browser.ts'))
    .map(file => file.slice(0, -'.browser.ts'.length))
    .sort();
  await build({ minify: false });
  const result = await Bun.build({
    entrypoints: suites.map(suite => resolve(tests, `${suite}.browser.ts`)),
    outdir: dist,
    target: 'browser',
    format: 'esm',
    naming: '[name].[ext]',
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'Browser test build failed');
  }
  const page = readFileSync(resolve(dist, 'index.html'), 'utf8')
    .split('\n')
    .filter(line => !line.includes('src="./main.js"'))
    .join('\n');
  return suites.map(name => {
    if (onAppPage.has(name)) {
      return { name, page: '/' };
    }
    writeFileSync(resolve(dist, `${name}-test.html`), page);
    return { name, page: `/${name}-test.html` };
  });
};

if (import.meta.main) {
  for (const suite of await buildBrowserTests()) {
    console.log(
      `${suite.name}: open ${suite.page}, import /${suite.name}.browser.js`,
    );
  }
}
