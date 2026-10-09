// A `sqlite` implementation on `node:sqlite`, for Hosts on Node, Deno or Bun
// (chapter 9, `sqlite` Host obligations). None of this is the Core: a Host
// passes `sqliteDatabases` to `sqliteCapability`, and a database's Stores to
// `storeCapability`.
import { HostError } from '../errors';
import type { SqliteImpl } from '../sqlite-capability';
import type { SqliteDatabase } from './database';

export {
  openSqliteDatabase,
  SqliteDatabase,
  STORE_TABLE,
  type SqliteDatabaseOptions,
  type SqliteStores,
} from './database';

/**
 * The implementation over the Host's databases, by the name a binding gives.
 * Each database's Store writes then take its write lock at their call.
 */
export const sqliteDatabases = (
  databases: Readonly<Record<string, SqliteDatabase>>,
): SqliteImpl => {
  for (const db of Object.values(databases)) {
    db.shareWithSqlite();
  }
  const named = (name: string) => {
    if (!Object.hasOwn(databases, name)) {
      throw new HostError(
        'invalid value',
        `No sqlite database is named ${name}`,
      );
    }
    return databases[name]!;
  };
  return {
    coordinator: database => named(database).coordinator,
    query: (call, sql, params, max) =>
      named(call.binding.database).query(call, sql, params, max),
    change: (call, sql, params, max) =>
      named(call.binding.database).change(call, sql, params, max),
    begin: call => named(call.binding.database).begin(call),
    commit: call => named(call.binding.database).commit(call),
    rollback: call => named(call.binding.database).rollback(call),
  };
};
