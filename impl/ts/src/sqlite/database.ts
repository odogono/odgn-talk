// A `sqlite` database on `node:sqlite`, which Node, Deno and Bun all provide
// (chapter 9, `sqlite` Host obligations; ADR 0070). One database is one
// Segment Coordinator, shared by every `sqlite` Grant on it and by the Stores
// it keeps. A Segment's first write takes the one writer connection and opens
// its transaction; every other read goes through a read-only connection,
// which in WAL mode sees the last committed state. Reservations and the write
// lock live in this process, so the process owns the file: it holds an
// exclusive lock on a sidecar database, `<path>-lock`, until it closes.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  Call,
  EffectResult,
  SegmentContext,
  SegmentCoordinator,
} from '../capabilities';
import { HostError, type ScriptError } from '../errors';
import type {
  SqliteBinding,
  SqlParams,
  SqlRows,
  SqlValue,
} from '../sqlite-capability';
import { hostScriptError, type StoreImpl } from '../store-capability';
import { encodeValue } from '../encoding';
import { decodeValue } from '../readers';
import {
  StoreContentsError,
  Stores,
  type StoreBackend,
  type StoreQuotas,
} from '../store/engine';
import { dec, text, type Value } from '../values';
import { scan, type Placeholder } from './scan';

/** The table that keeps a database's Stores, which no `sqlite` Grant may use. */
export const STORE_TABLE = 'store';

export type SqliteDatabaseOptions = {
  /** Keep Stores in the database, with these quotas, on its coordinator. */
  readonly stores?: StoreQuotas;
};

/** The Stores a database keeps: the `store` implementation and the Host's commands. */
export type SqliteStores = StoreImpl &
  Pick<Stores, 'clear' | 'entries' | 'replace'>;

const OK: EffectResult = { status: 'ok' };

// sqlite3_set_authorizer's action codes and answers.
const SQLITE_OK = 0;
const SQLITE_DENY = 1;
const PRAGMA = 19;
const READ = 20;
const TRANSACTION = 22;
const ATTACH = 24;
const DETACH = 25;
const FUNCTION = 31;
const SAVEPOINT = 32;
// Which argument names the table, for each action that uses one.
const TABLE_ARG: Record<number, 1 | 2> = {
  1: 2, // CREATE_INDEX
  2: 1, // CREATE_TABLE
  3: 2, // CREATE_TEMP_INDEX
  4: 1, // CREATE_TEMP_TABLE
  5: 2, // CREATE_TEMP_TRIGGER
  6: 1, // CREATE_TEMP_VIEW
  7: 2, // CREATE_TRIGGER
  8: 1, // CREATE_VIEW
  9: 1, // DELETE
  10: 2, // DROP_INDEX
  11: 1, // DROP_TABLE
  12: 2, // DROP_TEMP_INDEX
  13: 1, // DROP_TEMP_TABLE
  14: 2, // DROP_TEMP_TRIGGER
  15: 1, // DROP_TEMP_VIEW
  16: 2, // DROP_TRIGGER
  17: 1, // DROP_VIEW
  18: 1, // INSERT
  20: 1, // READ
  23: 1, // UPDATE
  26: 2, // ALTER_TABLE
  28: 1, // ANALYZE
  29: 1, // CREATE_VTABLE
  30: 1, // DROP_VTABLE
};
// Every action but these could write, which sqlite3_stmt_readonly reports
// and node:sqlite doesn't expose.
const READS = new Set([PRAGMA, READ, 21, FUNCTION, 33]);
const DENIED = new Set([TRANSACTION, ATTACH, DETACH, SAVEPOINT]);
const SCHEMA_PRAGMAS = new Set([
  'table_info',
  'table_xinfo',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
]);
const TABLE_PRAGMAS = new Set([
  'table_info',
  'table_xinfo',
  'index_list',
  'foreign_key_list',
]);

