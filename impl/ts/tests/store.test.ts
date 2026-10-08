import { operationalReports } from './operational-reports';
import { expect, test } from 'bun:test';
import {
  add,
  bool,
  createCore,
  defineObjectKind,
  HostError,
  LoadError,
  newGroup,
  nothing,
  num,
  parseInstant,
  readDisplay,
  ScriptError,
  storeCapability,
  text,
  type Costs,
  type Group,
  type Limits,
  type StoreImpl,
  type Value,
} from '../src/index';
import {
  decodeContents,
  encodeContents,
  memoryStores,
  sessionQuotas,
  StoreContentsError,
  Stores,
  webStorageStores,
} from '../src/store/index';
import { fakeStorage } from '../tools/store-kit';

const now = parseInstant('2026-10-07T12:00:00Z');
const OPERATIONS = ['get', 'set', 'delete', 'keys', 'increment', 'swap'];
const costs: Costs = Object.fromEntries(
  OPERATIONS.map(name => [
    name,
    { fuel: ['get', 'keys'].includes(name) ? 2 : 4 },
  ]),
);
const ok = () => ({ status: 'ok' as const });
const inert: StoreImpl = {
  begin: ok,
  commit: ok,
  rollback: ok,
  get: () => nothing,
  set: () => {},
  delete: () => {},
  keys: () => readDisplay('[]'),
  increment: () => num(1),
  swap: () => true,
};

type Run = {
  error?: { code: string; data: Value; message: string };
  lines: string[];
  outcome: string;
  seen: Value;
};
// One Delivery of `go` to a Script granted `s`, the Store named `name`.
const run = (
  body: string,
  impl: StoreImpl,
  {
    name = 'default',
    ops = 'all' as readonly string[] | 'all',
    limits = {} as Partial<Limits>,
    args = [] as Value[],
    params = '',
    extra = '',
    costed = costs,
  } = {},
): Run & { group: Group } => {
  const lines: string[] = [];
  const g = newGroup({ name: 'g', trace: line => lines.push(line) });
  const script = g.load({
    name: 's',
    source: `script variable seen = nothing\non go${params}\n${body}\nend\n${extra}`,
    grants: { s: storeCapability(impl, costed).grant(ops, name) },
    limits,
  });
  script.deliver({ name: 'go', args });
  const report = operationalReports(g.pump(now).reports).find(
    r => r.kind === 'run end',
  )!;
  return {
    group: g,
    lines,
    outcome: report.outcome,
    ...(report.error ? { error: report.error } : {}),
    seen: new Map(g.inspect().scripts[0]!.vars).get('seen')!,
  };
};

test('add applies the + rules and throws the ScriptError + would raise', () => {
  expect(add(num(2), num(3)).toString()).toBe('5');
  expect(add(readDisplay('5 m'), readDisplay('20 cm')).toString()).toBe(
    '5.20 m',
  );
  const failure = (a: string, b: string) => {
    try {
      add(readDisplay(a), readDisplay(b));
    } catch (error) {
      expect(error).toBeInstanceOf(ScriptError);
      const e = error as ScriptError;
      return [e.code, e.message, e.data.toString()];
    }
    throw new Error('add did not fail');
  };
  expect(failure('1 m', '1 kg')).toEqual([
    'incompatible units',
    'Can’t combine "m" with "kg"'.replace('’', "'"),
    '{left: "m", right: "kg"}',
  ]);
  expect(failure('"7"', '1')[0]).toBe('wrong kind');
  expect(failure('9999999999999999999999999999999999', '1')).toEqual([
    'overflow',
    'The result of "+" is too large',
    '{operator: "+"}',
  ]);
});

test('storeCapability needs every Operation, hook and cost, and copies costs', () => {
  for (const name of [...OPERATIONS, 'begin', 'commit', 'rollback']) {
    expect(() =>
      storeCapability(
        { ...inert, [name]: undefined } as unknown as StoreImpl,
        costs,
      ),
    ).toThrow(HostError);
  }
  for (const name of OPERATIONS) {
    const missing = { ...costs };
    delete missing[name];
    expect(() => storeCapability(inert, missing)).toThrow(HostError);
  }
  const given = { ...costs, get: { fuel: 3 } };
  const store = storeCapability(inert, given);
  given.get.fuel = 99;
  expect(store.operations.get('get')!.cost.fuel).toBe(3);
  expect(createCore().storeCapability).toBe(storeCapability);
  expect(
    [...store.operations]
      .filter(([, op]) => op.mode === 'immediate' && op.segmentBound)
      .map(([name]) => name),
  ).toEqual(['delete', 'increment', 'set', 'swap']);
  expect(
    [...store.operations.values()].every(op => op.mode === 'immediate'),
  ).toBe(true);
});

