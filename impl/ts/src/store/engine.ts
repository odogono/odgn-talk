// A `store` implementation over any backend that keeps committed contents
// (chapter 7, `store`; ADR 0050, ADR 0062). The engine holds each Store's
// committed contents in memory, each live Segment's pending writes to every
// Store it writes, and the reservations and quota checks between them; the
// backend only loads a Store once and applies each commit's changes, to all
// of a Segment's Stores, at once. The engine is the Segment Coordinator of
// every Store it keeps (ADR 0069).
import type { Call, EffectResult, SegmentContext } from '../capabilities';
import { sizeOf } from '../costs';
import { quoteJSON, encodeValue } from '../encoding';
import { invalidValue } from '../errors';
import { decodeValueMembers } from '../readers';
import { add, hostScriptError, type StoreImpl } from '../store-capability';
import { compareText } from '../text';
import { dec, listValues, nothing, text, type Value } from '../values';

/** A Store's limits, each counted by logical size (chapter 8). */
export type StoreQuotas = {
  /** The most keys it holds. */
  keys: number;
  /** The most its keys and values may total. */
  size: number;
  /** The largest value. */
  value: number;
};

/** The Session Store's quotas (chapter 12, The Session Store). */
export const sessionQuotas: StoreQuotas = Object.freeze({
  size: 1_048_576,
  keys: 1000,
  value: 65_536,
});

/** Where Stores' committed contents are kept, by Store name. */
export type StoreBackend = {
  /** Every key and value of a Store, read once, when the Store is first used. */
  load(store: string): Iterable<readonly [string, Value]>;
  /**
   * Applies one commit's changes to every Store it wrote at once: by Store
   * name, each key's new value, with Nothing deleting it. Throws, leaving
   * every Store unchanged, if it can't; throws `StoreStateUnknownError` if
   * it can't tell whether some Stores changed.
   */
  save(changes: ReadonlyMap<string, ReadonlyMap<string, Value>>): void;
};

/** A backend's commit that may have changed some of its Stores. */
export class StoreStateUnknownError extends Error {
  override name = 'StoreStateUnknownError';
}

// What one Segment has written to one key: a `set`, `delete` or writing
// `swap` replaces the key's value and reserves it, and increments add to
// it, in call order.
type Pending = { deltas: Value[]; set?: Value };
// A live Segment's pending writes, by Store name and key.
type Segment = Map<string, Map<string, Pending>>;
type Contents = { entries: Map<string, Value>; size: number };

const absent = (v: Value | undefined): v is undefined =>
  v === undefined || v.kind === 'nothing';
const entrySize = (key: string, value: Value) =>
  sizeOf(text(key)) + sizeOf(value);
const amount = (v: Value) => v.kind === 'number' || v.kind === 'quantity';

/** A Host Object anywhere in a value: its Object Kind. */
const objectKind = (value: Value): string | undefined => {
  const work = [value];
  while (work.length) {
    const v = work.pop()!;
    if (v.kind === 'object') {
      return v.asObjectRef()!.kind;
    }
    if (v.kind === 'list') {
      for (let i = 1; i <= v.length; i++) {
        work.push(v.index(i));
      }
    } else if (v.kind === 'map') {
      work.push(...v.entries().map(([, item]) => item));
    } else if (v.kind === 'range') {
      const { from, to } = v.asRange()!;
      work.push(from, to);
    }
  }
  return undefined;
};

/** Why a Host command on a Store's contents was refused. */
export class StoreContentsError extends Error {
  override name = 'StoreContentsError';
}

/** A Store's contents as one JSON object, in key order, with no white space. */
export const encodeContents = (
  entries: readonly (readonly [string, Value])[],
): string =>
  `{${entries.map(([key, value]) => `${quoteJSON(key)}:${encodeValue(value)}`).join(',')}}`;

/** Contents written by `encodeContents`. Throws on anything else. */
export const decodeContents = (source: string): [string, Value][] =>
  decodeValueMembers(source);

