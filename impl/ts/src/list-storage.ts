import type { Value } from './values';

type Buffer = { end: number; items: Value[]; start: number };

/**
 * A fixed window over append-only storage. Only unpublished slots may be
 * written. Extending an older endpoint forks the buffer; geometric spare
 * capacity makes unbranched List construction linear, including prepends.
 */
export class ListStorage {
  readonly #buffer: Buffer;
  readonly #end: number;
  readonly #start: number;

  private constructor(buffer: Buffer, start: number, end: number) {
    this.#buffer = buffer;
    this.#start = start;
    this.#end = end;
  }

  static copy(items: readonly Value[]): ListStorage {
    return new ListStorage(
      { items: [...items], start: 0, end: items.length },
      0,
      items.length,
    );
  }

  get length(): number {
    return this.#end - this.#start;
  }

  index(i: number): Value | undefined {
    return i >= 0 && i < this.length
      ? this.#buffer.items[this.#start + i]
      : undefined;
  }

  extend(
    count: number,
    item: (i: number) => Value,
    prepend: boolean,
  ): ListStorage {
    if (count === 0) {
      return this;
    }
    const buffer = this.#buffer;
    if (prepend && this.#start === buffer.start && count <= this.#start) {
      const start = this.#start - count;
      for (let i = 0; i < count; i++) {
        buffer.items[start + i] = item(i);
      }
      buffer.start = start;
      return new ListStorage(buffer, start, this.#end);
    }
    if (
      !prepend &&
      this.#end === buffer.end &&
      count <= buffer.items.length - this.#end
    ) {
      const end = this.#end + count;
      for (let i = 0; i < count; i++) {
        buffer.items[this.#end + i] = item(i);
      }
      buffer.end = end;
      return new ListStorage(buffer, this.#start, end);
    }
    const length = this.length + count;
    const items = new Array<Value>(Math.max(8, 2 * length));
    const start = Math.floor((items.length - length) / 2);
    const oldStart = start + (prepend ? count : 0);
    const newStart = start + (prepend ? 0 : this.length);
    for (let i = 0; i < this.length; i++) {
      items[oldStart + i] = this.index(i)!;
    }
    for (let i = 0; i < count; i++) {
      items[newStart + i] = item(i);
    }
    return new ListStorage(
      { items, start, end: start + length },
      start,
      start + length,
    );
  }
}
