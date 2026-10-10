import type { Value } from './values';
import { at, put, remove, total, type Tree } from './persistent-tree';

const chunkSize = 32;

/** A persistent sequence of small chunks. Growth and point edits copy only a
 * chunk and its AVL path, including when extending a retained older List. */
export class ListStorage {
  readonly #root: Tree<number, readonly Value[]> | undefined;
  readonly #first: number;
  readonly #last: number;

  private constructor(
    root: Tree<number, readonly Value[]> | undefined,
    first: number,
    last: number,
  ) {
    this.#root = root;
    this.#first = first;
    this.#last = last;
  }

  static copy(items: readonly Value[]): ListStorage {
    let root: Tree<number, readonly Value[]> | undefined;
    let key = 0;
    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);
      root = put(root, key++, chunk, chunk.length);
    }
    return new ListStorage(root, 0, key - 1);
  }

  get length(): number {
    return total(this.#root);
  }

  index(i: number): Value | undefined {
    const found = at(this.#root, i);
    return found?.node.value[found.offset];
  }

  set(i: number, value: Value | undefined): ListStorage {
    const found = at(this.#root, i)!;
    const chunk = [...found.node.value];
    if (value === undefined) {
      chunk.splice(found.offset, 1);
    } else {
      chunk[found.offset] = value;
    }
    const root = chunk.length
      ? put(this.#root, found.node.key, chunk, chunk.length)
      : remove(this.#root, found.node.key);
    // Endpoint keys need not be contiguous after deletion.
    const first = at(root, 0)?.node.key ?? 0;
    const last = at(root, total(root) - 1)?.node.key ?? -1;
    return new ListStorage(root, first, last);
  }

  extend(
    count: number,
    item: (i: number) => Value,
    prepend: boolean,
  ): ListStorage {
    if (count === 0) {
      return this;
    }
    let root = this.#root;
    let first = this.#first;
    let last = this.#last;
    let done = 0;
    const edge = at(root, prepend ? 0 : total(root) - 1)?.node;
    if (edge && edge.span < chunkSize) {
      const n = Math.min(count, chunkSize - edge.span);
      const added = Array.from({ length: n }, (_, i) =>
        item(prepend ? count - n + i : i),
      );
      const chunk = prepend
        ? [...added, ...edge.value]
        : [...edge.value, ...added];
      root = put(root, edge.key, chunk, chunk.length);
      done = n;
    }
    while (done < count) {
      const n = Math.min(chunkSize, count - done);
      const chunk = Array.from({ length: n }, (_, i) =>
        item(prepend ? count - done - n + i : done + i),
      );
      const key = !root ? 0 : prepend ? first - 1 : last + 1;
      root = put(root, key, chunk, n);
      if (prepend || total(root) === n) {
        first = key;
      }
      if (!prepend || total(root) === n) {
        last = key;
      }
      done += n;
    }
    return new ListStorage(root, first, last);
  }
}
