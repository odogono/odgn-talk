import { operationalReports } from './operational-reports';
import { expect, test } from 'bun:test';
import {
  HostError,
  newGroup,
  parseInstant,
  readDisplay,
  sqliteCapability,
  type Costs,
  type SegmentCoordinator,
  type SqliteBinding,
  type SqliteImpl,
  type SqlParams,
  type SqlRows,
  type Value,
} from '../src/index';

// The Trace Cases under corpus/capabilities/standard-sqlite* pin what a
// Script sees. These pin what the implementation sees, which no Trace shows.
const now = parseInstant('2026-10-09T12:00:00Z');
const costs: Costs = {
  query: { fuel: 3 },
  change: { fuel: 5 },
  begin: { fuel: 2 },
  commit: { fuel: 2 },
  rollback: { fuel: 2 },
};
const ok = () => ({ status: 'ok' as const });
const coordinator: SegmentCoordinator = {
  begin: ok,
  commit: ok,
  rollback: ok,
};
const binding: SqliteBinding = { database: 'app', maxRows: 10 };

type Seen = { max: number; params: SqlParams; sql: string };
const recording = (answer: SqlRows = { columns: [], rows: [] }) => {
  const seen: Seen[] = [];
  const impl: SqliteImpl = {
    coordinator: () => coordinator,
    query: (_, sql, params, max) => {
      seen.push({ sql, params, max });
      return answer;
    },
    change: (_, sql, params, max) => {
      seen.push({ sql, params, max });
      return { ...answer, changes: 0 };
    },
    begin: () => {},
    commit: () => {},
    rollback: () => {},
  };
  return { impl, seen };
};

// One Delivery of `go`, whose body calls the Grant `db`.
const run = (body: string, impl: SqliteImpl, perRow = 0) => {
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source: `script variable seen = nothing\non go\n${body}\nend go\n`,
    grants: { db: sqliteCapability(impl, costs, perRow).grant('all', binding) },
  });
  g.script('s')!.deliver({ name: 'go', args: [] });
  const report = operationalReports(g.pump(now).reports).find(
    r => r.kind === 'run end',
  )!;
  return {
    outcome: report.outcome,
    data: report.error?.data,
    code: report.error?.code,
    seen: new Map(g.inspect().scripts[0]!.vars).get('seen') as Value,
  };
};

test('sqliteCapability needs every function, every cost and a whole perRow', () => {
  const { impl } = recording();
  for (const name of [
    'coordinator',
    'query',
    'change',
    'begin',
    'commit',
    'rollback',
  ]) {
    expect(() =>
      sqliteCapability(
        { ...impl, [name]: undefined } as unknown as SqliteImpl,
        costs,
        0,
      ),
    ).toThrow(HostError);
  }
  const missing: Record<string, { fuel: number }> = { ...costs };
  delete missing.commit;
  expect(() => sqliteCapability(impl, missing, 0)).toThrow(HostError);
  for (const perRow of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    expect(() => sqliteCapability(impl, costs, perRow)).toThrow(HostError);
  }
});

test('a Grant maps its database to a coordinator once, and refuses a bad binding', () => {
  const databases: string[] = [];
  const { impl } = recording();
  const capability = sqliteCapability(
    {
      ...impl,
      coordinator: database => {
        databases.push(database);
        return coordinator;
      },
    },
    costs,
    1,
  );
  capability.grant(['query'], { database: 'app', maxRows: 0 });
  capability.grant('all', {
    database: 'audit',
    tables: ['log'],
    maxRows: Number.MAX_SAFE_INTEGER,
  });
  expect(databases).toEqual(['app', 'audit']);
  for (const bad of [
    undefined,
    'app',
    { database: 'app' },
    { database: 'app', maxRows: -1 },
    { database: 'app', maxRows: 1.5 },
    { database: 3, maxRows: 1 },
    { database: 'app', maxRows: 1, tables: 'log' },
    { database: 'app', maxRows: 1, tables: [1] },
  ]) {
    expect(() =>
      capability.grant('all', bad as unknown as SqliteBinding),
    ).toThrow(HostError);
  }
  expect(databases).toEqual(['app', 'audit']);
});

test('params reach the implementation as SQL values', () => {
  const { impl, seen } = recording();
  const result = run(
    [
      'ask db to query "Q", [3, 3.0, -9223372036854775808, 9223372036854775808, 0.1, "Zoë", <<0x01>>, true, false, nothing]',
      'ask db to change "C", {id: 7, at: 2.50}, 0',
    ].join('\n'),
    impl,
  );
  expect(result.outcome).toBe('completed');
  expect(seen[0]!.params).toEqual([
    3n,
    3,
    -(2n ** 63n),
    2 ** 63,
    0.1,
    'Zoë',
    new Uint8Array([1]),
    1n,
    0n,
    null,
  ]);
  expect(seen[0]!.max).toBe(10);
  expect(seen[1]!.params).toEqual(
    new Map<string, bigint | number>([
      ['id', 7n],
      ['at', 2.5],
    ]),
  );
  expect(seen[1]!.max).toBe(0);
});

// A query whose implementation gives `rows`, which may break its type.
const answered = (rows: unknown[][], columns = ['v']) =>
  run(
    'ask db to query "Q", []\nput it into seen',
    recording({ columns, rows: rows as SqlRows['rows'] }).impl,
  );

test('results convert values the Core can hold, and refuse the rest', () => {
  const seen = answered;
  expect(
    seen([
      [1n],
      [0.1],
      [-0],
      [null],
      ['é'],
      [new Uint8Array([255])],
    ]).seen.toString(),
  ).toBe('[{v: 1}, {v: 0.1}, {v: 0}, {v: nothing}, {v: "é"}, {v: <<0xFF>>}]');
  const surrogate = seen([['\uD800']]);
  expect(surrogate.code).toBe('unrepresentable');
  expect(surrogate.data!.get('column').toString()).toBe('"v"');
  expect(seen([[1e34]]).code).toBe('unrepresentable');
  expect(seen([[2n ** 63n]]).code).toBe('host error');
  expect(seen([[true]]).code).toBe('host error');
  expect(seen([[1]], ['a', 'b']).code).toBe('host error');
  const duplicate = seen([[1, 2]], ['\u00e9', 'e\u0301']);
  expect(duplicate.code).toBe('sql');
  expect(duplicate.data!.get('reason').toString()).toBe(
    '"duplicate column \u00e9"',
  );
});

test('each call charges max times perRow before the implementation runs', () => {
  const { impl, seen } = recording();
  const g = newGroup({ name: 'g' });
  g.load({
    name: 's',
    source: 'on go max\nask db to query "Q", [], max\nend go\n',
    grants: { db: sqliteCapability(impl, costs, 7).grant('all', binding) },
    limits: { fuelPerRun: 60 },
  });
  const fuelOf = (max: Value) => {
    g.script('s')!.deliver({ name: 'go', args: [max] });
    return operationalReports(g.pump(now).reports).find(
      r => r.kind === 'run end',
    )!;
  };
  const zero = fuelOf(readDisplay('0'));
  const three = fuelOf(readDisplay('3'));
  expect(three.fuel - zero.fuel).toBe(21);
  expect(fuelOf(readDisplay('nothing')).outcome).toBe('limit fault');
  expect(seen.length).toBe(2);
});
