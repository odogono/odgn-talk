// A minimal in-memory IndexedDB for storage.ts tests: named stores with
// in-line keyPaths (including [string, number] composite keys), key ranges,
// and transactions that stage their writes and discard them on abort, so a
// failed request mid-save provably stores nothing. Only the operations
// storage.ts uses are implemented.
type Key = string | number | Key[];

const encode = (key: Key): string => JSON.stringify(key);

const compareKeys = (a: Key, b: Key): number => {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const order = compareKeys(a[i]!, b[i]!);
      if (order !== 0) {
        return order;
      }
    }
    return a.length - b.length;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  const [left, right] = [String(a), String(b)];
  return left < right ? -1 : left > right ? 1 : 0;
};

class FakeKeyRange {
  constructor(
    readonly lower: Key,
    readonly upper: Key,
  ) {}

  static bound(lower: Key, upper: Key): FakeKeyRange {
    return new FakeKeyRange(lower, upper);
  }

  includes(key: Key): boolean {
    return (
      compareKeys(key, this.lower) >= 0 && compareKeys(key, this.upper) <= 0
    );
  }
}

type Handler = ((event?: unknown) => void) | null;

class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;

  succeed(result: T): void {
    this.result = result;
    this.onsuccess?.();
  }

  fail(error: Error): void {
    this.error = error;
    this.onerror?.();
  }
}

type StoreData = Map<string, { key: Key; value: unknown }>;
type Staged = { deleted: true; key: Key } | { key: Key; value: unknown };

export type FakeIdb = {
  factory: IDBFactory;
  /** Readwrite transactions begun, so a test can assert one per save. */
  stats: { readwriteTransactions: number };
};

export type FakeIdbOptions = {
  /** Makes opening the database fail, as in some private modes. */
  failOpen?: Error;
  /** Makes `put` to a store fail, e.g. with a QuotaExceededError. */
  failPuts?: (storeName: string, value: unknown) => Error | undefined;
};

/** Installs the fake's IDBKeyRange global and returns its factory. */
export const createFakeIdb = (options: FakeIdbOptions = {}): FakeIdb => {
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = FakeKeyRange;
  const stats = { readwriteTransactions: 0 };
  const stores = new Map<string, StoreData>();
  const keyPaths = new Map<string, string | string[]>();

  const keyOf = (storeName: string, value: Record<string, unknown>): Key => {
    const keyPath = keyPaths.get(storeName)!;
    return Array.isArray(keyPath)
      ? keyPath.map(part => value[part] as Key)
      : (value[keyPath] as Key);
  };

  class FakeTransaction {
    error: Error | null = null;
    oncomplete: Handler = null;
    onabort: Handler = null;
    onerror: Handler = null;
    #staged = new Map<string, Map<string, Staged>>();
    #queue: (() => void)[] = [];
    #processing = false;
    #finished = false;
    #commitTimer: ReturnType<typeof setTimeout> | undefined;

    enqueue(run: () => void): void {
      if (this.#commitTimer !== undefined) {
        clearTimeout(this.#commitTimer);
        this.#commitTimer = undefined;
      }
      this.#queue.push(run);
      if (!this.#processing) {
        this.#processing = true;
        queueMicrotask(() => this.#drain());
      }
    }

    #drain(): void {
      while (this.#queue.length && !this.#finished) {
        this.#queue.shift()!();
      }
      this.#processing = false;
      if (!this.#finished && !this.#queue.length) {
        // Like a real transaction: commit once no requests are pending,
        // after microtask continuations have had their chance to add more.
        this.#commitTimer = setTimeout(() => this.#commit(), 0);
      }
    }

    #commit(): void {
      if (this.#finished) {
        return;
      }
      this.#finished = true;
      for (const [storeName, staged] of this.#staged) {
        const data = stores.get(storeName)!;
        for (const [encoded, entry] of staged) {
          if ('deleted' in entry) {
            data.delete(encoded);
          } else {
            data.set(encoded, { key: entry.key, value: entry.value });
          }
        }
      }
      this.oncomplete?.();
    }

    abort(): void {
      if (this.#finished) {
        return;
      }
      this.#finished = true;
      if (this.#commitTimer !== undefined) {
        clearTimeout(this.#commitTimer);
      }
      this.#staged.clear();
      this.#queue = [];
      this.onabort?.();
    }

    fail(error: Error): void {
      this.error = error;
      this.onerror?.();
      this.abort();
    }

    read(storeName: string, key: Key): unknown {
      const staged = this.#staged.get(storeName)?.get(encode(key));
      if (staged) {
        return 'deleted' in staged ? undefined : structuredClone(staged.value);
      }
      const found = stores.get(storeName)?.get(encode(key));
      return found && structuredClone(found.value);
    }

    readAll(
      storeName: string,
      range?: FakeKeyRange,
    ): { key: Key; value: unknown }[] {
      const merged = new Map(stores.get(storeName));
      for (const [encoded, entry] of this.#staged.get(storeName) ?? []) {
        if ('deleted' in entry) {
          merged.delete(encoded);
        } else {
          merged.set(encoded, { key: entry.key, value: entry.value });
        }
      }
      return [...merged.values()]
        .filter(entry => !range || range.includes(entry.key))
        .sort((a, b) => compareKeys(a.key, b.key))
        .map(entry => ({
          key: entry.key,
          value: structuredClone(entry.value),
        }));
    }

    stage(storeName: string, entry: Staged): void {
      let staged = this.#staged.get(storeName);
      if (!staged) {
        staged = new Map();
        this.#staged.set(storeName, staged);
      }
      staged.set(encode(entry.key), structuredClone(entry));
    }

    objectStore(storeName: string) {
      const tx = this;
      const make = <T>(run: () => T): FakeRequest<T> => {
        const request = new FakeRequest<T>();
        tx.enqueue(() => {
          try {
            request.succeed(run());
          } catch (error) {
            request.fail(error as Error);
            tx.fail(error as Error);
          }
        });
        return request;
      };
      const putRun = (value: Record<string, unknown>) => (): Key => {
        const failure = options.failPuts?.(storeName, value);
        if (failure) {
          throw failure;
        }
        const key = keyOf(storeName, value);
        tx.stage(storeName, { key, value });
        return key;
      };
      return {
        get: (key: Key) => make(() => tx.read(storeName, key)),
        getAll: (range?: FakeKeyRange) =>
          make(() => tx.readAll(storeName, range).map(entry => entry.value)),
        getAllKeys: (range?: FakeKeyRange) =>
          make(() => tx.readAll(storeName, range).map(entry => entry.key)),
        put: (value: Record<string, unknown>) => make(putRun(value)),
        delete: (key: Key) =>
          make(() => {
            tx.stage(storeName, { deleted: true, key });
            return undefined;
          }),
      };
    }
  }

  const db = {
    createObjectStore: (
      name: string,
      storeOptions: { keyPath: string | string[] },
    ) => {
      stores.set(name, new Map());
      keyPaths.set(name, storeOptions.keyPath);
      return {};
    },
    transaction: (_names: string[], mode: string) => {
      if (mode === 'readwrite') {
        stats.readwriteTransactions++;
      }
      return new FakeTransaction();
    },
    close: () => {},
    onversionchange: null as Handler,
  };

  const factory = {
    open: () => {
      const request = new FakeRequest<typeof db>();
      queueMicrotask(() => {
        if (options.failOpen) {
          request.fail(options.failOpen);
          return;
        }
        request.result = db;
        if (!stores.size) {
          request.onupgradeneeded?.();
        }
        request.succeed(db);
      });
      return request;
    },
  };

  return { factory: factory as unknown as IDBFactory, stats };
};
