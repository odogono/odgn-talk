import { expect, test } from 'bun:test';
import { fetchUrlText, parseFetchUrl } from '../src/http-fetch';
import {
  defineObjectKind,
  HostError,
  httpCapability,
  map,
  newGroup,
  num,
  parseInstant,
  text,
  type Call,
  type HttpImpl,
} from '../src/index';

const now = parseInstant('2026-10-22T12:00:00Z');
const costs = {
  serve: { fuel: 5 },
  unserve: { fuel: 2 },
  respond: { fuel: 3 },
};
const noHttp: HttpImpl = {
  serve: () => {},
  unserve: () => {},
  respond: () => {},
};
const exchangeKind = defineObjectKind({ name: 'httpExchange', props: {} });

// A Host that keeps what each Operation heard, and each `serve` call.
const recording = () => {
  const heard: unknown[][] = [];
  const calls: Call<unknown>[] = [];
  const impl: HttpImpl = {
    serve: (call, name, prefix, message, options) => {
      heard.push(['serve', name, prefix, message, options.toString()]);
      calls.push(call);
    },
    unserve: (_call, name) => {
      heard.push(['unserve', name]);
    },
    respond: (_call, exchange, response) => {
      const json = response.get('json');
      heard.push([
        'respond',
        exchange.id,
        json.kind === 'nothing' ? response.toString() : json.asText(),
      ]);
    },
  };
  return { calls, heard, impl };
};

const run = ({ calls, impl }: ReturnType<typeof recording>, body: string) => {
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source: `script variable seen = "pending"\non go\n  try\n    ${body}\n    put it into seen\n  catch {code: code, field: f}\n    put [code, f] into seen\n  end\nend`,
    grants: { http: httpCapability(impl, costs).grant('all', undefined) },
  });
  s.deliver({ name: 'go' });
  g.pump(now);
  calls.splice(0).forEach(call =>
    call.answer(
      map([
        ['host', text('127.0.0.1')],
        ['port', num(8080)],
      ]),
    ),
  );
  g.pump(now);
  return new Map(g.inspect().scripts.find(x => x.name === 's')!.vars).get(
    'seen',
  )!;
};

test('http validates its Host methods and needs every Operation cost', () => {
  for (const name of ['serve', 'unserve', 'respond'] as const) {
    const { [name]: _, ...rest } = costs;
    expect(() => httpCapability(noHttp, rest)).toThrow(HostError);
    const { [name]: __, ...partial } = noHttp;
    expect(() => httpCapability(partial as unknown as HttpImpl, costs)).toThrow(
      HostError,
    );
  }
  expect([...httpCapability(noHttp, costs).operations.keys()].sort()).toEqual([
    'respond',
    'serve',
    'unserve',
  ]);
});

test('serve hears the effective message and an omitted options as an empty map', () => {
  const host = recording();
  const { heard } = host;
  expect(run(host, 'ask http to serve "site", "/" and wait').toString()).toBe(
    '{host: "127.0.0.1", port: 8080}',
  );
  run(host, 'ask http to serve "api", "/api", nothing, {port: 0} and wait');
  expect(heard).toEqual([
    ['serve', 'site', '/', 'httpRequest', '{}'],
    ['serve', 'api', '/api', 'httpRequest', '{port: 0}'],
  ]);
});

test('respond hears json as its JSON text, and invalid ones never reach the Host', () => {
  const { heard, impl } = recording();
  const g = newGroup({ name: 'g' });
  const exchange = g.object(exchangeKind, 'e1', null).value;
  const respond = (response: string) => {
    const s = g.load({
      name: `s${heard.length}${response.length}`,
      source: `script variable seen = "ok"\non go x\n  try\n    ask http to respond x, ${response}\n  catch {code: code, field: f}\n    put [code, f] into seen\n  end\nend`,
      grants: { http: httpCapability(impl, costs).grant('all', undefined) },
    });
    s.deliver({ name: 'go', args: [exchange] });
    g.pump(now);
    return new Map(g.inspect().scripts.find(x => x.name === s.name)!.vars)
      .get('seen')!
      .toString();
  };
  expect(respond('{status: 201, json: {id: 7, tags: ["a"]}}')).toBe('"ok"');
  expect(respond('{body: "hi"}')).toBe('"ok"');
  expect(respond('{status: 600}')).toBe('["invalid response", "status"]');
  expect(respond('{body: "a", json: 1}')).toBe('["invalid response", "json"]');
  expect(respond('{json: 5 kg}')).toBe('["invalid response", "json"]');
  expect(respond('{headers: {"X-A": "1", "x-a": "2"}}')).toBe(
    '["invalid response", "headers"]',
  );
  expect(heard).toEqual([
    ['respond', 'e1', '{"id":7,"tags":["a"]}'],
    ['respond', 'e1', '{body: "hi"}'],
  ]);
});

