// Chapter 7's `sqlite` declarations and chapter 9's factory. The Core checks
// the Shapes and `max`, converts `params` and results, charges the rows and
// keeps the `transaction` scope; running SQL, with the database's
// transactions and the authorizer, is the Host implementation's obligation.
import {
  defineCapability,
  expectedOf,
  shape,
  type Call,
  type CapabilityDef,
  type ImmediateOp,
  type SegmentCoordinator,
  type Shape,
} from './capabilities';
import { HostError, ScriptError as HostScriptError } from './errors';
import { ScriptError } from './operations';
import { costOf, fixed, type Costs } from './standard-capabilities';
import { registerStandardChecks } from './standard-capability-checks';
import {
  bytes,
  dec,
  listValues,
  map,
  nothing,
  num,
  text,
  type Value,
} from './values';

/**
 * sqlite is optional (chapter 7, ADR 0070). The binding names a database the
 * Host keeps; tables, when present, limits the tables a Grant may use, and
 * maxRows caps the rows a call may give.
 */
export type SqliteBinding = {
  readonly database: string;
  readonly maxRows: number;
  readonly tables?: readonly string[];
};
/** NULL, INTEGER, REAL, TEXT and BLOB. */
export type SqlValue = null | bigint | number | string | Uint8Array;
/** A list binds `?` and `?NNN`; a Map binds `:name`, keyed without the colon. */
export type SqlParams = readonly SqlValue[] | ReadonlyMap<string, SqlValue>;
export type SqlRows = {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly SqlValue[])[];
};
/**
 * The Core has checked the Shapes and max, converted params by the chapter 7
 * rules and charged max × perRow. It converts the result, raising `sql` for a
 * column named twice and `unrepresentable` for a double it can't hold.
 * change, begin, commit and rollback are Segment-bound: they act inside the
 * calling Segment's transaction, which the coordinator publishes or discards.
 * begin, commit and rollback open, release and roll back a savepoint. A failed
 * call leaves the database as it was. Throw ScriptError `sql` {reason},
 * `constraint` {kind}, `sqlite busy`, `not read-only`, `too many rows` {max},
 * or `unrepresentable` {column} for TEXT that isn't valid UTF-8 (chapter 9).
 */
export type SqliteImpl = {
  begin(call: Call<SqliteBinding>): void;
  change(
    call: Call<SqliteBinding>,
    sql: string,
    params: SqlParams,
    max: number,
  ): SqlRows & { readonly changes: number };
  commit(call: Call<SqliteBinding>): void;
  /** Called once per Grant. The same database gives the same coordinator. */
  coordinator(database: string): SegmentCoordinator;
  query(
    call: Call<SqliteBinding>,
    sql: string,
    params: SqlParams,
    max: number,
  ): SqlRows;
  rollback(call: Call<SqliteBinding>): void;
};

const MAX_WHOLE = Number.MAX_SAFE_INTEGER;
const isWhole = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 0;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// `any`, so a Function Value anywhere in params is `not encodable`; the
// argument check then refuses anything but a list or a map.
const paramsShape: Shape = shape.any;
const maxShape = shape.optional(shape.number);
const sqlShape = shape.oneOf(
  shape.nothing,
  shape.number,
  shape.text,
  shape.bytes,
  shape.bool,
);
const SQL_KINDS = new Set(['nothing', 'number', 'text', 'bytes', 'boolean']);
const CONSTRAINTS = [
  'unique',
  'primary key',
  'not null',
  'check',
  'foreign key',
  'datatype',
  'trigger',
  'other',
];

const isText = (data: Value, field: string) => data.get(field).kind === 'text';
// The fields each code the Host may fail with must carry.
const errorFields: Record<string, (data: Value) => boolean> = {
  sql: data => isText(data, 'reason'),
  constraint: data => CONSTRAINTS.includes(data.get('kind').asText() ?? ''),
  'sqlite busy': () => true,
  'not read-only': () => true,
  'too many rows': data => data.get('max').kind === 'number',
  unrepresentable: data => isText(data, 'column'),
};
const errors = (...codes: string[]) => codes.map(code => ({ code }));
// A Core-raised failure, which carries no message, as the Core's own errors don't.
const coreFailure = (code: string, field: string, value: string) =>
  new HostScriptError(code, '', map([[field, text(value)]]));

const checkBinding = (binding: SqliteBinding) => {
  if (
    !binding ||
    typeof binding !== 'object' ||
    typeof binding.database !== 'string' ||
    !isWhole(binding.maxRows) ||
    (binding.tables !== undefined &&
      (!Array.isArray(binding.tables) ||
        !binding.tables.every(t => typeof t === 'string')))
  ) {
    throw new HostError(
      'invalid value',
      'A sqlite binding is {database, tables, maxRows}',
    );
  }
};

