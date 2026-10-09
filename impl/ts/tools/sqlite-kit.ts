// Drives a `sqlite` implementation through the sqlite test kit,
// `corpus/sqlite-kit/`: language-neutral statement and lifecycle sequences
// with the results and errors chapters 7 and 9 require of every
// implementation. Each call goes through the factory's Operations and their
// argument checks, so a step gives what a Script would see.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Call,
  CapabilityDef,
  ImmediateOp,
  SegmentContext,
  SegmentCoordinator,
  SegmentGrant,
} from '../src/capabilities';
import { ScriptError as HostScriptError } from '../src/errors';
import type { Group } from '../src/group';
import { ScriptError } from '../src/operations';
import { readDisplay } from '../src/readers';
import {
  sqliteCapability,
  type SqliteBinding,
  type SqliteImpl,
} from '../src/sqlite-capability';
import type { Costs } from '../src/standard-capabilities';
import { standardChecks } from '../src/standard-capability-checks';
import { storeCapability, type StoreImpl } from '../src/store-capability';
import { map, nothing, text, type Value } from '../src/values';

// Not import.meta.dir, so the runner also runs under Node and Deno.
export const sqliteKitRoot = fileURLToPath(
  new URL('../../../corpus/sqlite-kit', import.meta.url),
);

type GrantSpec =
  | { binding: SqliteBinding; capability: 'sqlite' }
  | { binding: string; capability: 'store' };
type Step = {
  args?: string;
  do?: string;
  error?: string;
  gives?: string;
  grant?: string;
  hook?: 'begin' | 'commit' | 'rollback';
  in: string;
  max?: number;
  params?: string;
  sql?: string;
  status?: string;
};
type Sequence = {
  grants?: Record<string, GrantSpec>;
  name: string;
  setup?: string[];
  steps: Step[];
};
type KitFile = { grants: Record<string, GrantSpec>; sequence: Sequence[] };

export type SqliteKitSequence = {
  file: string;
  grants: Record<string, GrantSpec>;
  name: string;
  setup: string[];
  steps: Step[];
};

/** Every sequence in the kit, file by file. */
export const sqliteKitSequences = (root = sqliteKitRoot): SqliteKitSequence[] =>
  readdirSync(root)
    .filter(f => f.endsWith('.toml'))
    .sort()
    .flatMap(file => {
      const kit = Bun.TOML.parse(
        readFileSync(resolve(root, file), 'utf8'),
      ) as KitFile;
      return kit.sequence.map(s => ({
        file,
        name: s.name,
        grants: s.grants ?? kit.grants,
        setup: s.setup ?? [],
        steps: s.steps,
      }));
    });

/** What a runner needs of an implementation, for one fresh database per sequence. */
export type SqliteKitSubject = {
  close(): void;
  /** Runs a setup statement directly, outside every Segment. */
  exec(sql: string): void;
  sqlite: SqliteImpl;
  /** The Stores kept in the database, sharing its coordinator. */
  store: StoreImpl;
  /** The table that keeps the Stores. */
  storeTable: string;
};

const costs = (ops: string[]): Costs =>
  Object.fromEntries(ops.map(op => [op, { fuel: 0 }]));
const SEGMENT_BOUND = new Set([
  'change',
  'begin',
  'commit',
  'rollback',
  'set',
  'delete',
  'increment',
  'swap',
]);

// One Group for every step: Segment ids are unique within it.
const group = {} as Group;
const callOf = <B>(
  segment: string,
  grantName: string,
  binding: B,
  n: number,
): Call<B> => ({
  id: `kit.c${n}`,
  binding,
  segmentId: segment,
  grantName,
  scriptName: 'kit',
  runId: segment,
  automatic: false,
  now: 0n,
  group,
  signal: new AbortController().signal,
  answer: () => {},
  charge: () => {},
  fail: () => {},
});
const contextOf = (
  segment: string,
  grants: readonly SegmentGrant<unknown>[],
): SegmentContext<unknown> => ({
  binding: grants[0]!.binding,
  segmentId: segment,
  grantName: grants[0]!.grantName,
  grants,
  scriptName: 'kit',
  runId: segment,
  now: 0n,
  group,
});

const listOf = (v: Value): Value[] =>
  Array.from({ length: v.length }, (_, i) => v.index(i + 1));

