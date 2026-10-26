import type { Value } from './values';
import {
  balanced,
  find,
  put,
  remove,
  total,
  values,
  type Tree,
} from './persistent-tree';

type Pair = readonly [string, Value];

/** A literal's distinct, normalised keys in order, and their lookup tree. */
export type MapLayout = {
  readonly keys: readonly string[];
  readonly lookup: Tree<string, number> | undefined;
};

/** Lookup and insertion order have separate persistent trees. Replacing a key
 * keeps its ordinal; deleting and reinserting assigns a new final ordinal. */
export class MapStorage {
  readonly #keys: Tree<string, number> | undefined;
  readonly #order: Tree<number, Pair> | undefined;
  readonly #next: number;
  #pairs: readonly Pair[] | undefined;

  private constructor(
    keys: Tree<string, number> | undefined,
    order: Tree<number, Pair> | undefined,
    next: number,
  ) {
    this.#keys = keys;
    this.#order = order;
    this.#next = next;
  }

  static copy(pairs: readonly Pair[]): MapStorage {
    let result = new MapStorage(undefined, undefined, 0);
    for (const [key, value] of pairs) {
      result = result.set(key, value);
    }
    return result;
  }

  static layout(keys: readonly string[]): MapLayout {
    const sorted = keys
      .map((_, i) => i)
      .sort((a, b) => (keys[a]! < keys[b]! ? -1 : keys[a]! > keys[b]! ? 1 : 0));
    return {
      keys,
      lookup: balanced(
        keys.length,
        i => keys[sorted[i]!]!,
        i => sorted[i]!,
      ),
    };
  }

  /** One pass over a literal's values: the key tree is shared, and ordinals
   * are positions, so no `set` rebuilds a path. */
  static fromLayout(layout: MapLayout, items: readonly Value[]): MapStorage {
    const { keys } = layout;
    return new MapStorage(
      layout.lookup,
      balanced(
        keys.length,
        i => i,
        i => Object.freeze([keys[i]!, items[i]!] as const),
      ),
      keys.length,
    );
  }

  get length(): number {
    return total(this.#order);
  }
  has(key: string): boolean {
    return find(this.#keys, key) !== undefined;
  }
  get(key: string): Value | undefined {
    const found = find(this.#keys, key);
    return found ? find(this.#order, found.value)!.value[1] : undefined;
  }
  pairs(): readonly Pair[] {
    this.#pairs ??= [...values(this.#order)];
    return this.#pairs;
  }
  set(key: string, value: Value | undefined): MapStorage {
    const found = find(this.#keys, key);
    if (value === undefined) {
      return found
        ? new MapStorage(
            remove(this.#keys, key),
            remove(this.#order, found.value),
            this.#next,
          )
        : this;
    }
    const ordinal = found?.value ?? this.#next;
    const pair = [key, value] as const;
    return new MapStorage(
      found ? this.#keys : put(this.#keys, key, ordinal),
      put(this.#order, ordinal, pair),
      this.#next + (found ? 0 : 1),
    );
  }
}
