#!/usr/bin/env bun
// Runs every Folio browser suite headless: builds them once, serves `dist/`,
// and calls each `run*BrowserTests` export in its own fresh browser context,
// so no tab, storage or service worker carries over between runs. Only the
// suites on the app page keep the service worker, which `offline` tests.
// `--suite play,tetris` runs a subset; `--headed` shows the browser and
// `--channel chrome` uses an installed Chrome. `--timeout` bounds each page
// step and `--run-timeout` a whole run, so a run that hangs fails instead.
import { extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser } from 'playwright';
import { dist } from './build';
import { buildBrowserTests, type BrowserSuite } from './build-browser-tests';

const { values } = parseArgs({
  options: {
    channel: { type: 'string' },
    headed: { type: 'boolean', default: false },
    suite: { type: 'string' },
    'run-timeout': { type: 'string', default: '300000' },
    timeout: { type: 'string', default: '120000' },
  },
});
const timeout = Number(values.timeout);
const runTimeout = Number(values['run-timeout']);
const only = values.suite?.split(',').map(name => name.trim());

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

type Check = { error?: string; name?: string; passed: boolean };
type Outcome = { checks: Check[]; error?: string; run: string; suite: string };

// A suite returns one result or a list of them; each must have passed.
const checksOf = (result: unknown): Check[] =>
  (Array.isArray(result) ? result : [result]).map(check =>
    check && typeof check === 'object' && 'passed' in check
      ? (check as Check)
      : { passed: false, error: `Not a result: ${JSON.stringify(check)}` },
  );

const runOne = async (
  browser: Browser,
  origin: string,
  suite: BrowserSuite,
  run: string | undefined,
): Promise<{ exports: string[]; outcome?: Outcome }> => {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1200 },
    serviceWorkers: suite.page === '/' ? 'allow' : 'block',
  });
  const pageErrors: string[] = [];
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto(new URL(suite.page, origin).href);
    // `page.evaluate` has no timeout of its own, so race it against one.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Run timed out after ${runTimeout} ms`)),
        runTimeout,
      );
    });
    const evaluated = page.evaluate(
      async ({ module, run }) => {
        const loaded = (await import(module)) as Record<string, unknown>;
        const exports = Object.keys(loaded).filter(name =>
          /^run\w*BrowserTests$/u.test(name),
        );
        if (run === undefined) {
          return { exports };
        }
        return {
          exports,
          value: await (loaded[run] as () => Promise<unknown>)(),
        };
      },
      { module: `/${suite.name}.browser.js`, run },
    );
    const result = await Promise.race([evaluated, deadline]).finally(() =>
      clearTimeout(timer),
    );
    if (run === undefined) {
      return { exports: result.exports };
    }
    const checks = checksOf(result.value);
    return {
      exports: result.exports,
      outcome: {
        suite: suite.name,
        run,
        checks,
        ...(pageErrors.length ? { error: pageErrors.join('\n') } : {}),
      },
    };
  } catch (error) {
    return {
      exports: [],
      outcome: {
        suite: suite.name,
        run: run ?? '(load)',
        checks: [],
        error: [String(error), ...pageErrors].join('\n'),
      },
    };
  } finally {
    await context.close();
  }
};

const suites = (await buildBrowserTests()).filter(
  suite => !only || only.includes(suite.name),
);
if (only) {
  const missing = only.filter(name => !suites.some(s => s.name === name));
  if (missing.length) {
    throw new Error(`No browser suite named ${missing.join(', ')}`);
  }
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
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
const browser = await chromium.launch({
  headless: !values.headed,
  ...(values.channel ? { channel: values.channel } : {}),
});
const outcomes: Outcome[] = [];
try {
  for (const suite of suites) {
    // A first load lists the suite's exports; each then runs on its own.
    const listed = await runOne(browser, server.url.href, suite, undefined);
    if (listed.outcome) {
      outcomes.push(listed.outcome);
    }
    for (const run of listed.exports) {
      const started = performance.now();
      const { outcome } = await runOne(browser, server.url.href, suite, run);
      const failed =
        !!outcome!.error || outcome!.checks.some(check => !check.passed);
      console.log(
        `${failed ? 'FAIL' : 'pass'} ${suite.name} ${run} (${Math.round(performance.now() - started)} ms)`,
      );
      outcomes.push(outcome!);
    }
  }
} finally {
  await browser.close();
  await server.stop(true);
}

const failures = outcomes.filter(
  outcome => outcome.error || outcome.checks.some(check => !check.passed),
);
for (const failure of failures) {
  console.error(`\n${failure.suite} ${failure.run}`);
  if (failure.error) {
    console.error(`  ${failure.error}`);
  }
  for (const check of failure.checks.filter(c => !c.passed)) {
    console.error(`  ✗ ${check.name ?? '(unnamed)'}: ${check.error ?? ''}`);
  }
}
console.log(
  `\n${outcomes.length - failures.length} passed, ${failures.length} failed`,
);
process.exitCode = failures.length ? 1 : 0;
