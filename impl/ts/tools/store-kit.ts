// Drives any `StoreImpl` through the store test kit, `corpus/store-kit/`:
// language-neutral Operation and lifecycle sequences with the results and
// errors chapter 7 and ADR 0062 require of every Store. A fresh Store, with
// the sequence's quotas, runs each sequence.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Call, SegmentContext } from '../src/capabilities';
import { ScriptError } from '../src/errors';
import type { Group } from '../src/group';
import { readDisplay } from '../src/readers';
import type { StoreImpl } from '../src/store-capability';
import type { StoreQuotas } from '../src/store/engine';
import type { WebStorage } from '../src/store/web-storage';
import { bool, map, nothing, text, type Value } from '../src/values';

export const storeKitRoot = resolve(
  import.meta.dir,
  '../../../corpus/store-kit',
);

type Step = {
  /** Display-form list of the call's arguments, as supplied. */
  args?: string;
  do: string;
  /** The error map the call fails with: its code and fields, no message. */
  error?: string;
  /** The display form of what an Operation gives. */
  gives?: string;
  /** The Segment the call or lifecycle hook belongs to. */
  in: string;
  /** A lifecycle hook's status. */
  status?: string;
  /** The Grant binding: the Store's name. */
  store?: string;
};
type Sequence = { name: string; quotas?: StoreQuotas; steps: Step[] };
type KitFile = { quotas: StoreQuotas; sequence: Sequence[] };

export type StoreKitSequence = {
  file: string;
  name: string;
  quotas: StoreQuotas;
  steps: Step[];
};

/** Every sequence in the kit, file by file. */
export const storeKitSequences = (root = storeKitRoot): StoreKitSequence[] =>
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
        quotas: s.quotas ?? kit.quotas,
        steps: s.steps,
      }));
    });

const OPERATIONS = new Set([
  'get',
  'set',
  'delete',
  'keys',
  'increment',
  'swap',
]);
const LIFECYCLE = new Set(['begin', 'commit', 'rollback']);

// One Group for every step: Segment ids are unique within it.
const group = {} as Group;
// Only the binding, Group and Segment are a Store's to read.
const callOf = (step: Step, n: number): Call<string> =>
  ({
    id: `kit.c${n}`,
    binding: step.store ?? 'default',
    segmentId: step.in,
    grantName: 'store',
    scriptName: 'kit',
    runId: step.in,
    automatic: false,
    now: 0n,
    group,
    signal: new AbortController().signal,
    answer: () => {},
    charge: () => {},
    fail: () => {},
  }) satisfies Call<string>;
const contextOf = (step: Step): SegmentContext<string> => ({
  binding: step.store ?? 'default',
  segmentId: step.in,
  grantName: 'store',
  scriptName: 'kit',
  runId: step.in,
  now: 0n,
  group,
});

const operate = (
  store: StoreImpl,
  call: Call<string>,
  op: string,
  args: Value[],
): Value => {
  const key = args[0]?.asText() ?? '';
  switch (op) {
    case 'get':
      return store.get(call, key, ...(args.length > 1 ? [args[1]] : []));
    case 'set':
      store.set(call, key, args[1]!);
      return nothing;
    case 'delete':
      store.delete(call, key);
      return nothing;
    case 'keys':
      return store.keys(call, ...(args.length ? [args[0]!.asText()] : []));
    case 'increment':
      return store.increment(call, key, ...(args.length > 1 ? [args[1]] : []));
    case 'swap':
      return bool(store.swap(call, key, args[1]!, args[2]!));
  }
  throw new Error(`Unknown store Operation ${op}`);
};

/** What one step did, in the kit's terms, for comparing with what it expects. */
const outcome = (store: StoreImpl, step: Step, n: number): Step => {
  if (LIFECYCLE.has(step.do)) {
    const phase = step.do as 'begin' | 'commit' | 'rollback';
    return { ...step, status: store[phase](contextOf(step)).status };
  }
  if (!OPERATIONS.has(step.do)) {
    throw new Error(`Unknown step ${step.do}`);
  }
  const args = step.args ? readDisplay(step.args) : undefined;
  const values = args
    ? Array.from({ length: args.length }, (_, i) => args.index(i + 1))
    : [];
  try {
    const { error: _, ...rest } = step;
    return {
      ...rest,
      gives: operate(store, callOf(step, n), step.do, values).toString(),
    };
  } catch (error) {
    if (!(error instanceof ScriptError)) {
      throw error;
    }
    const { gives: _, ...rest } = step;
    return {
      ...rest,
      error: map([
        ['code', text(error.code)],
        ...(error.data.kind === 'map' ? error.data.entries() : []),
      ]).toString(),
    };
  }
};

export type StoreKitFailure = {
  actual: string;
  expected: string;
  step: number;
};

const expectation = (step: Step): string =>
  LIFECYCLE.has(step.do)
    ? `status ${step.status ?? 'ok'}`
    : step.error !== undefined
      ? `error ${readDisplay(step.error).toString()}`
      : `gives ${readDisplay(step.gives ?? 'nothing').toString()}`;

/** Runs one sequence on a fresh Store; the first step that differs, if any. */
export const runStoreKitSequence = (
  make: (quotas: StoreQuotas) => StoreImpl,
  sequence: StoreKitSequence,
): StoreKitFailure | undefined => {
  const store = make(sequence.quotas);
  for (const [i, step] of sequence.steps.entries()) {
    const expected = expectation(step);
    const actual = expectation(outcome(store, step, i + 1));
    if (actual !== expected) {
      return { step: i + 1, expected, actual };
    }
  }
  return undefined;
};

/** A Web Storage `Storage` over a Map, as a browser's `localStorage` behaves. */
export const fakeStorage = (): WebStorage & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: key => {
      items.delete(key);
    },
  };
};