test('http declares the server Operations, fetch, or both, and refuses part of the server set', () => {
  const fetchOnly = { fetch: () => {} };
  const all = { ...costs, fetch: { fuel: 4 } };
  const ops = (impl: HttpImpl) =>
    [...httpCapability(impl, all).operations.keys()].sort();
  expect(ops(fetchOnly)).toEqual(['fetch']);
  expect(ops({ ...noHttp, ...fetchOnly })).toEqual([
    'fetch',
    'respond',
    'serve',
    'unserve',
  ]);
  // Only the declared Operations need costs.
  expect(() => httpCapability(fetchOnly, { fetch: { fuel: 1 } })).not.toThrow();
  expect(() => httpCapability(fetchOnly, costs)).toThrow(HostError);
  expect(() =>
    httpCapability(
      { serve: () => {}, ...fetchOnly } as unknown as HttpImpl,
      all,
    ),
  ).toThrow(HostError);
  expect(() => httpCapability({} as HttpImpl, all)).toThrow(HostError);
});

test('fetch hears the normalized URL with its query, and the request without query', () => {
  const heard: [string, string][] = [];
  const g = newGroup({ name: 'g' });
  const s = g.load({
    name: 's',
    source: `on go
  ask http to fetch "HTTP://Example.COM:80?#frag", {method: "POST", query: {q: "a&b", n: ["1", "2"]}, json: {k: [1]}, headers: {"X-A": ["1", "2"]}} and wait
end go`,
    grants: {
      http: httpCapability(
        {
          fetch: (_call, url, request) => {
            heard.push([url, request.toString()]);
          },
        },
        { fetch: { fuel: 1 } },
      ).grant('all', undefined),
    },
  });
  s.deliver({ name: 'go' });
  g.pump(now);
  // The URL already had an empty query, so a nonempty `query` is refused.
  expect(heard).toEqual([]);
  const t = g.load({
    name: 't',
    source: `on go
  ask http to fetch "HTTP://Example.COM:80#frag", {method: "POST", query: {q: "a&b", n: ["1", "2"]}, json: {k: [1]}, headers: {"X-A": ["1", "2"]}} and wait
end go`,
    grants: {
      http: httpCapability(
        {
          fetch: (_call, url, request) => {
            heard.push([url, request.toString()]);
          },
        },
        { fetch: { fuel: 1 } },
      ).grant('all', undefined),
    },
  });
  t.deliver({ name: 'go' });
  g.pump(now);
  expect(heard).toEqual([
    [
      'http://example.com/?q=a%26b&n=1&n=2',
      '{method: "POST", headers: {"X-A": ["1", "2"]}, json: "{" & quote & "k" & quote & ":[1]}"}',
    ],
  ]);
});

test('the URL profile accepts strict absolute URLs and normalizes only scheme, host, port, empty path and fragment', () => {
  const cases: [string, string | undefined][] = [
    ['https://example.com', 'https://example.com/'],
    [
      'HTTPS://Example.COM:443/A/./b?X=%2F#f',
      'https://example.com/A/./b?X=%2F',
    ],
    ['http://example.com:8080/', 'http://example.com:8080/'],
    ['http://127.0.0.1:80/', 'http://127.0.0.1/'],
    ['http://[::1]:8080/', 'http://[::1]:8080/'],
    ['http://[2001:DB8::1]/', 'http://[2001:db8::1]/'],
    ['http://[::ffff:1.2.3.4]/', 'http://[::ffff:1.2.3.4]/'],
    ['http://[1:2:3:4:5:6:7:8]/', 'http://[1:2:3:4:5:6:7:8]/'],
    ['http://a-b.c9/p?q=a?b/c', 'http://a-b.c9/p?q=a?b/c'],
    ['http://example.com/%e2%82%ac', 'http://example.com/%e2%82%ac'],
    ['http://xn--bcher-kva.example/', 'http://xn--bcher-kva.example/'],
    ['ws://example.com/', undefined],
    ['http:/example.com/', undefined],
    ['http://', undefined],
    ['http://user:pw@example.com/', undefined],
    ['http://example.com:/', undefined],
    ['http://example.com:0/', undefined],
    ['http://example.com:65536/', undefined],
    ['http://example.com/a b', undefined],
    [String.raw`http://example.com/a\b`, undefined],
    ['http://example.com/%2', undefined],
    ['http://example.com/[x]', undefined],
    ['http://bücher.example/', undefined],
    ['http://1.2.3/', undefined],
    ['http://1.2.3.256/', undefined],
    ['http://01.2.3.4/', undefined],
    ['http://0x7f.0.0.1/', undefined],
    ['http://example.123/', undefined],
    ['http://a..b/', undefined],
    ['http://[::1::2]/', undefined],
    ['http://[1:2:3:4:5:6:7:8:9]/', undefined],
    ['http://[::1/', undefined],
    ['http://[fe80::1%25eth0]/', undefined],
  ];
  for (const [url, normalized] of cases) {
    const u = parseFetchUrl(url);
    expect([url, u && fetchUrlText(u)]).toEqual([url, normalized]);
    if (u) {
      // Normalizing a normalized URL gives it back.
      expect(fetchUrlText(parseFetchUrl(fetchUrlText(u))!)).toBe(normalized!);
    }
  }
});
