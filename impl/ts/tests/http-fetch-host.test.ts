// The Node/Bun `fetch` client against local HTTP and TLS servers (chapter 7,
// Fetching; chapter 9, The `http` factory; ADR 0151).
import { afterAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { newDrivenGroup } from '../src/driver';
import { HostError } from '../src/errors';
import {
  createHttpFetch,
  createHttpHost,
  httpFetchOrigins,
  type HttpFetchOptions,
} from '../src/http/index';
import { httpCapability } from '../src/http-capability';
import { newGroup } from '../src/index';
import type { Value } from '../src/values';

const tls = (name: string) => ({
  key: readFileSync(join(import.meta.dir, 'fixtures/http-tls', `${name}.key`)),
  cert: readFileSync(join(import.meta.dir, 'fixtures/http-tls', `${name}.crt`)),
});
const local = tls('local');
const other = tls('other');

// The Script's handler fetches with these expressions, as source text, and
// returns the result or the error.
const source = (message: string, args: readonly string[]) =>
  message === 'bounded'
    ? `on go
  try
    with timeout of 200 ms
      ask http to fetch ${args.join(', ')} and wait
    end timeout
    return it
  catch e
    return e
  end try
end go`
    : `on go
  try
    ask http to fetch ${args.join(', ')} and wait
    return it
  catch e
    return e
  end try
end go`;

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
});

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const listen = async (
  handler: Handler,
  secure?: { cert: Buffer; key: Buffer },
) => {
  const server = secure
    ? createTlsServer(secure, handler)
    : createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `${secure ? 'https' : 'http'}://127.0.0.1:${port}`;
};

const fetchWith = async (
  options: HttpFetchOptions,
  message: string,
  args: readonly string[],
  binding?: unknown,
) => {
  const driven = newDrivenGroup({ newGroup }, { name: 'g' });
  const script = driven.group.load({
    name: 's',
    source: source(message, args),
    grants: {
      http: httpCapability(createHttpFetch(options), {
        fetch: { fuel: 1 },
      }).grant('all', binding),
    },
  });
  const result = await script.request({ name: 'go' }).result;
  await driven.drive.close();
  return result;
};

const field = (v: Value, ...path: string[]) =>
  path.reduce((at, key) => at.get(key), v);
const decoded = (v: Value) =>
  new TextDecoder().decode(field(v, 'body').asBytes()!);

test('fetch makes one request with the Script headers, identity encoding and no cookies, and returns the response as sent', async () => {
  let seen: IncomingMessage | undefined;
  const origin = await listen((req, res) => {
    seen = req;
    res.setHeader('content-encoding', 'gzip');
    res.setHeader('set-cookie', ['a=1', 'b=2']);
    res.setHeader('x-repeat', ['1', '2']);
    res.end('not really gzip');
  });
  const result = await fetchWith({ origins: [origin] }, 'get', [
    `"${origin}/users#top"`,
    '{query: {email: "ann@example.com", tag: ["a b", "ü"]}, headers: {"X-Token": "t"}}',
  ]);
  expect(seen!.url).toBe('/users?email=ann%40example.com&tag=a%20b&tag=%C3%BC');
  expect(seen!.headers['accept-encoding']).toBe('identity');
  expect(seen!.headers['x-token']).toBe('t');
  expect(seen!.headers.cookie).toBeUndefined();
  expect(field(result, 'status').toString()).toBe('200');
  expect(decoded(result)).toBe('not really gzip');
  const headers = field(result, 'headers');
  expect(headers.entries().map(([k]) => k)).toEqual(
    headers
      .entries()
      .map(([k]) => k)
      .sort(),
  );
  expect(field(headers, 'set-cookie').toString()).toBe('["a=1", "b=2"]');
  expect(field(headers, 'x-repeat').asText()).toBe('1, 2');
  expect(field(headers, 'content-encoding').asText()).toBe('gzip');
});