// The rows a call may give: `max`, or the binding's cap when it is omitted.
const rowsAllowed = (max: Value | undefined, binding: SqliteBinding) => {
  if (max === undefined || max.kind === 'nothing') {
    return binding.maxRows;
  }
  const [whole, fraction = ''] = max.asDecimal()!.toString().split('.');
  if (
    whole!.startsWith('-') ||
    /[1-9]/.test(fraction) ||
    BigInt(whole!) > BigInt(binding.maxRows)
  ) {
    throw new ScriptError(
      'out of range',
      [
        ['field', text('max')],
        ['value', max],
      ],
      true,
    );
  }
  return Number(whole);
};

const sqlValueOf = (v: Value): SqlValue => {
  switch (v.kind) {
    case 'nothing':
      return null;
    case 'boolean':
      return v.asBool() ? 1n : 0n;
    case 'text':
      return v.asText()!;
    case 'bytes':
      return v.asBytes()!;
    default: {
      // A whole number that fits binds as INTEGER, any other as REAL.
      const canonical = v.asDecimal()!.toString();
      if (!canonical.includes('.')) {
        const n = BigInt(canonical);
        if (n >= INT64_MIN && n <= INT64_MAX) {
          return n;
        }
      }
      return Number(canonical);
    }
  }
};

const paramsOf = (params: Value): SqlParams =>
  params.kind === 'list'
    ? Array.from({ length: params.length }, (_, i) =>
        sqlValueOf(params.index(i + 1)),
      )
    : new Map(params.entries().map(([k, v]) => [k, sqlValueOf(v)]));

const checkParams = (
  params: Value,
  named: readonly (readonly [string, Value])[],
) => {
  const wrongKind = (
    expected: string,
    item: Value,
    path: readonly (readonly [string, Value])[],
  ) =>
    new ScriptError(
      'wrong kind',
      [
        ['expected', text(expected)],
        ['got', text(item.kind)],
        ['value', item],
        ...named,
        ['argument', dec('2')],
        ...path,
      ],
      true,
    );
  if (params.kind !== 'list' && params.kind !== 'map') {
    throw wrongKind('list or map', params, []);
  }
  const items: [string | number, Value][] =
    params.kind === 'list'
      ? Array.from({ length: params.length }, (_, i) => [
          i + 1,
          params.index(i + 1),
        ])
      : params.entries();
  for (const [at, item] of items) {
    if (!SQL_KINDS.has(item.kind)) {
      throw wrongKind(expectedOf(sqlShape), item, [
        [
          'path',
          listValues([typeof at === 'number' ? dec(String(at)) : text(at)]),
        ],
      ]);
    }
  }
};

// The result's form is the implementation's; a broken one is `host error`.
const checkForm = (result: SqlRows, max: number, changes: boolean) => {
  const ok =
    !!result &&
    typeof result === 'object' &&
    Array.isArray(result.columns) &&
    result.columns.every(c => typeof c === 'string') &&
    Array.isArray(result.rows) &&
    result.rows.length <= max &&
    result.rows.every(
      row => Array.isArray(row) && row.length === result.columns.length,
    ) &&
    (!changes || isWhole((result as SqlRows & { changes: number }).changes));
  if (!ok) {
    throw new Error('A sqlite implementation gave a malformed result');
  }
};

const valueOf = (v: SqlValue, column: string): Value => {
  const unrepresentable = () =>
    coreFailure('unrepresentable', 'column', column);
  if (v === null) {
    return nothing;
  }
  if (typeof v === 'bigint') {
    if (v < INT64_MIN || v > INT64_MAX) {
      throw new Error('A sqlite INTEGER must fit 64 bits');
    }
    return dec(v.toString());
  }
  if (typeof v === 'number') {
    try {
      return num(v);
    } catch (error) {
      if (error instanceof HostError) {
        throw unrepresentable();
      }
      throw error;
    }
  }
  if (typeof v === 'string') {
    // Under the u flag, only a lone surrogate matches.
    if (/[\uD800-\uDFFF]/u.test(v)) {
      throw unrepresentable();
    }
    return text(v);
  }
  if (
    ArrayBuffer.isView(v) &&
    Object.prototype.toString.call(v) === '[object Uint8Array]'
  ) {
    return bytes(v as Uint8Array);
  }
  throw new Error('A sqlite value must be NULL, INTEGER, REAL, TEXT or BLOB');
};

