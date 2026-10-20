// Host functions take and return the JS forms of their Shapes (#1420).
import { operationalReports } from './operational-reports';
import { expect, test } from 'bun:test';
import {
  dec,
  defineCapability,
  defineObjectKind,
  newGroup,
  shape,
  text,
  type Decimal,
  type HostObject,
  type Value,
} from '../src/index';

const door = defineObjectKind<{ open: boolean }>({
  name: 'typed-door',
  props: {},
});

const run = (
  grants: Parameters<ReturnType<typeof newGroup>['load']>[0]['grants'],
  body: string,
  setup?: (g: ReturnType<typeof newGroup>) => Record<string, HostObject>,
) => {
  const g = newGroup({ name: 'g' });
  const objects = setup?.(g);
  g.load({
    name: 's',
    source: `script variable out = []\non go\n${body}\nend`,
    grants,
    ...(objects ? { objects } : {}),
  }).deliver({ name: 'go' });
  const reports = operationalReports(g.pump(0n).reports);
  const end = reports.find(r => r.kind === 'run end')!;
  const out = new Map(g.inspect().scripts.find(s => s.name === 's')!.vars).get(
    'out',
  )!;
  return { outcome: end.outcome, out: out.toString(), reports };
};

test('scalar arguments arrive as their JS forms and results convert back', () => {
  const seen: unknown[] = [];
  const api = defineCapability('api', {
    shout: {
      mode: 'immediate',
      args: [shape.text, shape.bool],
      result: shape.text,
      cost: { fuel: 1 },
      do: (_call, s, loud) => {
        const typed: [string, boolean] = [s, loud];
        seen.push(...typed);
        return loud ? s.toUpperCase() : s;
      },
    },
    double: {
      mode: 'immediate',
      args: [shape.number],
      result: shape.number,
      cost: { fuel: 1 },
      do: (_call, n) => {
        const typed: Decimal = n;
        seen.push(typed.toString());
        return typed.toBigInt() * 2n;
      },
    },
    later: {
      mode: 'immediate',
      args: [shape.instant],
      result: shape.instant,
      cost: { fuel: 1 },
      do: (_call, at) => at + 1n,
    },
    size: {
      mode: 'immediate',
      args: [shape.bytes],
      result: shape.bool,
      cost: { fuel: 1 },
      do: (_call, b) => ArrayBuffer.isView(b) && b.length > 0,
    },
    none: {
      mode: 'immediate',
      result: shape.nothing,
      cost: { fuel: 1 },
      do: () => null,
    },
  });
  const result = run(
    { api: api.grant('all', undefined) },
    [
      'ask api to shout "hi", true',
      'put it after out',
      'ask api to double 21',
      'put it after out',
      'ask api to later ("1970-01-01T00:00:00Z" as instant)',
      'put it after out',
      'ask api to size ("6869" as bytes)',
      'put it after out',
      'ask api to none',
      'put it after out',
    ]
      .map(line => `  ${line}`)
      .join('\n'),
  );
  expect(result.outcome).toBe('completed');
  expect(seen).toEqual(['hi', true, '21']);
  expect(result.out).toBe(
    '["HI", 42, 1970-01-01T00:00:00.000001Z, true, nothing]',
  );
});

test('Optional arguments are null when Nothing is supplied and absent when omitted', () => {
  const seen: unknown[][] = [];
  const api = defineCapability('api', {
    pick: {
      mode: 'immediate',
      args: [shape.text, shape.optional(shape.text)],
      result: shape.optional(shape.text),
      cost: { fuel: 1 },
      do: (_call, first, second) => {
        const typed: string | null | undefined = second;
        seen.push([first, typed]);
        return typed;
      },
    },
  });
  const result = run(
    { api: api.grant('all', undefined) },
    [
      'ask api to pick "a"',
      'put it after out',
      'ask api to pick "a", nothing',
      'put it after out',
      'ask api to pick "a", "b"',
      'put it after out',
    ]
      .map(line => `  ${line}`)
      .join('\n'),
  );
  expect(result.outcome).toBe('completed');
  expect(seen).toEqual([['a'], ['a', null], ['a', 'b']]);
  expect(result.out).toBe('[nothing, nothing, "b"]');
});

test('Host Objects arrive as handles and composite Shapes stay Values', () => {
  const api = defineCapability('api', {
    toggle: {
      mode: 'immediate',
      args: [shape.object(door), shape.listOf(shape.text)],
      result: shape.object(door),
      cost: { fuel: 1 },
      do: (_call, d, names) => {
        d.native.open = !d.native.open;
        const typed: Value = names;
        expect(typed.length).toBe(2);
        return d;
      },
    },
  });
  let front: HostObject<{ open: boolean }> | undefined;
  const result = run(
    { api: api.grant('all', undefined) },
    '  ask api to toggle front, ["a", "b"]\n  put it after out',
    g => {
      front = g.object(door, 'front', { open: false });
      return { front };
    },
  );
  expect(result.outcome).toBe('completed');
  expect(front!.native.open).toBe(true);
});

test('a Value result passes through, and a mismatched JS form fails the call', () => {
  const api = defineCapability('api', {
    asValue: {
      mode: 'immediate',
      result: shape.text,
      cost: { fuel: 1 },
      do: () => text('v'),
    },
    wrong: {
      mode: 'immediate',
      result: shape.text,
      cost: { fuel: 1 },
      // @ts-expect-error a number is not a text result
      do: () => 3,
    },
  });
  const ok = run(
    { api: api.grant('all', undefined) },
    '  ask api to asValue\n  put it after out',
  );
  expect(ok.out).toBe('["v"]');
  const failed = run(
    { api: api.grant('all', undefined) },
    '  ask api to wrong\n  put it after out',
  );
  expect(failed.outcome).not.toBe('completed');
});

test('a curried binding types call.binding, and answer takes the result form', () => {
  const answered: unknown[] = [];
  const api = defineCapability<{ prefix: string }>()('api', {
    greet: {
      mode: 'suspending',
      args: [shape.text],
      result: shape.text,
      cost: { fuel: 1 },
      start: (call, name) => {
        const prefix: string = call.binding.prefix;
        answered.push(name);
        call.answer(`${prefix} ${name}`);
      },
    },
    total: {
      mode: 'immediate',
      args: [shape.listOf(shape.number)],
      result: shape.number,
      cost: { fuel: 1 },
      // A Value is accepted wherever a JS form is.
      do: (_call, ns) => dec(String(ns.length + 1)),
    },
  });
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source:
      'script variable out = []\non go\n  ask api to greet "ada" and wait\n  put it after out\n  ask api to total [1, 2]\n  put it after out\nend',
    grants: { api: api.grant('all', { prefix: 'hello' }) },
  }).deliver({ name: 'go' });
  for (let i = 0; i < 4; i++) {
    g.pump(0n);
  }
  expect(answered).toEqual(['ada']);
  expect(
    new Map(g.inspect().scripts.find(s => s.name === 's')!.vars)
      .get('out')!
      .toString(),
  ).toBe('["hello ada", 3]');
});