/** Every Store a Host keeps through one backend, as one `StoreImpl`. */
export class Stores implements StoreImpl {
  private readonly contents = new Map<string, Contents>();
  // Live Segments by Group identity and Segment id, since Segment ids are
  // unique only within a Group.
  private readonly segments = new Map<string, Segment>();
  private readonly groups = new WeakMap<object, number>();
  private nextGroup = 0;

  constructor(
    private readonly backend: StoreBackend,
    readonly quotas: StoreQuotas,
  ) {}

  // ------------------------------------------------------------ lifecycle

  // Every binding enrolled later in the Segment, through any Grant, joins
  // it with no hook; its first write adds that Store.
  begin(context: SegmentContext<string>): EffectResult {
    const store = storeName(context.binding);
    this.committed(store);
    this.segments.set(this.segmentKey(context), new Map([[store, new Map()]]));
    return { status: 'ok' };
  }

  commit(context: SegmentContext<string>): EffectResult {
    const segment = this.segments.get(this.segmentKey(context));
    this.segments.delete(this.segmentKey(context));
    const changes = new Map<string, Map<string, Value>>();
    try {
      for (const [store, keys] of segment ?? []) {
        const contents = this.committed(store);
        const values = new Map<string, Value>();
        for (const [key, pending] of keys) {
          values.set(
            key,
            applied(pending.set ?? contents.entries.get(key), pending.deltas) ??
              nothing,
          );
        }
        if (values.size) {
          changes.set(store, values);
        }
      }
      if (changes.size) {
        this.backend.save(changes);
      }
    } catch (error) {
      if (error instanceof StoreStateUnknownError) {
        // Read each Store again from the backend when it is next used.
        for (const store of changes.keys()) {
          this.contents.delete(store);
        }
        return { status: 'unknown', detail: error.message };
      }
      return { status: 'failed', detail: (error as Error).message };
    }
    for (const [store, values] of changes) {
      const contents = this.committed(store);
      for (const [key, value] of values) {
        this.put(contents, key, absent(value) ? undefined : value);
      }
    }
    return { status: 'ok' };
  }

  rollback(context: SegmentContext<string>): EffectResult {
    this.segments.delete(this.segmentKey(context));
    return { status: 'ok' };
  }

  // ------------------------------------------------------------ Operations

  get(call: Call<string>, key: string, fallback?: Value): Value {
    return this.seen(call, key) ?? fallback ?? nothing;
  }

  keys(call: Call<string>, prefix = ''): Value {
    const store = storeName(call.binding);
    const own = this.own(call, store);
    const keys = new Set(this.committed(store).entries.keys());
    for (const key of own?.keys() ?? []) {
      keys.add(key);
    }
    return listValues(
      [...keys]
        .filter(key => key.startsWith(prefix) && this.seen(call, key))
        .sort(compareText)
        .map(key => text(key)),
    );
  }

  set(call: Call<string>, key: string, value: Value): void {
    this.storable(value);
    this.write(call, key, value);
  }

  delete(call: Call<string>, key: string): void {
    this.write(call, key, nothing);
  }

  swap(
    call: Call<string>,
    key: string,
    expected: Value,
    replacement: Value,
  ): boolean {
    this.storable(replacement);
    const store = storeName(call.binding);
    this.unreserved(call, store, key, true);
    if (!(this.seen(call, key) ?? nothing).equals(expected)) {
      return false;
    }
    this.write(call, key, replacement);
    return true;
  }