test('a body is sent with its default content type, and the Script may set its own accept-encoding', async () => {
  const got: { body: string; enc?: string; length?: string; type?: string }[] =
    [];
  const origin = await listen((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      got.push({
        type: req.headers['content-type'],
        length: req.headers['content-length'],
        enc: req.headers['accept-encoding'],
        body,
      });
      res.statusCode = 201;
      res.end();
    });
  });
  await fetchWith({ origins: 'any' }, 'get', [
    `"${origin}/"`,
    '{method: "POST", json: {n: 1}}',
  ]);
  await fetchWith({ origins: 'any' }, 'get', [
    `"${origin}/"`,
    '{method: "PUT", body: "hé", headers: {"Accept-Encoding": "gzip"}}',
  ]);
  expect(got).toEqual([
    {
      type: 'application/json',
      length: '7',
      enc: 'identity',
      body: '{"n":1}',
    },
    {
      type: 'text/plain; charset=utf-8',
      length: '3',
      enc: 'gzip',
      body: 'hé',
    },
  ]);
});

test('a redirect, a 404 and a 500 are answers, and no redirect is followed', async () => {
  let requests = 0;
  const origin = await listen((req, res) => {
    requests++;
    if (req.url === '/moved') {
      res.writeHead(302, { location: '/elsewhere' });
    } else {
      res.statusCode = req.url === '/missing' ? 404 : 500;
    }
    res.end();
  });
  const moved = await fetchWith({ origins: 'any' }, 'get', [
    `"${origin}/moved"`,
    'nothing',
  ]);
  expect(field(moved, 'status').toString()).toBe('302');
  expect(field(moved, 'headers', 'location').asText()).toBe('/elsewhere');
  for (const [path, status] of [
    ['missing', '404'],
    ['broken', '500'],
  ] as const) {
    const r = await fetchWith({ origins: 'any' }, 'get', [
      `"${origin}/${path}"`,
      'nothing',
    ]);
    expect(field(r, 'status').toString()).toBe(status);
  }
  expect(requests).toBe(3);
});

test('informational responses are skipped', async () => {
  const origin = await listen((_req, res) => {
    res.writeEarlyHints({ link: '</a.css>; rel=preload' });
    res.end('final');
  });
  const r = await fetchWith({ origins: 'any' }, 'get', [
    `"${origin}/"`,
    'nothing',
  ]);
  expect(field(r, 'status').toString()).toBe('200');
  expect(decoded(r)).toBe('final');
});

test('an origin the binding does not allow is bad address, and the default allows none', async () => {
  let requests = 0;
  const origin = await listen((_req, res) => {
    requests++;
    res.end();
  });
  const code = async (options: HttpFetchOptions, binding?: unknown) =>
    field(
      await fetchWith(options, 'get', [`"${origin}/"`, 'nothing'], binding),
      'code',
    ).asText();
  expect(await code({})).toBe('bad address');
  expect(await code({ origins: [] })).toBe('bad address');
  expect(await code({ origins: ['https://127.0.0.1'] })).toBe('bad address');
  expect(
    await code(
      { origins: b => (b as { origins: string[] }).origins },
      { origins: ['http://example.com'] },
    ),
  ).toBe('bad address');
  expect(
    await code(
      { origins: b => (b as { origins: string[] }).origins },
      { origins: [origin.toUpperCase()] },
    ),
  ).toBeUndefined();
  expect(requests).toBe(1);
});

test('an origin list must be exact origins', () => {
  expect(
    httpFetchOrigins(['HTTPS://Example.com:443', 'http://a.test:8080']),
  ).toEqual(new Set(['https://example.com:443', 'http://a.test:8080']));
  for (const bad of [
    ['https://example.com/api'],
    ['https://example.com/'],
    ['https://example.com#a'],
    ['https://*.example.com'],
    ['https://example.com?x'],
    'all',
    [1],
  ]) {
    expect(() => httpFetchOrigins(bad as string[])).toThrow(HostError);
    expect(() => createHttpFetch({ origins: bad as string[] })).toThrow(
      HostError,
    );
  }
});

