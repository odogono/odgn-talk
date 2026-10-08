// A Store backend over the Web Storage `Storage` interface, such as
// `localStorage`, for browser Hosts that run the Core on the main thread
// (ADR 0050). Each Store is one item holding its contents as `:store save`
// writes them, so a commit is one `setItem` for each Store it wrote. If one
// fails, the commit puts back the items it already set; if that fails too,
// whether the commit happened is unknown. Reservations live in this process,
// so two tabs sharing one Store are unsupported (ADR 0062).
import type { Value } from '../values';
import {
  decodeContents,
  encodeContents,
  Stores,
  StoreStateUnknownError,
  type StoreBackend,
  type StoreQuotas,
} from './engine';
import { compareText } from '../text';

/** The part of the Web Storage `Storage` interface a Store uses. */
export type WebStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

/** Each Store under the item `prefix` + its name. */
export const webStorageBackend = (
  storage: WebStorage,
  prefix = 'northtalk.store.',
): StoreBackend => {
  const contents = new Map<string, Map<string, Value>>();
  return {
    load: store => {
      const item = storage.getItem(prefix + store);
      const entries = new Map(item === null ? [] : decodeContents(item));
      contents.set(store, entries);
      return entries;
    },
    save: changes => {
      const written: [string, Map<string, Value>, string | null][] = [];
      try {
        for (const [store, values] of changes) {
          const next = new Map(contents.get(store));
          for (const [key, value] of values) {
            if (value.kind === 'nothing') {
              next.delete(key);
            } else {
              next.set(key, value);
            }
          }
          const item = prefix + store;
          const old = storage.getItem(item);
          if (next.size) {
            storage.setItem(
              item,
              encodeContents([...next].sort(([a], [b]) => compareText(a, b))),
            );
          } else {
            storage.removeItem(item);
          }
          written.push([store, next, old]);
        }
      } catch (error) {
        try {
          for (const [store, , old] of written.reverse()) {
            if (old === null) {
              storage.removeItem(prefix + store);
            } else {
              storage.setItem(prefix + store, old);
            }
          }
        } catch {
          throw new StoreStateUnknownError((error as Error).message);
        }
        throw error;
      }
      for (const [store, next] of written) {
        contents.set(store, next);
      }
    },
  };
};

/** Stores kept in Web Storage, under items named `prefix` + the Store's name. */
export const webStorageStores = (
  storage: WebStorage,
  quotas: StoreQuotas,
  prefix?: string,
): Stores => new Stores(webStorageBackend(storage, prefix), quotas);