const CONSTRAINT_KINDS: Record<number, string> = {
  2067: 'unique',
  1555: 'primary key',
  1299: 'not null',
  275: 'check',
  787: 'foreign key',
  3091: 'datatype',
  1811: 'trigger',
};

const failure = (
  code: string,
  fields: readonly (readonly [string, Value])[] = [],
): ScriptError => hostScriptError(code, fields);
const sqlFailure = (reason: string) =>
  failure('sql', [['reason', text(reason)]]);

type SqliteFault = Error & { errcode?: number };
const isSqliteFault = (error: unknown): error is SqliteFault =>
  error instanceof Error &&
  ((error as { code?: unknown }).code === 'ERR_SQLITE_ERROR' ||
    typeof (error as SqliteFault).errcode === 'number');

// SQLite's failure as the Script sees it.
const translated = (error: unknown): unknown => {
  if (!isSqliteFault(error)) {
    return error;
  }
  const code = error.errcode ?? 1;
  switch (code & 0xff) {
    case 19:
      return failure('constraint', [
        ['kind', text(CONSTRAINT_KINDS[code] ?? 'other')],
      ]);
    case 5:
    case 6:
      return failure('sqlite busy');
    default:
      return sqlFailure(error.message);
  }
};

const named = (p: Placeholder) => p.kind === 'named';

// `sql` unless the parameters match the placeholders as
// sqlite3_bind_parameter_count counts them.
const checkParams = (
  placeholders: readonly Placeholder[],
  params: SqlParams,
) => {
  const names = placeholders.filter(named) as Extract<
    Placeholder,
    { kind: 'named' }
  >[];
  if (names.some(p => p.prefix !== ':')) {
    throw sqlFailure('Only ?, ?NNN and :name placeholders are allowed');
  }
  if (names.length && names.length < placeholders.length) {
    throw sqlFailure('Placeholders are either positional or named');
  }
  if (Array.isArray(params)) {
    if (names.length) {
      throw sqlFailure('A list binds only positional placeholders');
    }
    let count = 0;
    for (const p of placeholders) {
      count =
        p.kind === 'positional' && p.index !== undefined
          ? Math.max(count, p.index)
          : count + 1;
    }
    if (params.length !== count) {
      throw sqlFailure(
        `The statement has ${count} parameters, and ${params.length} were given`,
      );
    }
    return;
  }
  const map = params as ReadonlyMap<string, SqlValue>;
  if (placeholders.length > names.length) {
    throw sqlFailure('A map binds only :name placeholders');
  }
  const wanted = new Set(names.map(p => p.name));
  if (wanted.size !== map.size || [...map.keys()].some(k => !wanted.has(k))) {
    throw sqlFailure(
      `The statement's parameters are ${[...wanted].map(n => `:${n}`).join(', ') || 'none'}`,
    );
  }
};

type Access = {
  readonly store?: string;
  readonly tables?: ReadonlySet<string>;
};

// The authorizer for one call. It sets `wrote` for an action that could
// write, so a `query` can refuse it once the statement is prepared.
const authorizer = (access: Access, wrote: { value: boolean }) => {
  const usable = (table: string | null) => {
    if (table === null) {
      return true;
    }
    const name = table.toLowerCase();
    if (name === access.store) {
      return false;
    }
    // The schema tables are read and written for the statement's own work.
    return (
      !access.tables || name.startsWith('sqlite_') || access.tables.has(name)
    );
  };
  return (action: number, arg1: string | null, arg2: string | null): number => {
    if (DENIED.has(action)) {
      return SQLITE_DENY;
    }
    if (action === FUNCTION) {
      return arg2?.toLowerCase() === 'load_extension' ? SQLITE_DENY : SQLITE_OK;
    }
    if (action === PRAGMA) {
      const pragma = (arg1 ?? '').toLowerCase();
      if (pragma === 'user_version') {
        return arg2 === null ? SQLITE_OK : SQLITE_DENY;
      }
      return SCHEMA_PRAGMAS.has(pragma) &&
        (!TABLE_PRAGMAS.has(pragma) || usable(arg2))
        ? SQLITE_OK
        : SQLITE_DENY;
    }
    // A pragma's table-valued function reads what the pragma would.
    if (
      action === READ &&
      arg1?.toLowerCase().startsWith('pragma_') &&
      !SCHEMA_PRAGMAS.has(arg1.toLowerCase().slice(7))
    ) {
      return SQLITE_DENY;
    }
    const at = TABLE_ARG[action];
    if (at && !usable(at === 1 ? arg1 : arg2)) {
      return SQLITE_DENY;
    }
    if (!READS.has(action)) {
      wrote.value = true;
    }
    return SQLITE_OK;
  };
};

