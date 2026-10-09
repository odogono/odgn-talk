import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openSqliteDatabase,
  sqliteDatabases,
  STORE_TABLE,
} from '../src/sqlite/index';
import { sessionQuotas } from '../src/store/index';
import { runSqliteKitSequence, sqliteKitSequences } from '../tools/sqlite-kit';

const sequences = sqliteKitSequences();
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A fresh database file per sequence, keeping its Stores.
const open = () => {
  const directory = mkdtempSync(join(tmpdir(), 'northtalk-sqlite-'));
  directories.push(directory);
  const db = openSqliteDatabase(join(directory, 'app.sqlite'), {
    stores: sessionQuotas,
  });
  return {
    sqlite: sqliteDatabases({ app: db }),
    store: db.stores!,
    storeTable: STORE_TABLE,
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
  };
};

test('the kit has sequences', () => {
  expect(sequences.length).toBeGreaterThan(30);
});

for (const sequence of sequences) {
  test(`node:sqlite follows the sqlite test kit: ${sequence.file}: ${sequence.name}`, () => {
    expect(runSqliteKitSequence(open, sequence)).toBeUndefined();
  });
}
