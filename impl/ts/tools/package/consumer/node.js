// Node and Bun: every published subpath, including the server-only ./sqlite
// and ./http.
import * as http from '@northtalk/ts/http';
import * as sqlite from '@northtalk/ts/sqlite';
import { newGroup, parseInstant, sqliteCapability } from '@northtalk/ts';
import { strictEqual } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smoke } from './smoke.js';

if (typeof http.createHttpHost !== 'function') {
  throw new Error('http exports no createHttpHost');
}

// Opening catches the minimum Node requirement; querying through a Script
// exercises the authorizer that requires Node 24.10.
const directory = mkdtempSync(join(tmpdir(), 'northtalk-package-sqlite-'));
let database;
try {
  database = sqlite.openSqliteDatabase(join(directory, 'smoke.sqlite'));
  database.exec(
    'CREATE TABLE answers (value INTEGER); INSERT INTO answers VALUES (42)',
  );
  const capability = sqliteCapability(
    sqlite.sqliteDatabases({ app: database }),
    Object.fromEntries(
      ['query', 'change', 'begin', 'commit', 'rollback'].map(name => [
        name,
        { fuel: 1 },
      ]),
    ),
    0,
  );
  const group = newGroup({ name: 'sqlite-smoke' });
  const script = group.load({
    name: 'main',
    source: `on answer
  ask db to query "SELECT value FROM answers", [], 1
  return the value of item 1 of it
end answer`,
    grants: { db: capability.grant('all', { database: 'app', maxRows: 1 }) },
  });
  const reply = script.request({ name: 'answer', args: [] });
  group.pump(parseInstant('2026-10-26T00:00:00Z'));
  strictEqual((await reply.result).toString(), '42', 'SQLite Capability query');
} finally {
  try {
    database?.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
console.log(await smoke());
