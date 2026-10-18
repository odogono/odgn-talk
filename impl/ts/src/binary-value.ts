// ADR 0110's canonical items. This module owns no transport, guest or Session.
import { invalidValue } from './errors';
import { checkSource } from './checker';
import { patternSource } from './canonical';
import { viewSource } from './view';
import { normalizeNFC } from './unicode';
import { decodeUtf8 } from './operations';
import {
  Value,
  bool,
  bytes,
  civilDate,
  dec,
  instant,
  listValues,
  map,
  nothing,
  num,
  patternValue,
  quantity,
  range,
  text,
} from './values';

export type BinaryItem = {
  data?: string | bigint | Uint8Array | BinaryItem[];
  tag: number;
};
export type BinaryValueOptions = {
  coreErrors?: boolean;
  decodeFunction?(payload: readonly Value[]): Value;
  encodeFunction?(value: Value): readonly Value[];
  functionMetadata?: boolean;
  object?(kind: string, id: string): Value | undefined;
};
const coreErrors = new WeakSet<Value>();
const max = 2n ** 64n;
const encoder = new TextEncoder();
export const binaryFailure = (): never =>
  invalidValue('Malformed canonical binary item');
export const children = (item: BinaryItem): BinaryItem[] => {
  if (!Array.isArray(item.data)) {
    return binaryFailure();
  }
  return item.data;
};
export const itemText = (item: BinaryItem): string => {
  if ((item.tag !== 5 && item.tag !== 18) || typeof item.data !== 'string') {
    return binaryFailure();
  }
  return item.data;
};
export const integerItem = (n: bigint): BinaryItem => {
  if (n < -max || n >= max) {
    return binaryFailure();
  }
  return { tag: n < 0n ? 16 : 3, data: n < 0n ? -n : n };
};
export const itemInteger = (item: BinaryItem): bigint => {
  if ((item.tag !== 3 && item.tag !== 16) || typeof item.data !== 'bigint') {
    return binaryFailure();
  }
  return item.tag === 16 ? -item.data : item.data;
};
const numberItem = (s: string): BinaryItem => {
  if (dec(s).toString() !== s) {
    return binaryFailure();
  }
  if (!s.includes('.')) {
    const n = BigInt(s);
    if (n >= -max && n < max) {
      return integerItem(n);
    }
  }
  return { tag: 4, data: s };
};

/** A writer shared by standalone Values and positional Message Layer records. */
export class BinaryWriter {
  readonly output: number[] = [];
  uint(n: bigint) {
    if (n < 0n || n > max) {
      binaryFailure();
    }
    do {
      const part = Number(n & 127n);
      n >>= 7n;
      this.output.push(part | (n ? 128 : 0));
    } while (n);
  }
  item(root: BinaryItem) {
    const stack = [root];
    while (stack.length) {
      const item = stack.pop()!;
      const { tag, data } = item;
      this.output.push(tag);
      if (tag === 0 || tag === 1 || tag === 2) {
        continue;
      }
      if (tag === 3 || tag === 11 || tag === 16) {
        this.uint(data as bigint);
      } else if ([4, 5, 8, 12, 13, 18].includes(tag)) {
        const b =
          typeof data === 'string'
            ? encoder.encode(data)
            : (data as Uint8Array);
        this.uint(BigInt(b.length));
        for (const byte of b) {
          this.output.push(byte);
        }
      } else {
        const xs = children(item);
        if ([6, 7, 17, 19].includes(tag)) {
          this.uint(
            BigInt(tag === 7 || tag === 17 ? xs.length / 2 : xs.length),
          );
        }
        for (let i = xs.length - 1; i >= 0; i--) {
          stack.push(xs[i]!);
        }
      }
    }
  }
  buffer(): ArrayBuffer {
    return Uint8Array.from(this.output).buffer;
  }
}

