import type { Value } from './values';
import { at, put, remove, total, type Tree } from './persistent-tree';

const chunkSize = 32;

/** Replacement keeps the tree's shape, spans and endpoint keys unchanged. */
const replaceItem = (
  root: Tree<number, readonly Value[]>,
  i: number,
  value: Value,
): Tree<number, readonly Value[]> => {
  const offset = total(root.left);
  let left = root.left;
  let right = root.right;
  let chunk = root.value;
  if (i < offset) {
    left = replaceItem(left!, i, value);
  } else if (i >= offset + root.span) {
    right = replaceItem(right!, i - offset - root.span, value);
  } else {
    const copy = chunk.slice();
    copy[i - offset] = value;
    chunk = copy;
  }
  return {
    key: root.key,
    value: chunk,
    span: root.span,
    left,
    right,
    height: root.height,
    total: root.total,
  };
};

/** One item added to the first or last chunk, copying only the edge path:
 * the shape and keys stay put. Undefined when that chunk is full. */
const growEdge = (
  root: Tree<number, readonly Value[]>,
  item: Value,
  prepend: boolean,
): Tree<number, readonly Value[]> | undefined => {
  const next = prepend ? root.left : root.right;
  let left = root.left;
  let right = root.right;
  let chunk = root.value;
  if (next) {
    const grown = growEdge(next, item, prepend);
    if (!grown) {
      return undefined;
    }
    if (prepend) {
      left = grown;
    } else {
      right = grown;
    }
  } else if (chunk.length < chunkSize) {
    chunk = prepend ? [item, ...chunk] : [...chunk, item];
  } else {
    return undefined;
  }
  return {
    key: root.key,
    value: chunk,
    span: chunk.length,
    left,
    right,
    height: root.height,
    total: root.total + 1,
  };
};

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
    if (value !== undefined) {
      return new ListStorage(
        replaceItem(this.#root!, i, value),
        this.#first,
        this.#last,
      );
    }
    const found = at(this.#root, i)!;
    const chunk = [...found.node.value];
    chunk.splice(found.offset, 1);
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
    const grown =
      count === 1 && this.#root
        ? growEdge(this.#root, item(0), prepend)
        : undefined;
    if (grown) {
      return new ListStorage(grown, this.#first, this.#last);
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