/** One database a Host offers through `sqlite`, and the Stores it may keep. */
export class SqliteDatabase {
  /** Every Grant on the database, and its Stores, map to this coordinator. */
  readonly coordinator: SegmentCoordinator;
  /** The Stores, for `storeCapability`, when the database keeps them. */
  readonly stores?: SqliteStores;

  private readonly lock: DatabaseSync;
  private readonly reader: DatabaseSync;
  private readonly writer: DatabaseSync;
  private readonly engine?: Stores;
  private readonly counts: StatementSync;
  // The Segment that holds the writer's transaction, and its savepoints.
  private holder?: string;
  private savepoints = 0;
  // The Segment whose commit is saving its Stores' changes.
  private committing?: string;
  // Offered through `sqlite`, so a Store write takes the write lock at its call.
  private shared = false;
  private readonly groups = new WeakMap<object, number>();
  private nextGroup = 0;

  constructor(path: string, options: SqliteDatabaseOptions = {}) {
    if (path === '' || path === ':memory:') {
      throw new HostError(
        'invalid value',
        'A sqlite database is a file, which its connections share',
      );
    }
    if (typeof DatabaseSync.prototype.setAuthorizer !== 'function') {
      throw new HostError(
        'invalid value',
        'sqlite needs node:sqlite with setAuthorizer, as in Node 24.10 or later',
      );
    }
    const opened: DatabaseSync[] = [];
    try {
      this.lock = new DatabaseSync(`${path}-lock`);
      opened.push(this.lock);
      try {
        this.lock.exec(
          'PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT',
        );
      } catch (error) {
        throw new Error(`Another connection holds ${path}`, { cause: error });
      }
      this.writer = new DatabaseSync(path, {
        enableForeignKeyConstraints: true,
      });
      opened.push(this.writer);
      this.writer.exec('PRAGMA journal_mode = WAL');
      this.reader = new DatabaseSync(path, {
        readOnly: true,
        enableForeignKeyConstraints: true,
      });
      opened.push(this.reader);
      this.counts = this.writer.prepare(
        'SELECT changes() AS changes, total_changes() AS total',
      );
      const lifecycle: SegmentCoordinator = {
        begin: context => this.beginSegment(context),
        commit: context => this.commitSegment(context),
        rollback: context => this.rollbackSegment(context),
      };
      this.coordinator = lifecycle;
      if (options.stores) {
        const engine = new Stores(this.storeBackend(), options.stores);
        this.engine = engine;
        this.stores = Object.assign(lifecycle, this.storeOperations(engine));
      }
    } catch (error) {
      for (const db of opened.reverse()) {
        db.close();
      }
      throw error;
    }
  }

  /**
   * Marks the database as offered through `sqlite`, as `sqliteDatabases`
   * does. From then on a Store write takes the write lock at its call, so a
   * Store's commit never finds it held (ADR 0070). Until then, a Store's
   * commit takes the lock only for the commit.
   */
  shareWithSqlite(): void {
    this.shared = true;
  }

  /** Runs SQL directly, outside every Segment and with no authorizer, as for a migration. */
  exec(sql: string): void {
    if (this.holder !== undefined) {
      throw new Error('A Segment holds the database’s write lock');
    }
    this.writer.exec(sql);
  }