test('a body or headers past their bound are response too large, with no partial response', async () => {
  const origin = await listen((req, res) => {
    if (req.url === '/headers') {
      res.setHeader('x-big', 'x'.repeat(200));
    }
    res.end('y'.repeat(100));
  });
  const options = {
    origins: 'any' as const,
    maxBodyBytes: 99,
    maxHeaderBytes: 150,
  };
  for (const path of ['body', 'headers']) {
    const r = await fetchWith(options, 'get', [
      `"${origin}/${path}"`,
      'nothing',
    ]);
    expect(field(r, 'code').asText()).toBe('response too large');
    expect(field(r, 'field').asText()).toBe(path);
    expect(field(r, 'limit').toString()).toBe(path === 'body' ? '99' : '150');
  }
  const exact = await fetchWith({ origins: 'any', maxBodyBytes: 100 }, 'get', [
    `"${origin}/body"`,
    'nothing',
  ]);
  expect(field(exact, 'status').toString()).toBe('200');
});

test('a refused connection, a cut-off response and a switch of protocols are network errors', async () => {
  const closed = await listen(() => {});
  const port = Number(new URL(closed).port);
  await new Promise(resolve => servers.pop()!.close(resolve));
  const cut = await listen((_req, res) => {
    res.writeHead(200, { 'content-length': '10' });
    res.write('abc');
    res.socket?.destroy();
  });
  const upgrade = await listen(() => {});
  servers.at(-1)!.on('upgrade', (_req, socket) => {
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: x\r\n\r\n',
    );
  });
  const switching = await listen((_req, res) => {
    res.socket?.end('HTTP/1.1 101 Switching Protocols\r\n\r\n');
  });
  for (const url of [`http://127.0.0.1:${port}/`, `${cut}/`, `${switching}/`]) {
    const r = await fetchWith({ origins: 'any' }, 'get', [
      `"${url}"`,
      'nothing',
    ]);
    expect([url, field(r, 'code').asText()]).toEqual([url, 'network error']);
  }
  expect(upgrade).toBeString();
});

test('HTTPS verifies the certificate and the host name', async () => {
  const good = await listen((_req, res) => res.end('secure'), local);
  const misnamed = await listen((_req, res) => res.end('secure'), other);
  const trusted = { origins: 'any' as const, ca: [local.cert, other.cert] };
  const ok = await fetchWith(trusted, 'get', [`"${good}/"`, 'nothing']);
  expect(decoded(ok)).toBe('secure');
  const untrusted = await fetchWith({ origins: 'any' }, 'get', [
    `"${good}/"`,
    'nothing',
  ]);
  expect(field(untrusted, 'code').asText()).toBe('network error');
  const wrongName = await fetchWith(trusted, 'get', [
    `"${misnamed}/"`,
    'nothing',
  ]);
  expect(field(wrongName, 'code').asText()).toBe('network error');
});

test('an abandoned call aborts its request', async () => {
  let closed!: () => void;
  const aborted = new Promise<void>(resolve => (closed = resolve));
  const origin = await listen((req, _res) => {
    req.socket.on('close', closed);
  });
  const r = await fetchWith({ origins: 'any' }, 'bounded', [`"${origin}/"`]);
  expect(field(r, 'code').asText()).toBe('timeout');
  await aborted;
});

test('the router offers fetch beside serving when asked, and only serves by default', () => {
  const costs = {
    serve: { fuel: 1 },
    unserve: { fuel: 1 },
    respond: { fuel: 1 },
    fetch: { fuel: 1 },
  };
  const ops = (impl: Parameters<typeof httpCapability>[0]) =>
    [...httpCapability(impl, costs).operations.keys()].sort();
  expect(ops(createHttpHost().impl)).toEqual(['respond', 'serve', 'unserve']);
  expect(ops(createHttpHost({ fetch: {} }).impl)).toEqual([
    'fetch',
    'respond',
    'serve',
    'unserve',
  ]);
  expect(ops(createHttpFetch())).toEqual(['fetch']);
});
