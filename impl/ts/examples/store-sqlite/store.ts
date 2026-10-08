// A SQLite Store backend on `bun:sqlite`: each Store's keys are rows, their
// values in the Value Encoding, and a commit, to every Store a Segment wrote,
// is one transaction. The engine keeps the reservations and quotas in this
// process, so the database file is owned by one process, which takes an
// exclusive lock when it opens it (ADR 0050, ADR 0062, ADR 0069).
import { Database } from 'bun:sqlite';
import { decodeValue, encodeValue, type Value } from '../../src/index';
import {
  Stores,
  type StoreBackend,
  type StoreQuotas,
} from '../../src/store/index';

type Row = { key: string; value: string };

/** A backend over an open database, creating its table if it must. */
export const sqliteBackend = (db: Database): StoreBackend => {
  db.run(
    'CREATE TABLE IF NOT EXISTS store (name TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (name, key)) WITHOUT ROWID',
  );
  const select = db.query<Row, [string]>(
    'SELECT key, value FROM store WHERE name = ?',
  );
  const upsert = db.query(
    'INSERT INTO store (name, key, value) VALUES (?, ?, ?) ON CONFLICT (name, key) DO UPDATE SET value = excluded.value',
  );
  const remove = db.query('DELETE FROM store WHERE name = ? AND key = ?');
  const apply = db.transaction(
    (changes: ReadonlyMap<string, ReadonlyMap<string, Value>>) => {
      for (const [name, values] of changes) {
        for (const [key, value] of values) {
          if (value.kind === 'nothing') {
            remove.run(name, key);
          } else {
            upsert.run(name, key, encodeValue(value));
          }
        }
      }
    },
  );
  return {
    load: name =>
      select
        .all(name)
        .map(({ key, value }) => [key, decodeValue(value)] as const),
    save: changes => {
      apply(changes);
    },
  };
};

/**
 * Opens or creates the database at `path` and holds it exclusively until
 * `close`. Opening a file another process or connection holds throws.
 */
export const openSqliteStores = (
  path: string,
  quotas: StoreQuotas,
): { close(): void; stores: Stores } => {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.run('PRAGMA locking_mode = EXCLUSIVE');
    db.run('PRAGMA journal_mode = WAL');
    // Take the lock now, rather than at the first write.
    db.run('BEGIN EXCLUSIVE');
    db.run('COMMIT');
    return {
      stores: new Stores(sqliteBackend(db), quotas),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
};
