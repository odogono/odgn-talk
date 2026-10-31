// Runs the `fetch` client's transport checks in whichever runtime runs this
// file, bundled, so they hold under Node as well as Bun (ADR 0151). Takes the
// TLS fixture directory, and prints each failure and a count.
//   node http-fetch-runtime.js tests/fixtures/http-tls
import { readFileSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Call } from '../src/capabilities';
import { createHttpFetch, type HttpFetchOptions } from '../src/http/index';
import { map, text, type Value } from '../src/values';

const dir = process.argv[2]!;
const cert = readFileSync(join(dir, 'local.crt'));
const key = readFileSync(join(dir, 'local.key'));
const servers: Server[] = [];

const listen = async (handler: RequestListener, secure = false) => {
  const server = secure
    ? createTlsServer({ key, cert }, handler)
    : createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `${secure ? 'https' : 'http'}://127.0.0.1:${port}`;
};

type Outcome = { body?: string; code?: string; status?: string; value?: Value };

// One fetch through a stand-in Call; `abortAfter` aborts it.
const fetchOnce = (
  options: HttpFetchOptions,
  url: string,
  abortAfter?: number,
): Promise<Outcome> =>
  new Promise(resolve => {
    const controller = new AbortController();
    const call = {
      binding: undefined,
      signal: controller.signal,
      answer: (v: Value) =>
        resolve({
          status: v.get('status').toString(),
          body: new TextDecoder().decode(v.get('body').asBytes()!),
          value: v,
        }),
      fail: (e: { code: string }) => resolve({ code: e.code }),
    } as unknown as Call<unknown>;
    createHttpFetch(options).fetch(call, url, map([['method', text('GET')]]));
    if (abortAfter !== undefined) {
      setTimeout(() => {
        controller.abort();
        resolve({ code: 'aborted' });
      }, abortAfter);
    }
  });

const checks: [string, () => Promise<boolean>][] = [
  [
    'identity encoding, content as sent',
    async () => {
      let enc: string | undefined;
      const o = await listen((req, res) => {
        enc = req.headers['accept-encoding'];
        res.setHeader('content-encoding', 'gzip');
        res.end('raw');
      });
      const r = await fetchOnce({ origins: 'any' }, `${o}/`);
      return enc === 'identity' && r.body === 'raw';
    },
  ],
  [
    'no redirect followed',
    async () => {
      const o = await listen((_req, res) => {
        res.writeHead(302, { location: '/x' });
        res.end();
      });
      return (await fetchOnce({ origins: 'any' }, `${o}/`)).status === '302';
    },
  ],
  [
    '1xx skipped',
    async () => {
      const o = await listen((_req, res) => {
        res.writeEarlyHints({ link: '</a>; rel=preload' });
        res.end('final');
      });
      return (await fetchOnce({ origins: 'any' }, `${o}/`)).body === 'final';
    },
  ],
  [
    'body bound',
    async () => {
      const o = await listen((_req, res) => res.end('x'.repeat(10)));
      const r = await fetchOnce({ origins: 'any', maxBodyBytes: 9 }, `${o}/`);
      return r.code === 'response too large';
    },
  ],
  [
    'header bound',
    async () => {
      const o = await listen((_req, res) => {
        res.setHeader('x-big', 'x'.repeat(200));
        res.end();
      });
      const r = await fetchOnce(
        { origins: 'any', maxHeaderBytes: 100 },
        `${o}/`,
      );
      return r.code === 'response too large';
    },
  ],
  [
    'TLS verified',
    async () => {
      const o = await listen((_req, res) => res.end('s'), true);
      const untrusted = await fetchOnce({ origins: 'any' }, `${o}/`);
      const trusted = await fetchOnce({ origins: 'any', ca: cert }, `${o}/`);
      return untrusted.code === 'network error' && trusted.body === 's';
    },
  ],
  [
    'abort closes the request',
    async () => {
      let closed!: () => void;
      const gone = new Promise<void>(resolve => (closed = resolve));
      const o = await listen(req => req.socket.on('close', closed));
      await fetchOnce({ origins: 'any' }, `${o}/`, 50);
      await gone;
      return true;
    },
  ],
];

let failed = 0;
for (const [name, check] of checks) {
  const ok = await check().catch(() => false);
  if (!ok) {
    failed++;
    console.log(JSON.stringify({ check: name }));
  }
}
await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
console.log(`${checks.length - failed} of ${checks.length} checks passed`);
process.exitCode = failed ? 1 : 0;