test('a Script keeps values in the Store across Deliveries', () => {
  const stores = memoryStores(sessionQuotas);
  const g = newGroup({ name: 'g' });
  const script = g.load({
    name: 's',
    source: [
      'script variable seen = nothing',
      'on score points',
      '  ask s to increment "total", points',
      '  put it into seen',
      '  ask s to swap "winner", nothing, "ann"',
      'end',
      'on look',
      '  ask s to get "total", 0',
      '  put it into total',
      '  ask s to keys',
      '  put [total, it] into seen',
      'end',
    ].join('\n'),
    grants: { s: storeCapability(stores, costs).grant('all', 'scores') },
  });
  script.deliver({ name: 'score', args: [num(3)] });
  script.deliver({ name: 'score', args: [num(4)] });
  script.deliver({ name: 'look' });
  g.pump(now);
  expect(new Map(g.inspect().scripts[0]!.vars).get('seen')!.toString()).toBe(
    '[7, ["total", "winner"]]',
  );
  expect(stores.entries('scores').map(([k, v]) => `${k}=${v}`)).toEqual([
    'total=7',
    'winner="ann"',
  ]);
});

test('an empty key raises invalid key before the call is charged', () => {
  const calls: string[] = [];
  const impl: StoreImpl = {
    ...inert,
    get: () => {
      calls.push('get');
      return nothing;
    },
    begin: () => {
      calls.push('begin');
      return { status: 'ok' };
    },
  };
  for (const body of [
    'ask s to get ""',
    'ask s to set "", 1',
    'ask s to delete ""',
    'ask s to increment ""',
    'ask s to swap "", 1, 2',
  ]) {
    const result = run(body, impl);
    expect(result.error?.code).toBe('invalid key');
    expect(result.error?.message).toBe("A Store key can't be empty text");
  }
  const ended = (costed: Costs) =>
    run('ask s to get ""', impl, { costed }).lines.find(l =>
      l.startsWith('run '),
    );
  expect(ended({ ...costs, get: { fuel: 1000, alloc: 1000 } })).toBe(
    ended(costs),
  );
  expect(calls).toEqual([]);
  expect(run('ask s to keys ""', impl).outcome).toBe('completed');
});

test('Function Values are not encodable, and Host Objects are the Store’s to refuse', () => {
  const stores = memoryStores(sessionQuotas);
  expect(
    run('ask s to set "k", [twice]', stores, {
      extra: 'function twice n\nreturn n * 2\nend twice',
    }).error?.code,
  ).toBe('not encodable');
  const room = defineObjectKind<null>({ name: 'room', props: {} });
  const lines: string[] = [];
  const g = newGroup({ name: 'g', trace: line => lines.push(line) });
  const script = g.load({
    name: 's',
    source: 'on go r\nask s to set "k", {at: [r]}\nend',
    grants: { s: storeCapability(stores, costs).grant('all', 'default') },
  });
  script.deliver({ name: 'go', args: [g.object(room, 'r1', null).value] });
  const report = operationalReports(g.pump(now).reports).find(
    r => r.kind === 'run end',
  )!;
  expect(report.error?.code).toBe("can't store");
  expect(report.error?.data.get('kind').asText()).toBe('room');
  expect(report.error?.data.get('capability').asText()).toBe('s');
  expect(report.error?.data.get('operation').asText()).toBe('set');
  expect(stores.entries('default')).toEqual([]);
});