  increment(call: Call<string>, key: string, by?: Value): Value {
    const delta = absent(by) ? ONE : by;
    const store = storeName(call.binding);
    this.unreserved(call, store, key, false);
    const seen = this.seen(call, key);
    if (seen && !amount(seen)) {
      throw hostScriptError('wrong kind', [
        ['expected', text('number')],
        ['got', text(seen.kind)],
        ['value', seen],
      ]);
    }
    const result = seen ? add(seen, delta) : delta;
    const own = this.own(call, store)?.get(key);
    if (own?.set === undefined) {
      // The committed value with every other live Segment's pending
      // increments, then this one's, so no commit order meets an error.
      let projected = this.committed(store).entries.get(key);
      for (const keys of this.others(call, store)) {
        projected = applied(projected, keys.get(key)?.deltas ?? []);
      }
      applied(projected, [...(own?.deltas ?? []), delta]);
    }
    const next: Pending = { ...own, deltas: [...(own?.deltas ?? []), delta] };
    this.grows(call, store, key, next, seen ? undefined : delta);
    this.segment(call, store).set(key, next);
    return result;
  }

  // ------------------------------------------------------------ Host commands

  /** A Store's committed contents, in key order. */
  entries(store: string): [string, Value][] {
    return [...this.committed(store).entries].sort(([a], [b]) =>
      compareText(a, b),
    );
  }

  /** Replaces a Store's contents, between Pumps. */
  replace(store: string, entries: readonly (readonly [string, Value])[]): void {
    if ([...this.segments.values()].some(s => s.has(store))) {
      throw new StoreContentsError('A Segment is writing to the Store');
    }
    const next: Contents = { entries: new Map(), size: 0 };
    for (const [key, value] of entries) {
      if (key === '' || next.entries.has(key)) {
        throw new StoreContentsError(
          'Store keys must be distinct, nonempty text',
        );
      }
      if (objectKind(value) !== undefined || value.kind === 'function') {
        throw new StoreContentsError('A Store keeps only data values');
      }
      if (sizeOf(value) > this.quotas.value) {
        throw new StoreContentsError('A value is past the Store’s value limit');
      }
      if (!absent(value)) {
        this.put(next, key, value);
      }
    }
    if (next.entries.size > this.quotas.keys || next.size > this.quotas.size) {
      throw new StoreContentsError('The contents are past the Store’s quotas');
    }
    this.backend.save(new Map([[store, this.changesTo(store, next)]]));
    this.contents.set(store, next);
  }

  /** Empties a Store, between Pumps. */
  clear(store: string): void {
    this.replace(store, []);
  }

  // ------------------------------------------------------------ internals

  private committed(store: string): Contents {
    let contents = this.contents.get(store);
    if (!contents) {
      contents = { entries: new Map(), size: 0 };
      for (const [key, value] of this.backend.load(store)) {
        this.put(contents, key, value);
      }
      this.contents.set(store, contents);
    }
    return contents;
  }

  private put(contents: Contents, key: string, value: Value | undefined) {
    const old = contents.entries.get(key);
    if (old) {
      contents.size -= entrySize(key, old);
      contents.entries.delete(key);
    }
    if (value) {
      contents.size += entrySize(key, value);
      contents.entries.set(key, value);
    }
  }

  private changesTo(store: string, next: Contents): Map<string, Value> {
    const changes = new Map<string, Value>();
    for (const key of this.committed(store).entries.keys()) {
      if (!next.entries.has(key)) {
        changes.set(key, nothing);
      }
    }
    for (const [key, value] of next.entries) {
      changes.set(key, value);
    }
    return changes;
  }

  // The calling Segment's pending writes to this Store, if any.
  private segmentKey(at: { group: object; segmentId: string }): string {
    let group = this.groups.get(at.group);
    if (group === undefined) {
      group = this.nextGroup++;
      this.groups.set(at.group, group);
    }
    return `${group} ${at.segmentId}`;
  }

  private own(
    call: Call<string>,
    store: string,
  ): Map<string, Pending> | undefined {
    return this.segments.get(this.segmentKey(call))?.get(store);
  }

  // Every other live Segment's pending writes to this Store.
  private others(call: Call<string>, store: string): Map<string, Pending>[] {
    const mine = this.segmentKey(call);
    return [...this.segments]
      .filter(([id, segment]) => id !== mine && segment.has(store))
      .map(([, segment]) => segment.get(store)!);
  }

