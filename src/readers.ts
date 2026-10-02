// Both readers build values through the same Host constructors. JSON is read
// directly so decimals, duplicate keys and integer-like key order survive.
import { fromBase64 } from './base64';
import { parseInstant } from './dates';
import { invalidValue } from './errors';
import { assertScalarText } from './unicode';
import {
  Value,
  bool,
  bytesOf,
  civilDate,
  instant,
  dec,
  hiddenCodePoint,
  listValues,
  map,
  nothing,
  quantity,
  range,
  text,
} from './values';

class Reader {
  i = 0;
  constructor(readonly source: string) {
    assertScalarText(source);
  }
  fail(what: string): never {
    return invalidValue(`${what} at column ${this.i + 1}`);
  }
  peek(s: string): boolean {
    return this.source.startsWith(s, this.i);
  }
  eat(s: string): void {
    if (!this.peek(s)) {
      this.fail(`Expected ${s}`);
    }
    this.i += s.length;
  }
  match(re: RegExp): string | undefined {
    re.lastIndex = this.i;
    const result = re.exec(this.source);
    if (!result || result.index !== this.i) {
      return undefined;
    }
    this.i += result[0].length;
    return result[0];
  }
  done(): void {
    if (this.i !== this.source.length) {
      this.fail('Unexpected trailing input');
    }
  }
}

/** Finds the Host Object a reader names by its kind and id, or none. */
export type ObjectResolver = (
  kind: string,
  id: string,
) => { readonly value: Value } | Value | null | undefined;
const resolved = (r: ReturnType<ObjectResolver>): Value | undefined =>
  r ? (Value.isValue(r) ? r : r.value) : undefined;