  /** Closes the database, discarding any Segment's uncommitted changes. */
  close(): void {
    this.holder = undefined;
    this.reader.close();
    this.writer.close();
    this.lock.close();
  }

  // ------------------------------------------------------------ Operations

  query(
    call: Call<SqliteBinding>,
    sql: string,
    params: SqlParams,
    max: number,
  ): SqlRows {
    const connection =
      this.holder === this.key(call) ? this.writer : this.reader;
    return this.statement(connection, call.binding, sql, params, max, true);
  }

  change(
    call: Call<SqliteBinding>,
    sql: string,
    params: SqlParams,
    max: number,
  ): SqlRows & { readonly changes: number } {
    this.acquire(call, () => failure('sqlite busy'));
    // A call that fails, even after changing rows, changes nothing.
    const before = this.changeCounts().total;
    this.writer.exec('SAVEPOINT northtalk_call');
    try {
      const result = this.statement(
        this.writer,
        call.binding,
        sql,
        params,
        max,
        false,
      );
      const { changes, total } = this.changeCounts();
      this.writer.exec('RELEASE northtalk_call');
      // changes() keeps the last data change's count through other statements.
      return { ...result, changes: total > before ? changes : 0 };
    } catch (error) {
      this.writer.exec('ROLLBACK TO northtalk_call; RELEASE northtalk_call');
      throw error;
    }
  }

  begin(call: Call<SqliteBinding>): void {
    this.acquire(call, () => failure('sqlite busy'));
    this.savepoints++;
    this.writer.exec(`SAVEPOINT northtalk_${this.savepoints}`);
  }

  commit(call: Call<SqliteBinding>): void {
    this.held(call);
    this.writer.exec(`RELEASE northtalk_${this.savepoints}`);
    this.savepoints--;
  }

  rollback(call: Call<SqliteBinding>): void {
    this.held(call);
    const savepoint = `northtalk_${this.savepoints}`;
    this.writer.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    this.savepoints--;
  }

  // ------------------------------------------------------------ lifecycle

  // Only prepares the Segment: its first write takes the lock.
  private beginSegment(context: SegmentContext<unknown>): EffectResult {
    return this.engine?.begin(context as SegmentContext<string>) ?? OK;
  }

  private commitSegment(context: SegmentContext<unknown>): EffectResult {
    const segment = this.key(context);
    if (this.holder !== segment) {
      // The Stores' changes, if any, commit in a transaction of their own.
      return this.engine?.commit(context as SegmentContext<string>) ?? OK;
    }
    this.committing = segment;
    try {
      // Saving the Stores' changes, if any, commits the transaction.
      const stored = this.engine?.commit(context as SegmentContext<string>);
      if (stored && stored.status !== 'ok') {
        this.abandon();
        return stored;
      }
      if (this.holder === segment) {
        this.publish();
      }
      return OK;
    } catch (error) {
      return { status: 'failed', detail: (error as Error).message };
    } finally {
      this.committing = undefined;
    }
  }

  private rollbackSegment(context: SegmentContext<unknown>): EffectResult {
    if (this.holder === this.key(context)) {
      this.abandon();
    }
    return this.engine?.rollback(context as SegmentContext<string>) ?? OK;
  }

  // ------------------------------------------------------------ internals

  private key(at: { group: object; segmentId: string }): string {
    let group = this.groups.get(at.group);
    if (group === undefined) {
      group = this.nextGroup++;
      this.groups.set(at.group, group);
    }
    return `${group} ${at.segmentId}`;
  }

  // Takes the write lock for the calling Segment, or fails with `busy`.
  private acquire(at: { group: object; segmentId: string }, busy: () => Error) {
    const segment = this.key(at);
    if (this.holder === segment) {
      return;
    }
    if (this.holder !== undefined) {
      throw busy();
    }
    try {
      this.writer.exec('BEGIN IMMEDIATE');
    } catch (error) {
      const fault = translated(error);
      throw fault instanceof Error &&
        'code' in fault &&
        fault.code === 'sqlite busy'
        ? busy()
        : fault;
    }
    this.holder = segment;
    this.savepoints = 0;
  }