const rowsOf = (result: SqlRows): Value => {
  const columns = result.columns.map(c => c.normalize('NFC'));
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column)) {
      throw coreFailure('sql', 'reason', `duplicate column ${column}`);
    }
    seen.add(column);
  }
  return listValues(
    result.rows.map(row =>
      map(columns.map((column, i) => [column, valueOf(row[i]!, column)])),
    ),
  );
};

/** Optional for Hosts. perRow is whole Fuel charged per row of max. */
export const sqliteCapability = (
  impl: SqliteImpl,
  costs: Costs,
  perRow: number,
): CapabilityDef<SqliteBinding> => {
  for (const name of [
    'coordinator',
    'query',
    'change',
    'begin',
    'commit',
    'rollback',
  ]) {
    if (!impl || typeof impl[name as keyof SqliteImpl] !== 'function') {
      throw new HostError('invalid value', `sqlite needs ${name}`);
    }
  }
  if (!isWhole(perRow)) {
    throw new HostError(
      'invalid value',
      'The per-row cost must be a whole number',
    );
  }
  // Charged before the work, whatever the statement then gives. A product
  // past every Fuel limit faults the same as the exact one would.
  const chargeRows = (call: Call<SqliteBinding>, max: number) =>
    call.charge(Math.min(max * perRow, MAX_WHOLE));
  const statement =
    (
      run: (
        call: Call<SqliteBinding>,
        sql: string,
        params: SqlParams,
        max: number,
      ) => Value,
    ) =>
    (call: Call<SqliteBinding>, ...args: Value[]) => {
      const max = rowsAllowed(args[2], call.binding);
      chargeRows(call, max);
      return run(call, args[0]!.asText()!, paramsOf(args[1]!), max);
    };
  const statementArgs = [shape.text, paramsShape, maxShape];
  const scoped = (
    name: 'begin' | 'commit' | 'rollback',
    scope: ImmediateOp<SqliteBinding>['scope'],
    codes: string[],
  ): ImmediateOp<SqliteBinding> => ({
    mode: 'immediate',
    args: [],
    result: shape.nothing,
    errors: errors(...codes),
    cost: costOf(costs, name),
    segmentBound: true,
    scope,
    do: call => {
      impl[name](call);
      return nothing;
    },
  });
  const operations: Record<string, ImmediateOp<SqliteBinding>> = {
    query: {
      mode: 'immediate',
      args: statementArgs,
      result: shape.listOf(shape.any),
      errors: errors(
        'sql',
        'not read-only',
        'too many rows',
        'unrepresentable',
      ),
      cost: costOf(costs, 'query'),
      do: statement((call, sql, params, max) => {
        const result = impl.query(call, sql, params, max);
        checkForm(result, max, false);
        return rowsOf(result);
      }),
    },
    change: {
      mode: 'immediate',
      args: statementArgs,
      result: shape.map({
        changes: shape.number,
        rows: shape.listOf(shape.any),
      }),
      errors: errors(
        'sql',
        'constraint',
        'sqlite busy',
        'too many rows',
        'unrepresentable',
      ),
      cost: costOf(costs, 'change'),
      segmentBound: true,
      do: statement((call, sql, params, max) => {
        const result = impl.change(call, sql, params, max);
        checkForm(result, max, true);
        const rows = rowsOf(result);
        return map([
          ['changes', dec(String(result.changes))],
          ['rows', rows],
        ]);
      }),
    },
    begin: scoped('begin', { opens: 'transaction', abandon: 'rollback' }, [
      'sqlite busy',
    ]),
    commit: scoped('commit', { closes: 'transaction' }, []),
    rollback: scoped('rollback', { closes: 'transaction' }, []),
  };
  // Every Grant on one database shares its coordinator (ADR 0069), mapped
  // once, when the Grant is created, which is where a bad binding fails.
  const capability = defineCapability<SqliteBinding>('sqlite', operations, {
    coordinator: binding => {
      checkBinding(binding);
      return impl.coordinator(binding.database);
    },
  });
  for (const [name, op] of capability.operations) {
    registerStandardChecks(op, {
      error: (code, data) =>
        Boolean(
          op.errors?.some(e => e.code === code) && errorFields[code]?.(data),
        ),
      ...(name === 'query' || name === 'change'
        ? {
            arguments: (args, binding, named) => {
              rowsAllowed(args[2], binding as SqliteBinding);
              checkParams(args[1]!, named);
            },
          }
        : {}),
    });
  }
  return fixed(capability);
};
