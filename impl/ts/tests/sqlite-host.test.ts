import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  newGroup,
  num,
  parseInstant,
  sqliteCapability,
  storeCapability,
  type Costs,
} from '../src/index';
import {
  openSqliteDatabase,
  sqliteDatabases,
  type SqliteDatabase,
} from '../src/sqlite/index';
import { sessionQuotas } from '../src/store/index';
import { operationalReports } from './operational-reports';

// The kit holds the implementation to each rule; these run it under a
// Group, through the factory and the Core's Segments.
const now = parseInstant('2026-10-09T12:00:00Z');
const fuel = (ops: string[]): Costs =>
  Object.fromEntries(ops.map(op => [op, { fuel: 1 }]));

const opened: (DatabaseSync | SqliteDatabase)[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) {
    db.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const host = (source: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'northtalk-sqlite-host-'));
  directories.push(directory);
  const path = join(directory, 'app.sqlite');
  const db = openSqliteDatabase(path, { stores: sessionQuotas });
  opened.push(db);
  db.exec(
    'CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL); CREATE TABLE log (amount INTEGER); INSERT INTO accounts VALUES (1, 100), (2, 0)',
  );
  const sqlite = sqliteCapability(
    sqliteDatabases({ app: db }),
    fuel(['query', 'change', 'begin', 'commit', 'rollback']),
    0,
  );
  const store = storeCapability(
    db.stores!,
    fuel(['get', 'set', 'delete', 'keys', 'increment', 'swap']),
  );
  const group = newGroup({ name: 'g' });
  const script = group.load({
    name: 's',
    source,
    grants: {
      db: sqlite.grant('all', { database: 'app', maxRows: 10 }),
      counts: store.grant('all', 'counts'),
    },
  });
  const deliver = (name: string, ...args: number[]) => {
    script.deliver({ name, args: args.map(n => num(n)) });
    return operationalReports(group.pump(now).reports).find(
      r => r.kind === 'run end',
    )!;
  };
  // The committed state, as another process would read it.
  const reader = new DatabaseSync(path, { readOnly: true });
  opened.unshift(reader);
  const rows = (sql: string) =>
    reader.prepare(sql).all() as Record<string, number>[];
  return { db, deliver, rows };
};

const transfer = `on transfer fromId, toId, amount
  ask db to change "INSERT INTO log (amount) VALUES (?)", [amount], 0
  ask counts to increment "transfers"
  ask db to begin
  ask db to change "UPDATE accounts SET balance = balance - ? WHERE id = ?", [amount, fromId], 0
  if the changes of it is 0 then throw {code: "no account", id: fromId}
  ask db to change "UPDATE accounts SET balance = balance + ? WHERE id = ?", [amount, toId], 0
  ask db to commit
end transfer
`;

test('a Segment commits its database changes and Store writes together', () => {
  const { db, deliver, rows } = host(transfer);
  expect(deliver('transfer', 1, 2, 30)).toMatchObject({ outcome: 'completed' });
  expect(rows('SELECT id, balance FROM accounts ORDER BY id')).toEqual([
    { id: 1, balance: 70 },
    { id: 2, balance: 30 },
  ]);
  expect(rows('SELECT amount FROM log')).toEqual([{ amount: 30 }]);
  expect(db.stores!.entries('counts').map(String)).toEqual(['transfers,1']);
});

test('an ordinary error abandons the open transaction, then commits the Segment', () => {
  const { db, deliver, rows } = host(transfer);
  expect(deliver('transfer', 9, 2, 30)).toMatchObject({
    outcome: 'errored',
  });
  expect(rows('SELECT id, balance FROM accounts ORDER BY id')).toEqual([
    { id: 1, balance: 100 },
    { id: 2, balance: 0 },
  ]);
  expect(rows('SELECT amount FROM log')).toEqual([{ amount: 30 }]);
  expect(db.stores!.entries('counts').map(String)).toEqual(['transfers,1']);
});