  private held(call: Call<SqliteBinding>) {
    if (this.holder !== this.key(call) || this.savepoints === 0) {
      throw new Error('No transaction of this Segment is open');
    }
  }

  // Commits the transaction, or rolls it back and throws.
  private publish() {
    try {
      this.writer.exec('COMMIT');
    } catch (error) {
      this.abandon();
      throw error;
    }
    this.holder = undefined;
  }

  private abandon() {
    // A refused COMMIT leaves the transaction open; any other ends it.
    if (this.writer.isTransaction) {
      this.writer.exec('ROLLBACK');
    }
    this.holder = undefined;
  }

  private changeCounts(): { changes: number; total: number } {
    const row = this.counts.get() as { changes: number; total: number };
    return { changes: Number(row.changes), total: Number(row.total) };
  }

  // Runs one statement under the binding's authorizer.
  private statement(
    connection: DatabaseSync,
    binding: SqliteBinding,
    sql: string,
    params: SqlParams,
    max: number,
    readOnly: boolean,
  ): SqlRows {
    const scanned = scan(sql);
    if (scanned.keyword === '') {
      throw sqlFailure('The SQL holds no statement');
    }
    // VACUUM INTO writes a copy without consulting the authorizer.
    if (scanned.keyword === 'VACUUM') {
      throw sqlFailure('VACUUM is not allowed');
    }
    checkParams(
      scanned.placeholders.map(([, p]) => p),
      params,
    );
    const wrote = { value: false };
    connection.setAuthorizer(
      authorizer(
        {
          store: this.engine ? STORE_TABLE : undefined,
          tables: binding.tables
            ? new Set(binding.tables.map(t => t.toLowerCase()))
            : undefined,
        },
        wrote,
      ),
    );
    try {
      const prepared = this.prepareOne(connection, sql, scanned);
      if (readOnly && wrote.value) {
        throw failure('not read-only');
      }
      prepared.setReturnArrays(true);
      prepared.setReadBigInts(true);
      const columns = prepared.columns().map(c => c.name);
      const rows: SqlValue[][] = [];
      const bound = Array.isArray(params)
        ? (params as SqlValue[])
        : [Object.fromEntries(params as ReadonlyMap<string, SqlValue>)];
      // Stepped no further than max + 1 rows, where the runtime allows.
      const stepped = iterateReportsErrors()
        ? prepared.iterate(...(bound as SqlValue[]))
        : prepared.all(...(bound as SqlValue[]));
      for (const row of stepped as Iterable<SqlValue[]>) {
        if (rows.length === max) {
          throw failure('too many rows', [['max', dec(String(max))]]);
        }
        rows.push(row.map((value, i) => decoded(value, columns[i]!)));
      }
      return { columns, rows };
    } catch (error) {
      throw translated(error);
    } finally {
      connection.setAuthorizer(null);
    }
  }

  // The one statement in `sql`: `sql` if anything after a complete first
  // statement is white space and comments. A `;` that ends no statement,
  // as in a trigger's body, doesn't count.
  private prepareOne(
    connection: DatabaseSync,
    sql: string,
    scanned: ReturnType<typeof scan>,
  ): StatementSync {
    for (const [i, end] of scanned.ends.entries()) {
      if (!scanned.trailing[i]) {
        return connection.prepare(sql);
      }
      try {
        connection.prepare(sql.slice(0, end + 1));
      } catch (error) {
        if (isSqliteFault(error) && /incomplete input/.test(error.message)) {
          continue;
        }
        throw error;
      }
      throw sqlFailure('A call runs one statement');
    }
    throw new Error('A scan always ends at the text’s end');
  }