class DisplayReader extends Reader {
  constructor(
    source: string,
    private readonly resolve?: ObjectResolver,
  ) {
    super(source);
  }
  value(): Value {
    type Frame =
      | { kind: 'list'; values: Value[] }
      | { key: string; kind: 'map'; pairs: [string, Value][] };
    const frames: Frame[] = [];
    let value: Value | undefined;
    for (;;) {
      if (!value) {
        if (this.peek('[')) {
          this.eat('[');
          if (this.peek(']')) {
            this.eat(']');
            value = listValues([]);
          } else {
            frames.push({ kind: 'list', values: [] });
            continue;
          }
        } else if (this.peek('{')) {
          this.eat('{');
          if (this.peek('}')) {
            this.eat('}');
            value = map([]);
          } else {
            frames.push({ kind: 'map', pairs: [], key: this.mapKey() });
            continue;
          }
        } else {
          value = this.atom();
        }
      }
      const parent = frames.at(-1);
      if (!parent) {
        return value;
      }
      if (parent.kind === 'list') {
        parent.values.push(value);
      } else {
        parent.pairs.push([parent.key, value]);
      }
      value = undefined;
      if (this.peek(', ')) {
        this.eat(', ');
        if (parent.kind === 'map') {
          parent.key = this.mapKey();
        }
      } else {
        this.eat(parent.kind === 'list' ? ']' : '}');
        frames.pop();
        value =
          parent.kind === 'list'
            ? listValues(parent.values)
            : map(parent.pairs);
      }
    }
  }
  private mapKey(): string {
    const key = this.peek('"')
      ? this.textPieces()
      : this.match(/[A-Z_a-z]\w*/y);
    if (key === undefined) {
      this.fail('Expected map key');
    }
    this.eat(': ');
    return key;
  }
  private atom(): Value {
    if (this.match(/nothing(?!\w)/y)) {
      return nothing;
    }
    const b = this.match(/(?:true|false)(?!\w)/y);
    if (b) {
      return bool(b === 'true');
    }
    if (
      this.peek('"') ||
      /^(?:quote|newline|tab|fromCodePoint\()/.test(this.source.slice(this.i))
    ) {
      return text(this.textPieces());
    }
    if (this.peek('<<')) {
      return this.bytes();
    }
    if (this.peek('<object ')) {
      // `<object kind "id">`, which only a resolver can make a value.
      this.eat('<object ');
      const kind =
        this.match(/[A-Z_a-z][\w-]*/y) ?? this.fail('Expected a kind');
      this.eat(' ');
      const id = this.textPieces();
      this.eat('>');
      return (
        resolved(this.resolve?.(kind, id)) ??
        this.fail(`No Host Object ${kind} ${id}`)
      );
    }
    const date = this.match(
      /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z?)?(?![\w.:-])/y,
    );
    if (date !== undefined) {
      return dateValue(date, this.fail.bind(this));
    }
    const start = this.i;
    const from = this.rangeEnd();
    if (from === undefined) {
      return this.fail('Unsupported or malformed display value');
    }
    if (!this.peek('..')) {
      return from;
    }
    this.eat('..');
    const to = this.rangeEnd();
    if (to === undefined) {
      return this.fail('Expected the end of a range');
    }
    const value = range(from, to);
    if (value.toString() !== this.source.slice(start, this.i)) {
      this.fail('Expected a canonical display range');
    }
    return value;
  }
  // Bytes: `<<`, each byte as `0x` and two uppercase hex digits, `>>`.
  private bytes(): Value {
    this.eat('<<');
    const out: number[] = [];
    while (!this.peek('>>')) {
      if (out.length) {
        this.eat(', ');
      }
      const byte = this.match(/0x[\dA-F]{2}/y);
      if (byte === undefined) {
        this.fail('Expected a byte');
      }
      out.push(Number.parseInt(byte.slice(2), 16));
    }
    this.eat('>>');
    return bytesOf(Uint8Array.from(out));
  }
  // A number, or a Quantity: a number, one space and a Unit in normal form.
  private rangeEnd(): Value | undefined {
    const start = this.i;
    const number = this.match(/-?\d+(?:\.\d+)?/y);
    if (number === undefined) {
      return undefined;
    }
    const value = dec(number);
    if (value.toString() !== number) {
      this.fail('Expected canonical display number');
    }
    const unit = this.match(/ [\d*/A-Z^a-z]+(?!=)/y);
    if (unit === undefined) {
      return value;
    }
    const q = quantity(value, unit.slice(1));
    if (q.toString() !== this.source.slice(start, this.i)) {
      this.fail('Expected a Quantity in normal form');
    }
    return q;
  }
  textPieces(): string {
    const pieces: string[] = [];
    for (;;) {
      if (this.peek('"')) {
        this.i++;
        const end = this.source.indexOf('"', this.i);
        if (end < 0) {
          this.fail('Unterminated display text');
        }
        const run = this.source.slice(this.i, end);
        if (Array.from(run).some(ch => hiddenCodePoint(ch.codePointAt(0)!))) {
          this.fail('Hidden scalar in quoted display text');
        }
        pieces.push(run);
        this.i = end + 1;
      } else {
        const constant = this.match(/(?:quote|newline|tab)(?![\w(])/y);
        if (constant) {
          pieces.push(
            constant === 'quote' ? '"' : constant === 'newline' ? '\n' : '\t',
          );
        } else {
          const cp = this.match(/fromCodePoint\(\d+\)/y);
          if (!cp) {
            this.fail('Expected text piece');
          }
          const n = Number(cp.slice(14, -1));
          if (
            !Number.isInteger(n) ||
            n < 0 ||
            n > 0x10_ff_ff ||
            (n >= 0xd8_00 && n <= 0xdf_ff)
          ) {
            this.fail('Not a Unicode scalar');
          }
          pieces.push(String.fromCodePoint(n));
        }
      }
      if (!this.peek(' & ')) {
        break;
      }
      this.eat(' & ');
    }
    return pieces.join('');
  }
}

export const readDisplay = (
  source: string,
  resolve?: ObjectResolver,
): Value => {
  const reader = new DisplayReader(source, resolve);
  const value = reader.value();
  reader.done();
  return value;
};

/** Display-form source text preserves its exact scalars for code identity. */
export const readDisplayText = (source: string): string => {
  const reader = new DisplayReader(source);
  const text = reader.textPieces();
  reader.done();
  return text;
};

// Preserve raw JSON structure until tag processing: arrays for objects avoid
// JS's numeric-key ordering and make duplicate keys detectable before NFC.
type Json = null | boolean | string | JsonNumber | Json[] | JsonObject;
class JsonNumber {
  readonly kind = 'number';
  constructor(readonly source: string) {}
}
class JsonObject {
  readonly kind = 'object';
  constructor(readonly pairs: [string, Json][]) {}
}
class JsonReader extends Reader {
  whitespace(): void {
    this.match(/[\u0009\u000a\u000d ]*/y);
  }
  string(): string {
    this.eat('"');
    let result = '';
    while (this.i < this.source.length) {
      const ch = this.source[this.i++]!;
      if (ch === '"') {
        assertScalarText(result);
        return result;
      }
      if (ch.charCodeAt(0) < 32) {
        this.fail('Control in JSON string');
      }
      if (ch !== '\\') {
        result += ch;
        continue;
      }
      const escape = this.source[this.i++]!;
      const simple: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      };
      if (Object.hasOwn(simple, escape)) {
        result += simple[escape];
      } else if (escape === 'u') {
        const digits = this.match(/[\dA-Fa-f]{4}/y);
        if (!digits) {
          this.fail('Invalid JSON Unicode escape');
        }
        result += String.fromCharCode(Number.parseInt(digits, 16));
      } else {
        this.fail('Invalid JSON escape');
      }
    }
    return this.fail('Unterminated JSON string');
  }
  value(): Json {
    type Frame =
      | { kind: 'list'; values: Json[] }
      | {
          key: string;
          keys: Set<string>;
          kind: 'map';
          pairs: [string, Json][];
        };
    const frames: Frame[] = [];
    let value: Json = null,
      ready = false;
    const mapKey = (frame: Extract<Frame, { kind: 'map' }>) => {
      this.whitespace();
      frame.key = this.string();
      if (frame.keys.has(frame.key)) {
        this.fail('Duplicate JSON key');
      }
      frame.keys.add(frame.key);
      this.whitespace();
      this.eat(':');
    };
    for (;;) {
      if (!ready) {
        this.whitespace();
        if (this.peek('[')) {
          this.eat('[');
          this.whitespace();
          if (this.peek(']')) {
            this.eat(']');
            value = [];
          } else {
            frames.push({ kind: 'list', values: [] });
            continue;
          }
        } else if (this.peek('{')) {
          this.eat('{');
          this.whitespace();
          if (this.peek('}')) {
            this.eat('}');
            value = new JsonObject([]);
          } else {
            const frame: Extract<Frame, { kind: 'map' }> = {
              kind: 'map',
              pairs: [],
              keys: new Set(),
              key: '',
            };
            mapKey(frame);
            frames.push(frame);
            continue;
          }
        } else {
          value = this.atom();
        }
      }
      const parent = frames.at(-1);
      if (!parent) {
        return value;
      }
      if (parent.kind === 'list') {
        parent.values.push(value);
      } else {
        parent.pairs.push([parent.key, value]);
      }
      this.whitespace();
      if (this.peek(',')) {
        this.eat(',');
        ready = false;
        if (parent.kind === 'map') {
          mapKey(parent);
        }
      } else {
        this.eat(parent.kind === 'list' ? ']' : '}');
        frames.pop();
        value =
          parent.kind === 'list' ? parent.values : new JsonObject(parent.pairs);
        ready = true;
      }
    }
  }
  private atom(): Json {
    if (this.peek('"')) {
      return this.string();
    }
    if (this.match(/null/y)) {
      return null;
    }
    const b = this.match(/true|false/y);
    if (b) {
      return b === 'true';
    }
    const n = this.match(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?/y);
    if (n) {
      return new JsonNumber(n);
    }
    return this.fail('Expected JSON value');
  }
}

