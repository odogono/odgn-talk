// A Store backend over the Web Storage `Storage` interface, such as
// `localStorage`, for browser Hosts that run the Core on the main thread
// (ADR 0050). Each Store is one item holding its contents as `:store save`
// writes them, so a commit is one `setItem`. Reservations live in this
// process, so two tabs sharing one Store are unsupported (ADR 0062).
import type { Value } from '../values';
import {
  decodeContents,
  encodeContents,
  Stores,
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
    save: (store, changes) => {
      const next = new Map(contents.get(store));
      for (const [key, value] of changes) {
        if (value.kind === 'nothing') {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      }
      if (next.size) {
        storage.setItem(
          prefix + store,
          encodeContents([...next].sort(([a], [b]) => compareText(a, b))),
        );
      } else {
        storage.removeItem(prefix + store);
      }
      contents.set(store, next);
    },
  };
};

/** Stores kept in Web Storage, under items named `prefix` + the Store's name. */
export const webStorageStores = (
  storage: WebStorage,
  quotas: StoreQuotas,
  prefix?: string,
): Stores => new Stores(webStorageBackend(storage, prefix), quotas);
