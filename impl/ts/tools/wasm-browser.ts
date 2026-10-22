#!/usr/bin/env bun
// Runs the core-switch Host and the figures page on both Cores in headless
// Chromium, and measures each Core's payload (#1121). Prints JSON.
//
//   bun tools/wasm-browser.ts [--wasm path/to/talk.wasm] [--chrome path] [--serve]
//
// --serve only serves the pages, at http://127.0.0.1:3927/ts and /wasm, for a
// browser of your own. Otherwise Chromium comes from --chrome, $CHROME, or
// Playwright's cache.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bundle, measurePayload } from './payload';

const here = resolve(import.meta.dir);
const root = resolve(here, '../../..');
const args = Bun.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const wasmPath = resolve(
  option('--wasm') ?? resolve(root, '.cache/zig-wasi/bin/talk.wasm'),
);
const talkWasm = readFileSync(wasmPath);

const pages = {
  ts: await bundle(resolve(here, 'wasm-browser/page-ts.ts')),
  wasm: await bundle(resolve(here, 'wasm-browser/page-wasm.ts')),
};
// What a Host ships: the core-switch Host alone, and each whole package.
const measured = await measurePayload({ wasmPath });
const payload = {
  tsHost: measured.tsHost,
  wasmHost: measured.wasmHost,
  tsPackage: measured.tsPackage,
  wasmPackage: measured.wasmPackage,
  talkWasm: measured.talkWasm,
};

const html = (name: string) =>
  `<!doctype html><meta charset="utf-8"><title>NorthTalk ${name}</title><script type="module" src="/${name}.js"></script>`;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: args.includes('--serve') ? 3927 : 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const name = path.slice(1).replace(/\.js$/, '') as keyof typeof pages;
    // Cross-origin isolation lets the page measure its own memory.
    const isolated = {
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    };
    if (path === '/talk.wasm') {
      return new Response(talkWasm, {
        headers: { ...isolated, 'content-type': 'application/wasm' },
      });
    }
    if (name in pages && path.endsWith('.js')) {
      return new Response(pages[name], {
        headers: {
          ...isolated,
          'content-type': 'text/javascript; charset=utf-8',
        },
      });
    }
    if (name in pages) {
      return new Response(html(name), {
        headers: { ...isolated, 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return new Response('Not found', { status: 404 });
  },
});
if (args.includes('--serve')) {
  console.log(`Serving ${server.url}ts and ${server.url}wasm`);
  await new Promise(() => {});
}

const playwrightChrome = () => {
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const linuxCache = join(homedir(), '.cache/ms-playwright');
  for (const dir of [cache, linuxCache]) {
    try {
      const shell = readdirSync(dir).find(d =>
        d.startsWith('chromium_headless_shell-'),
      );
      if (shell) {
        const platform = readdirSync(join(dir, shell)).find(d =>
          d.startsWith('chrome-headless-shell'),
        )!;
        return join(dir, shell, platform, 'chrome-headless-shell');
      }
    } catch {
      // Not this platform's cache.
    }
  }
  return undefined;
};
const chrome = option('--chrome') ?? process.env.CHROME ?? playwrightChrome();
if (!chrome) {
  throw new Error(
    'No Chromium: pass --chrome, set $CHROME, or install Playwright',
  );
}

// One Chromium per page, so neither Core's heap or compiled code warms the other.
const measure = async (name: string): Promise<unknown> => {
  const profile = mkdtempSync(join(tmpdir(), 'northtalk-chrome-'));
  const browser = Bun.spawn(
    [
      chrome,
      '--headless',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      `${server.url}${name}`,
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  );
  try {
    let port = '';
    for (let tries = 0; !port && tries < 100; tries++) {
      await Bun.sleep(100);
      try {
        port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(
          '\n',
        )[0]!;
      } catch {
        // Not listening yet.
      }
    }
    const targets = (await (
      await fetch(`http://127.0.0.1:${port}/json`)
    ).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
    const page = targets.find(t => t.type === 'page' && t.url.endsWith(name))!;
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => socket.addEventListener('open', r, { once: true }));
    let id = 0;
    const send = (method: string, params: object = {}) =>
      new Promise<Record<string, unknown>>((done, fail) => {
        const mine = ++id;
        const listen = (event: MessageEvent) => {
          const reply = JSON.parse(String(event.data)) as {
            error?: { message: string };
            id?: number;
            result?: Record<string, unknown>;
          };
          if (reply.id !== mine) {
            return;
          }
          socket.removeEventListener('message', listen);
          if (reply.error) {
            fail(new Error(reply.error.message));
          } else {
            done(reply.result!);
          }
        };
        socket.addEventListener('message', listen);
        socket.send(JSON.stringify({ id: mine, method, params }));
      });
    const evaluate = async (expression: string) => {
      const reply = (await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })) as {
        exceptionDetails?: { exception?: { description?: string } };
        result: { value: unknown };
      };
      if (reply.exceptionDetails) {
        throw new Error(
          reply.exceptionDetails.exception?.description ?? 'page threw',
        );
      }
      return reply.result.value;
    };
    // The JS heap after a full collection.
    const heap = async () => {
      await send('HeapProfiler.collectGarbage');
      return ((await send('Runtime.getHeapUsage')) as { usedSize: number })
        .usedSize;
    };
    // The module may not have run yet when the page target appears.
    for (let tries = 0; tries < 100; tries++) {
      if (await evaluate('typeof results !== "undefined"')) {
        break;
      }
      await Bun.sleep(100);
    }
    const result = (await evaluate(
      `results.then(r => ({ ...r, scenario: { ...r.scenario, trace: r.scenario.trace.length }, userAgent: navigator.userAgent }))`,
    )) as { bench: Record<string, number> };
    // Memory per Group: fifty Groups on a fresh Core, after the figures.
    await evaluate('memory.then(m => { globalThis.probe = m; })');
    await evaluate('probe.grow(1)');
    const before = await heap();
    const linear = (await evaluate('probe.grow(50)')) as number;
    const after = await heap();
    result.bench.jsHeapPerGroupBytes = Math.round((after - before) / 50);
    result.bench.linearMemoryPerGroupBytes = Math.round(linear / 50);
    socket.close();
    return result;
  } finally {
    browser.kill();
  }
};

const results = {
  ts: await measure('ts'),
  wasm: await measure('wasm'),
  payload,
};
console.log(JSON.stringify(results, null, 2));
await server.stop(true);