/** Bounded by remaining bytes; containers use heap tasks, including deep Values. */
export class BinaryReader {
  at = 0;
  constructor(readonly data: Uint8Array) {}
  byte(): number {
    if (this.at >= this.data.length) {
      return binaryFailure();
    }
    return this.data[this.at++]!;
  }
  uint(negative = false): bigint {
    let n = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const b = this.byte();
      n |= BigInt(b & 127) << shift;
      if (b < 128) {
        if ((shift && b === 0) || (n >= max && !(negative && n === max))) {
          return binaryFailure();
        }
        return n;
      }
    }
    return binaryFailure();
  }
  count(): number {
    const n = this.uint();
    if (n > BigInt(this.data.length - this.at)) {
      return binaryFailure();
    }
    return Number(n);
  }
  item(): BinaryItem {
    let root!: BinaryItem;
    const tasks: ((item: BinaryItem) => void)[] = [
      v => {
        root = v;
      },
    ];
    while (tasks.length) {
      const assign = tasks.pop()!;
      const tag = this.byte();
      const item: BinaryItem = { tag };
      assign(item);
      if (tag <= 2) {
        continue;
      }
      if (tag === 3 || tag === 11 || tag === 16) {
        item.data = this.uint(tag === 16);
        if (tag === 16 && item.data === 0n) {
          binaryFailure();
        }
      } else if ([4, 5, 8, 12, 13, 18].includes(tag)) {
        const n = this.count();
        const data = this.data.subarray(this.at, this.at + n);
        this.at += n;
        if (tag === 8) {
          item.data = data.slice();
        } else {
          const s = decodeUtf8(data) ?? binaryFailure();
          if (tag !== 18 && normalizeNFC(s) !== s) {
            binaryFailure();
          }
          item.data = s;
          if (tag === 4 && numberItem(s).tag !== 4) {
            binaryFailure();
          }
        }
      } else {
        let n: number;
        if ([6, 7, 17, 19].includes(tag)) {
          n = this.count();
          if (tag === 19 && n !== 6 && n !== 7) {
            binaryFailure();
          }
          if (tag === 7 || tag === 17) {
            n *= 2;
          }
        } else if (tag === 9 || tag === 10 || tag === 14) {
          n = 2;
        } else if (tag === 15) {
          n = 3;
        } else {
          return binaryFailure();
        }
        if (n > this.data.length - this.at) {
          binaryFailure();
        }
        const xs: BinaryItem[] = new Array(n);
        item.data = xs;
        for (let i = n - 1; i >= 0; i--) {
          tasks.push(v => {
            xs[i] = v;
          });
        }
      }
    }
    return root;
  }
  done() {
    if (this.at !== this.data.length) {
      binaryFailure();
    }
  }
}

const functionValid = (xs: readonly Value[], o: BinaryValueOptions) => {
  if (
    ![3, 6, 7].includes(xs.length) ||
    (xs.length > 3 && !o.functionMetadata) ||
    xs.slice(0, 3).some(v => v.kind !== 'text')
  ) {
    binaryFailure();
  }
  if (xs.length >= 6) {
    if (xs[3]!.kind !== 'nothing' && xs[3]!.kind !== 'text') {
      binaryFailure();
    }
    const ns = xs
      .slice(4, 6)
      .map(v =>
        v.kind === 'number' && /^\d+$/.test(v.toString())
          ? BigInt(v.toString())
          : -1n,
      );
    if (ns[0]! < 0n || ns[0]! > ns[1]! || ns[1]! >= max) {
      binaryFailure();
    }
  }
  if (
    xs.length === 7 &&
    (xs[6]!.kind !== 'bytes' || xs[6]!.bytesView()!.length !== 32)
  ) {
    binaryFailure();
  }
};

export const valueItem = (
  value: Value,
  o: BinaryValueOptions = {},
): BinaryItem => {
  let root!: BinaryItem;
  const tasks: (() => void)[] = [];
  const visit = (v: Value, assign: (item: BinaryItem) => void) =>
    tasks.push(() => {
      let item: BinaryItem;
      let xs: readonly Value[] | undefined;
      switch (v.kind) {
        case 'nothing':
          item = { tag: 0 };
          break;
        case 'boolean':
          item = { tag: v.asBool() ? 2 : 1 };
          break;
        case 'number':
          item = numberItem(v.toString());
          break;
        case 'text':
          item = { tag: 5, data: v.asText()! };
          break;
        case 'bytes':
          item = { tag: 8, data: v.bytesView()! };
          break;
        case 'instant': {
          const n = v.asInstant()!;
          item = { tag: 11, data: (n << 1n) ^ (n >> 63n) };
          break;
        }
        case 'civil date':
          item = { tag: 12, data: v.toString() };
          break;
        case 'pattern':
          item = { tag: 13, data: v.patternSource()! };
          break;
        case 'list':
          item = { tag: 6 };
          xs = Array.from({ length: v.length }, (_, i) => v.index(i + 1));
          break;
        case 'map':
          item = { tag: coreErrors.has(v) && o.coreErrors ? 17 : 7 };
          xs = v.entries().flatMap(([k, v]) => [text(k), v]);
          break;
        case 'range': {
          const r = v.asRange()!;
          item = { tag: 10 };
          xs = [r.from, r.to];
          break;
        }
        case 'quantity': {
          const q = v.asQuantity()!;
          item = { tag: 9 };
          xs = [dec(q.number.toString()), text(q.unit)];
          break;
        }
        case 'object': {
          const ref = v.asObjectRef()!;
          item = { tag: 14 };
          xs = [text(ref.kind), text(ref.id)];
          break;
        }
        case 'function': {
          xs = o.encodeFunction?.(v);
          if (!xs) {
            return binaryFailure();
          }
          functionValid(xs, o);
          item = { tag: xs.length === 3 ? 15 : 19 };
          break;
        }
        default:
          return binaryFailure();
      }
      assign(item);
      if (xs) {
        const items: BinaryItem[] = new Array(xs.length);
        item.data = items;
        for (let i = xs.length - 1; i >= 0; i--) {
          visit(xs[i]!, v => {
            items[i] = v;
          });
        }
      }
    });
  visit(value, v => {
    root = v;
  });
  while (tasks.length) {
    tasks.pop()!();
  }
  return root;
};

