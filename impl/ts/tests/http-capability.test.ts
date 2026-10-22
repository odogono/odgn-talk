import { expect, test } from 'bun:test';
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
  expect(heard).toEqual([
    ['respond', 'e1', '{"id":7,"tags":["a"]}'],
    ['respond', 'e1', '{body: "hi"}'],
  ]);
});