// An error as the kit writes it: its code and fields, with any `sql`
// reason dropped, since SQLite's text isn't portable.
const errorOf = (error: unknown): string => {
  let code: string;
  let fields: [string, Value][];
  if (error instanceof HostScriptError) {
    code = error.code;
    fields = error.data.kind === 'map' ? error.data.entries() : [];
  } else if (error instanceof ScriptError) {
    code = error.code;
    fields = error.fields.map(([k, v]) => [k, v]);
  } else {
    throw error;
  }
  if (
    code === 'sql' &&
    fields.some(([k, v]) => k === 'reason' && v.kind === 'text')
  ) {
    fields = fields.filter(([k]) => k !== 'reason');
  }
  return map([['code', text(code)], ...fields]).toString();
};

export type SqliteKitFailure = {
  actual: string;
  expected: string;
  step: number;
};

/** Runs one sequence on a fresh database; the first step that differs, if any. */
export const runSqliteKitSequence = (
  open: () => SqliteKitSubject,
  sequence: SqliteKitSequence,
): SqliteKitFailure | undefined => {
  const subject = open();
  try {
    const named = (s: string) => s.replaceAll('{store}', subject.storeTable);
    for (const sql of sequence.setup) {
      subject.exec(sql);
    }
    const sqlite = sqliteCapability(
      subject.sqlite,
      costs(['query', 'change', 'begin', 'commit', 'rollback']),
      0,
    ) as CapabilityDef<unknown>;
    const store = storeCapability(
      subject.store,
      costs(['get', 'set', 'delete', 'keys', 'increment', 'swap']),
    ) as CapabilityDef<unknown>;
    const grants = new Map(
      Object.entries(sequence.grants).map(([name, spec]) => {
        const binding =
          spec.capability === 'store'
            ? spec.binding
            : {
                ...spec.binding,
                ...(spec.binding.tables
                  ? { tables: spec.binding.tables.map(named) }
                  : {}),
              };
        const def = spec.capability === 'store' ? store : sqlite;
        return [
          name,
          { name, binding, def, coordinator: def.coordinator!(binding) },
        ] as const;
      }),
    );
    const coordinators = new Set([...grants.values()].map(g => g.coordinator));
    if (coordinators.size !== 1) {
      throw new Error('Every kit Grant shares the database’s coordinator');
    }
    const coordinator: SegmentCoordinator = [...coordinators][0]!;
    const enrolled = new Map<string, SegmentGrant<unknown>[]>();

    for (const [i, step] of sequence.steps.entries()) {
      const grant = grants.get(step.grant ?? 'db');
      if (!grant) {
        throw new Error(`No Grant ${step.grant}`);
      }
      const own = { grantName: grant.name, binding: grant.binding };
      let expected: string;
      let actual: string;
      if (step.hook) {
        const grantsOf =
          step.hook === 'begin' ? [own] : (enrolled.get(step.in) ?? [own]);
        if (step.hook === 'begin') {
          enrolled.set(step.in, grantsOf);
        } else {
          enrolled.delete(step.in);
        }
        expected = `status ${step.status ?? 'ok'}`;
        actual = `status ${coordinator[step.hook](contextOf(step.in, grantsOf)).status}`;
      } else {
        const op = grant.def.operations.get(step.do!) as
          ImmediateOp<unknown> | undefined;
        if (!op) {
          throw new Error(`Unknown Operation ${step.do}`);
        }
        const segmentGrants = enrolled.get(step.in);
        if (
          SEGMENT_BOUND.has(step.do!) &&
          segmentGrants &&
          !segmentGrants.some(g => g.grantName === grant.name)
        ) {
          segmentGrants.push(own);
        }
        const args =
          grant.def === store
            ? step.args
              ? listOf(readDisplay(step.args))
              : []
            : step.do === 'query' || step.do === 'change'
              ? [
                  text(named(step.sql!)),
                  readDisplay(step.params ?? '[]'),
                  ...(step.max === undefined
                    ? []
                    : [readDisplay(String(step.max))]),
                ]
              : [];
        expected =
          step.error !== undefined
            ? `error ${readDisplay(step.error).toString()}`
            : `gives ${readDisplay(step.gives ?? 'nothing').toString()}`;
        try {
          standardChecks(op)?.arguments?.(args, grant.binding, [
            ['capability', text(grant.name)],
            ['operation', text(step.do!)],
          ]);
          const value = op.do(
            callOf(step.in, grant.name, grant.binding, i + 1),
            ...args,
          );
          actual = `gives ${(value ?? nothing).toString()}`;
        } catch (error) {
          actual = `error ${errorOf(error)}`;
        }
      }
      if (actual !== expected) {
        return { step: i + 1, expected, actual };
      }
    }
    return undefined;
  } finally {
    subject.close();
  }
};