test('Store writes commit with the Segment and roll back with it', () => {
  const stores = memoryStores(sessionQuotas);
  expect(
    run('ask s to set "a", 1\nask s to increment "n"', stores).outcome,
  ).toBe('completed');
  const faulted = run(
    'ask s to set "a", 2\nask s to increment "n"\nrepeat 1000 times\nput 1 into seen\nend repeat',
    stores,
    { limits: { fuelPerRun: 200 } },
  );
  expect(faulted.outcome).toBe('limit fault');
  expect(stores.entries('default').map(([k, v]) => `${k}=${v}`)).toEqual([
    'a=1',
    'n=1',
  ]);
  // An error ends the Segment, which commits, as Script Variables do.
  const errored = run('ask s to set "a", 3\nthrow "stop"', stores);
  expect(errored.outcome).toBe('errored');
  expect(stores.entries('default').map(([k, v]) => `${k}=${v}`)).toEqual([
    'a=3',
    'n=1',
  ]);
});

test('Store writes enlist the Grant, and a second writable Store conflicts', () => {
  const stores = memoryStores(sessionQuotas);
  const lines: string[] = [];
  const g = newGroup({ name: 'g', trace: line => lines.push(line) });
  const store = storeCapability(stores, costs);
  const script = g.load({
    name: 's',
    source: [
      'on go',
      '  ask reader to get "k"',
      '  ask a to set "k", 1',
      '  ask reader to get "k"',
      '  put it into seen',
      '  ask b to set "k", 2',
      'end',
      'script variable seen = nothing',
    ].join('\n'),
    grants: {
      reader: store.grant(['get', 'keys'], 'one'),
      a: store.grant('all', 'one'),
      b: store.grant('all', 'two'),
    },
  });
  script.deliver({ name: 'go' });
  const report = operationalReports(g.pump(now).reports).find(
    r => r.kind === 'run end',
  )!;
  expect(report.error?.code).toBe('segment participant conflict');
  expect(report.error?.data.get('participant').asText()).toBe('a');
  // The reader saw the Segment's own write, and the commit kept it.
  expect(new Map(g.inspect().scripts[0]!.vars).get('seen')!.toString()).toBe(
    '1',
  );
  expect(lines.filter(l => l.startsWith('effect '))).toEqual([
    expect.stringContaining('grant=a phase=begin status=ok'),
    expect.stringContaining('grant=a phase=commit status=ok'),
  ]);
  expect(stores.entries('one').map(([k, v]) => `${k}=${v}`)).toEqual(['k=1']);
});

test('the Core checks result kinds and declared failures', () => {
  const lying: StoreImpl = {
    ...inert,
    get: () => readDisplay('[1]'),
    keys: () => readDisplay('[1]'),
    increment: () => text('one'),
  };
  expect(run('ask s to get "k"', lying).outcome).toBe('completed');
  expect(run('ask s to keys', lying).error?.code).toBe('host error');
  expect(run('ask s to increment "k"', lying).error?.code).toBe('host error');
  const failing = (code: string, data: string): StoreImpl => ({
    ...inert,
    set: () => {
      throw new ScriptError(code, code, readDisplay(data));
    },
  });
  expect(
    run('ask s to set "k", 1', failing('store busy', '{key: "k"}')).error?.code,
  ).toBe('store busy');
  expect(
    run('ask s to set "k", 1', failing('store full', '{limit: "size"}')).error
      ?.code,
  ).toBe('store full');
  // A limit the catalogue doesn't list, a missing field, a code `set`
  // doesn't declare, and `invalid key`, which only the Core raises.
  for (const [code, data] of [
    ['store full', '{limit: "disk"}'],
    ['store busy', '{}'],
    ['overflow', '{operator: "+"}'],
    ['invalid key', '{}'],
  ] as const) {
    expect(run('ask s to set "k", 1', failing(code, data)).error?.code).toBe(
      'host error',
    );
  }
});

test('increment takes a number or a Quantity, checked at load and at the call', () => {
  const stores = memoryStores(sessionQuotas);
  expect(
    run(
      'ask s to increment "d", 5 m\nput it into seen',
      stores,
    ).seen.toString(),
  ).toBe('5 m');
  expect(() => run('ask s to increment "d", "5"', stores)).toThrow(LoadError);
  expect(
    run('ask s to increment "d", x', stores, {
      params: ' x',
      args: [text('5')],
    }).error?.code,
  ).toBe('wrong kind');
  const swapped = run(
    'ask s to swap "w", nothing, 1\nput it into seen',
    stores,
  );
  expect(swapped.seen.equals(bool(true))).toBe(true);
  expect(
    run('ask s to increment "d", 1 kg', stores).error?.data.toString(),
  ).toContain('{left: "m", right: "kg", capability: "s"');
});

