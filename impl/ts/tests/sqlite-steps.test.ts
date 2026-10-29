// The node:sqlite driver pays for every step before it takes it
// (spec/embedding/metered-operations.md, SQLite step authorization).
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LimitReached,
  type Call,
  type ScriptError,
  type SqliteBinding,
} from '../src/index';
import {
  openSqliteDatabase,
  sqliteDatabases,
  type SqliteDatabase,
} from '../src/sqlite/index';

const opened: SqliteDatabase[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) {
    db.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const driver = () => {
  const directory = mkdtempSync(join(tmpdir(), 'northtalk-sqlite-steps-'));
  directories.push(directory);
  const db = openSqliteDatabase(join(directory, 'app.sqlite'));
  opened.push(db);
  db.exec('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1), (2), (3)');
  return sqliteDatabases({ app: db });
};

// Only the binding, Group and Segment are the driver's to read.
const call = {
  binding: { database: 'app', maxRows: 10 },
  group: {},
  segmentId: 'g/r1.s1',
} as unknown as Call<SqliteBinding>;

// Counts steps, refusing the one after `allowed`.
const counter = (allowed = Infinity) => {
  const paid = { steps: 0 };
  const beforeStep = () => {
    if (paid.steps === allowed) {
      throw new LimitReached();
    }
    paid.steps++;
  };
  return { paid, beforeStep };
};

test('N rows take N + 1 steps, and an empty result one', () => {
  const impl = driver();
  for (const [sql, steps, rows] of [
    ['SELECT n FROM t', 4, 3],
    ['SELECT n FROM t WHERE n > 9', 1, 0],
  ] as const) {
    const { paid, beforeStep } = counter();
    expect(impl.query(call, sql, [], 10, beforeStep).rows).toHaveLength(rows);
    expect(paid.steps).toBe(steps);
  }
});

test('the probe past max is paid before it raises too many rows', () => {
  const impl = driver();
  for (const [max, steps] of [
    [0, 1],
    [2, 3],
  ] as const) {
    const { paid, beforeStep } = counter();
    let code = '';
    try {
      impl.query(call, 'SELECT n FROM t', [], max, beforeStep);
    } catch (error) {
      code = (error as ScriptError).code;
    }
    expect(code).toBe('too many rows');
    expect(paid.steps).toBe(steps);
  }
});

test('a non-returning change pays its one execution step', () => {
  const { paid, beforeStep } = counter();
  const result = driver().change(
    call,
    'UPDATE t SET n = n + 1',
    [],
    10,
    beforeStep,
  );
  expect(result.changes).toBe(3);
  expect(paid.steps).toBe(1);
});

test('a refused step propagates, and the driver steps no further', () => {
  const impl = driver();
  const { paid, beforeStep } = counter(2);
  expect(() => impl.query(call, 'SELECT n FROM t', [], 10, beforeStep)).toThrow(
    LimitReached,
  );
  expect(paid.steps).toBe(2);
  // A refused write changes nothing.
  const write = counter(0);
  expect(() =>
    impl.change(call, 'UPDATE t SET n = 0', [], 10, write.beforeStep),
  ).toThrow(LimitReached);
  expect(
    impl.query(call, 'SELECT n FROM t WHERE n = 0', [], 10, () => {}).rows,
  ).toEqual([]);
});