  private storeBackend(): StoreBackend {
    this.writer.exec(
      `CREATE TABLE IF NOT EXISTS ${STORE_TABLE} (name TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (name, key)) WITHOUT ROWID`,
    );
    const select = this.reader.prepare(
      `SELECT key, value FROM ${STORE_TABLE} WHERE name = ?`,
    );
    const upsert = this.writer.prepare(
      `INSERT INTO ${STORE_TABLE} (name, key, value) VALUES (?, ?, ?) ON CONFLICT (name, key) DO UPDATE SET value = excluded.value`,
    );
    const remove = this.writer.prepare(
      `DELETE FROM ${STORE_TABLE} WHERE name = ? AND key = ?`,
    );
    const write = (
      changes: ReadonlyMap<string, ReadonlyMap<string, Value>>,
    ) => {
      for (const [name, values] of changes) {
        for (const [key, value] of values) {
          if (value.kind === 'nothing') {
            remove.run(name, key);
          } else {
            upsert.run(name, key, encodeValue(value));
          }
        }
      }
    };
    return {
      load: name =>
        (select.all(name) as { key: string; value: string }[]).map(
          ({ key, value }) => [key, decodeValue(value)] as const,
        ),
      save: changes => {
        if (this.committing !== undefined) {
          // Inside the committing Segment's transaction, which this publishes.
          try {
            write(changes);
          } catch (error) {
            this.abandon();
            throw error;
          }
          this.publish();
          return;
        }
        // A commit of only the Stores' changes, or a Host command.
        if (this.holder !== undefined) {
          throw new StoreContentsError(
            'A Segment holds the database’s write lock',
          );
        }
        this.writer.exec('BEGIN IMMEDIATE');
        try {
          write(changes);
        } catch (error) {
          this.writer.exec('ROLLBACK');
          throw error;
        }
        this.writer.exec('COMMIT');
      },
    };
  }

  // On a database offered through `sqlite`, a Store write takes the write
  // lock at its call.
  private storeWrite(call: Call<string>, key: string) {
    if (this.shared) {
      this.acquire(call, () => failure('store busy', [['key', text(key)]]));
    }
  }

  private storeOperations(
    engine: Stores,
  ): Omit<SqliteStores, keyof SegmentCoordinator> {
    return {
      get: (call, key, fallback) => engine.get(call, key, fallback),
      keys: (call, prefix) => engine.keys(call, prefix),
      set: (call, key, value) => {
        this.storeWrite(call, key);
        engine.set(call, key, value);
      },
      delete: (call, key) => {
        this.storeWrite(call, key);
        engine.delete(call, key);
      },
      increment: (call, key, by) => {
        this.storeWrite(call, key);
        return engine.increment(call, key, by);
      },
      swap: (call, key, expected, replacement) => {
        this.storeWrite(call, key);
        return engine.swap(call, key, expected, replacement);
      },
      entries: store => engine.entries(store),
      replace: (store, entries) => engine.replace(store, entries),
      clear: store => engine.clear(store),
    };
  }
}

// Deno 2.9's `iterate` ends quietly when a step fails, where Node's and Bun's
// throw, so there a call steps every row with `all`, which throws.
let iterates: boolean | undefined;
const iterateReportsErrors = (): boolean => {
  if (iterates === undefined) {
    const probe = new DatabaseSync(':memory:');
    try {
      probe.prepare('SELECT abs(-9223372036854775807 - 1)').iterate().next();
      iterates = false;
    } catch {
      iterates = true;
    } finally {
      probe.close();
    }
  }
  return iterates;
};

// node:sqlite decodes TEXT with replacement characters, so one may stand for
// bytes that weren't UTF-8. Refusing it keeps them from reaching a Script.
const decoded = (value: SqlValue, column: string): SqlValue => {
  if (typeof value === 'string' && value.includes('�')) {
    throw failure('unrepresentable', [['column', text(column)]]);
  }
  return value;
};

/** Opens or creates the database at `path`, which the process holds until `close`. */
export const openSqliteDatabase = (
  path: string,
  options?: SqliteDatabaseOptions,
): SqliteDatabase => new SqliteDatabase(path, options);