export const itemValue = (
  root: BinaryItem,
  o: BinaryValueOptions = {},
): Value => {
  let result!: Value;
  const tasks: (() => void)[] = [];
  const visit = (item: BinaryItem, assign: (v: Value) => void) =>
    tasks.push(() => {
      const { tag, data } = item;
      if (tag === 0) {
        return assign(nothing);
      }
      if (tag === 1 || tag === 2) {
        return assign(bool(tag === 2));
      }
      if (tag === 3 || tag === 16) {
        return assign(num(itemInteger(item)));
      }
      if (tag === 4) {
        return assign(dec(data as string));
      }
      if (tag === 5) {
        return assign(text(data as string));
      }
      if (tag === 8) {
        return assign(bytes(data as Uint8Array));
      }
      if (tag === 11) {
        const n = data as bigint;
        return assign(instant((n >> 1n) ^ -(n & 1n)));
      }
      if (tag === 12) {
        const v = civilDate(data as string);
        if (v.toString() !== data) {
          binaryFailure();
        }
        return assign(v);
      }
      if (tag === 13) {
        const source = data as string;
        const checked = checkSource(`constant binary = ${source}`);
        if (!checked.ok || !checked.tree) {
          return binaryFailure();
        }
        const decl = viewSource(checked.tree.root)[0];
        if (
          decl?.k !== 'constant' ||
          decl.value.k !== 'pattern' ||
          patternSource(decl.value.pattern) !== source
        ) {
          return binaryFailure();
        }
        return assign(patternValue({ source, program: 0, data: null }));
      }
      const items = children(item);
      const xs: Value[] = new Array(items.length);
      tasks.push(() => {
        let v: Value;
        switch (tag) {
          case 6:
            v = listValues(xs);
            break;
          case 7:
          case 17: {
            const pairs: [string, Value][] = [];
            const seen = new Set<string>();
            for (let i = 0; i < xs.length; i += 2) {
              if (items[i]!.tag !== 5 || seen.has(xs[i]!.asText()!)) {
                return binaryFailure();
              }
              const k = xs[i]!.asText()!;
              seen.add(k);
              pairs.push([k, xs[i + 1]!]);
            }
            v = map(pairs);
            if (tag === 17) {
              if (!o.coreErrors || v.get('message').kind !== 'text') {
                return binaryFailure();
              }
              coreErrors.add(v);
            }
            break;
          }
          case 9: {
            if (xs[0]!.kind !== 'number' || xs[1]!.kind !== 'text') {
              return binaryFailure();
            }
            v = quantity(xs[0]!, xs[1]!.asText()!);
            if (
              v.kind !== 'quantity' ||
              v.asQuantity()!.unit !== xs[1]!.asText()
            ) {
              return binaryFailure();
            }
            break;
          }
          case 10:
            v = range(xs[0]!, xs[1]!);
            break;
          case 14: {
            if (xs.some(v => v.kind !== 'text')) {
              return binaryFailure();
            }
            v =
              o.object?.(xs[0]!.asText()!, xs[1]!.asText()!) ?? binaryFailure();
            break;
          }
          case 15:
          case 19:
            functionValid(xs, o);
            v = o.decodeFunction?.(xs) ?? binaryFailure();
            break;
          default:
            return binaryFailure();
        }
        assign(v);
      });
      for (let i = items.length - 1; i >= 0; i--) {
        visit(items[i]!, v => {
          xs[i] = v;
        });
      }
    });
  visit(root, v => {
    result = v;
  });
  while (tasks.length) {
    tasks.pop()!();
  }
  return result;
};

/** Dedicated transferable buffer, with no linear-memory or Node dependencies. */
export const encodeBinaryValue = (
  v: Value,
  o?: BinaryValueOptions,
): ArrayBuffer => {
  const writer = new BinaryWriter();
  writer.item(valueItem(v, o));
  return writer.buffer();
};
export const decodeBinaryValue = (
  buffer: ArrayBuffer,
  o?: BinaryValueOptions,
): Value => {
  const reader = new BinaryReader(new Uint8Array(buffer));
  const item = reader.item();
  reader.done();
  return itemValue(item, o);
};