  private segment(call: Call<string>, store: string): Map<string, Pending> {
    const segment = this.segments.get(this.segmentKey(call));
    if (!segment) {
      // The Core begins the participant before its first Segment-bound call.
      throw new Error('A Store write outside its Segment');
    }
    let keys = segment.get(store);
    if (!keys) {
      this.committed(store);
      keys = new Map();
      segment.set(store, keys);
    }
    return keys;
  }

  // The value the calling Segment sees, or undefined for a missing key.
  private seen(call: Call<string>, key: string): Value | undefined {
    const store = storeName(call.binding);
    const committed = this.committed(store).entries.get(key);
    const pending = this.own(call, store)?.get(key);
    return pending
      ? applied(pending.set ?? committed, pending.deltas)
      : committed;
  }

  private storable(value: Value) {
    const kind = objectKind(value);
    if (kind !== undefined) {
      throw hostScriptError("can't store", [['kind', text(kind)]]);
    }
  }

  // `store busy` if another live Segment has reserved the key: any of its
  // writes reserves it against a replacing write, and only a replacing
  // write reserves it against an increment.
  private unreserved(
    call: Call<string>,
    store: string,
    key: string,
    replacing: boolean,
  ) {
    for (const keys of this.others(call, store)) {
      const pending = keys.get(key);
      if (pending && (replacing || pending.set !== undefined)) {
        throw hostScriptError('store busy', [['key', text(key)]]);
      }
    }
  }

  private write(call: Call<string>, key: string, value: Value) {
    const store = storeName(call.binding);
    this.unreserved(call, store, key, true);
    const next: Pending = { set: value, deltas: [] };
    this.grows(call, store, key, next, absent(value) ? undefined : value);
    this.segment(call, store).set(key, next);
  }

  // `store full` if the Store, with every live Segment's pending growth and
  // this write, would pass a quota. A Segment's writes commit at once, so
  // each counts by its net growth; one that shrinks the Store counts as
  // none, since it may roll back. So no set of commits, in any order, can
  // pass a quota.
  private grows(
    call: Call<string>,
    store: string,
    key: string,
    next: Pending,
    written: Value | undefined,
  ) {
    if (written && sizeOf(written) > this.quotas.value) {
      throw hostScriptError('store full', [['limit', text('value')]]);
    }
    const contents = this.committed(store);
    const mine = new Map(this.own(call, store));
    mine.set(key, next);
    let keys = contents.entries.size;
    let size = contents.size;
    for (const pending of [...this.others(call, store), mine]) {
      let grownKeys = 0;
      let grownSize = 0;
      for (const [k, p] of pending) {
        const old = contents.entries.get(k);
        // Increments never change a value's size.
        const base = p.set === undefined ? old : p.set;
        const value = absent(base) ? p.deltas[0] : base;
        grownKeys += (value ? 1 : 0) - (old ? 1 : 0);
        grownSize +=
          (value ? entrySize(k, value) : 0) - (old ? entrySize(k, old) : 0);
      }
      keys += Math.max(0, grownKeys);
      size += Math.max(0, grownSize);
    }
    if (keys > this.quotas.keys) {
      throw hostScriptError('store full', [['limit', text('keys')]]);
    }
    if (size > this.quotas.size) {
      throw hostScriptError('store full', [['limit', text('size')]]);
    }
  }
}

const ONE = dec('1');

// A value with increments added in call order; a missing key gives the
// first increment itself.
const applied = (
  value: Value | undefined,
  deltas: readonly Value[],
): Value | undefined => {
  let current = absent(value) ? undefined : value;
  for (const delta of deltas) {
    current = current === undefined ? delta : add(current, delta);
  }
  return current;
};

const storeName = (binding: unknown): string =>
  typeof binding === 'string'
    ? binding
    : invalidValue('A Store’s binding is its name, as text');