const fromJson = (value: Json, resolve?: ObjectResolver): Value => {
  let result = nothing;
  const tasks: (() => void)[] = [];
  const enqueue = (node: Json, assign: (v: Value) => void): void => {
    tasks.push(() => {
      if (node === null) {
        assign(nothing);
        return;
      }
      if (typeof node === 'boolean') {
        assign(bool(node));
        return;
      }
      if (typeof node === 'string') {
        assign(text(node));
        return;
      }
      if (Array.isArray(node)) {
        const values: Value[] = new Array(node.length);
        tasks.push(() => assign(listValues(values)));
        for (let i = node.length - 1; i >= 0; i--) {
          enqueue(node[i]!, v => {
            values[i] = v;
          });
        }
        return;
      }
      if (node.kind === 'number') {
        const v = dec(node.source);
        if (
          v.toString() !== node.source ||
          node.source.includes('.') ||
          abs(v.asDecimal()!.toBigInt()) >= 2n ** 53n
        ) {
          invalidValue('Non-canonical Value Encoding number');
        }
        assign(v);
        return;
      }
      let pairs = node.pairs;
      if (pairs.some(([key]) => key.startsWith('$'))) {
        if (pairs.length !== 1) {
          invalidValue('Value Encoding tag must be the only key');
        }
        const [tag, data] = pairs[0]!;
        if (tag === '$dec' && typeof data === 'string') {
          const v = dec(data);
          if (v.toString() !== data) {
            invalidValue('Non-canonical $dec');
          }
          assign(v);
          return;
        }
        if (
          tag === '$quantity' &&
          Array.isArray(data) &&
          data.length === 2 &&
          typeof data[0] === 'string' &&
          typeof data[1] === 'string'
        ) {
          const n = dec(data[0]);
          const unit = data[1];
          if (n.toString() !== data[0]) {
            invalidValue('Non-canonical $quantity number');
          }
          const q = quantity(n, unit);
          if (q.kind !== 'quantity' || encodedUnit(q) !== unit) {
            invalidValue('A $quantity Unit not in normal form');
          }
          assign(q);
          return;
        }
        if (
          (tag === '$instant' || tag === '$date') &&
          typeof data === 'string'
        ) {
          const v = dateValue(data, invalidValue);
          if (v.kind !== (tag === '$instant' ? 'instant' : 'civil date')) {
            invalidValue(`Malformed ${tag}`);
          }
          assign(v);
          return;
        }
        if (tag === '$bytes' && typeof data === 'string') {
          const b = fromBase64(data);
          if (!b) {
            invalidValue('A $bytes that is not canonical padded Base64');
          }
          assign(bytesOf(b));
          return;
        }
        if (
          tag === '$object' &&
          Array.isArray(data) &&
          data.length === 2 &&
          typeof data[0] === 'string' &&
          typeof data[1] === 'string'
        ) {
          const v = resolved(resolve?.(data[0], data[1]));
          if (!v) {
            invalidValue(`No Host Object ${data[0]} ${data[1]}`);
          }
          assign(v);
          return;
        }
        if (tag === '$range' && Array.isArray(data) && data.length === 2) {
          const ends: Value[] = [nothing, nothing];
          tasks.push(() => assign(range(ends[0]!, ends[1]!)));
          enqueue(data[1]!, v => {
            ends[1] = v;
          });
          enqueue(data[0]!, v => {
            ends[0] = v;
          });
          return;
        }
        if (tag !== '$map' || !Array.isArray(data)) {
          invalidValue(`Unsupported or malformed Value Encoding tag ${tag}`);
        }
        pairs = data.map(pair => {
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            typeof pair[0] !== 'string'
          ) {
            invalidValue('Malformed $map entry');
          }
          return [pair[0], pair[1]!];
        });
      }
      const entries: [string, Value][] = pairs.map(([key]) => [key, nothing]);
      tasks.push(() => assign(map(entries)));
      for (let i = pairs.length - 1; i >= 0; i--) {
        enqueue(pairs[i]![1], v => {
          entries[i]![1] = v;
        });
      }
    });
  };
  enqueue(value, v => {
    result = v;
  });
  while (tasks.length) {
    tasks.pop()!();
  }
  return result;
};

// An Instant or a Civil Date in its text form, which is the only form read.
const dateValue = (s: string, fail: (what: string) => never): Value => {
  const v = s.endsWith('Z') ? instant(parseInstant(s)) : civilDate(s);
  if (v.toString() !== s) {
    fail('Expected a date in its display form');
  }
  return v;
};
const encodedUnit = (q: Value) => q.asQuantity()!.unit;
const abs = (n: bigint) => (n < 0n ? -n : n);
export const decodeValue = (
  source: string,
  resolve?: ObjectResolver,
): Value => {
  const reader = new JsonReader(source);
  const value = reader.value();
  reader.whitespace();
  reader.done();
  return fromJson(value, resolve);
};