test('Store contents encode as one JSON object in key order', () => {
  const entries: [string, Value][] = [
    ['b', readDisplay('2.50 GBP')],
    ['a', readDisplay('{x: [1, "two"], "$y": true}')],
  ];
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : 1));
  const json = encodeContents(sorted);
  expect(json).toBe(
    '{"a":{"$map":[["x",[1,"two"]],["$y",true]]},"b":{"$quantity":["2.50","GBP"]}}',
  );
  expect(decodeContents(json).map(([k, v]) => `${k}=${v}`)).toEqual([
    'a={x: [1, "two"], "$y": true}',
    'b=2.50 GBP',
  ]);
  expect(() => decodeContents('[1]')).toThrow(HostError);
  expect(() => decodeContents('{"k":{"$object":["room","r"]}}')).toThrow();
});

test('replacing a Store’s contents checks keys, kinds and quotas', () => {
  const stores: Stores = memoryStores({ size: 100, keys: 2, value: 20 });
  stores.replace('s', [
    ['a', num(1)],
    ['b', nothing],
  ]);
  expect(stores.entries('s').map(([k]) => k)).toEqual(['a']);
  for (const entries of [
    [['', num(1)]],
    [
      ['a', num(1)],
      ['a', num(2)],
    ],
    [['a', text('a long value of text')]],
    [
      ['a', num(1)],
      ['b', num(1)],
      ['c', num(1)],
    ],
  ] as [string, Value][][]) {
    expect(() => stores.replace('s', entries)).toThrow(StoreContentsError);
  }
  expect(stores.entries('s').map(([k]) => k)).toEqual(['a']);
  stores.clear('s');
  expect(stores.entries('s')).toEqual([]);
});

test('a commit the backend refuses fails, and leaves the Store as it was', () => {
  let refuse = false;
  const stores = new Stores(
    {
      load: () => [['k', num(1)]],
      save: () => {
        if (refuse) {
          throw new Error('disk full');
        }
      },
    },
    sessionQuotas,
  );
  expect(run('ask s to set "k", 2', stores).outcome).toBe('completed');
  refuse = true;
  const failed = run('ask s to set "k", 3', stores);
  expect(failed.outcome).toBe('effect failed');
  expect(failed.lines).toContainEqual(
    expect.stringContaining('phase=commit status=failed'),
  );
  expect(stores.entries('default').map(([k, v]) => `${k}=${v}`)).toEqual([
    'k=2',
  ]);
});

test('a Web Storage Store is one item per Store, read by the next page', () => {
  const storage = fakeStorage();
  const first = webStorageStores(storage, sessionQuotas);
  run('ask s to set "b", 2\nask s to set "a", [1]', first, { name: 'scores' });
  expect([...storage.items]).toEqual([
    ['northtalk.store.scores', '{"a":[1],"b":2}'],
  ]);
  const next = webStorageStores(storage, sessionQuotas);
  expect(
    run('ask s to keys\nput it into seen', next, {
      name: 'scores',
    }).seen.toString(),
  ).toBe('["a", "b"]');
  run('ask s to delete "a"\nask s to delete "b"', next, { name: 'scores' });
  expect([...storage.items]).toEqual([]);
});

test('Segments of two Groups sharing one Store are kept apart', () => {
  const stores = memoryStores(sessionQuotas);
  const capability = storeCapability(stores, costs);
  const groups = ['a', 'b'].map(name => {
    const g = newGroup({ name });
    g.load({
      name: 's',
      source:
        'on go\nask st to set "k", 1\nrepeat 200 times\nend repeat\nend go',
      grants: { st: capability.grant('all', 'shared') },
    }).deliver({ name: 'go' });
    return g;
  });
  // Both Groups' first Runs are s/r1, preempted inside their Segments.
  const [first, second] = groups.map(g =>
    g.pump(now, { fuelSlice: 40, fuelCap: 40 }),
  );
  expect(
    operationalReports(first!.reports).some(r => r.kind === 'run end'),
  ).toBe(false);
  const busy = operationalReports(second!.reports).find(
    r => r.kind === 'run end',
  );
  expect(busy?.error?.code).toBe('store busy');
  groups[0]!.pump(now);
  expect(stores.entries('shared').map(([k, v]) => `${k}=${v}`)).toEqual([
    'k=1',
  ]);
});
