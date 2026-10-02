// Chapter 7's plain JSON mapping, distinct from the tagged Value Encoding.
import { invalidValue, ScriptError } from './errors';
import { errorMessages } from './generated/machine';
import { characterBoundaries, normalizeNFC } from './unicode';
import {
  bool,
  dec,
  listValues,
  map,
  nothing,
  num,
  requireValue,
  text,
  type Value,
} from './values';

type Frame =
  | { kind: 'list'; values: Value[] }
  | { key: string; keys: Set<string>; kind: 'map'; pairs: [string, Value][] };

class JsonReader {
  private i = 0;
  constructor(private readonly source: string) {}

  private fail(at = this.i): never {
    // Invalid raw surrogate input still needs a Character position. Replace
    // only for segmentation; it can never enter a decoded Value.
    const scalar = Array.from(this.source, c =>
      /^[\uD800-\uDFFF]$/.test(c) ? '\uFFFD' : c,
    ).join('');
    const offset = characterBoundaries(scalar).filter(i => i <= at).length;
    throw new ScriptError(
      "can't decode",
      errorMessages["can't decode"]
        .replace('{format}', text('json').toString())
        .replace('{offset}', String(offset)),
      map([
        ['format', text('json')],
        ['offset', num(offset)],
      ]),
    );
  }

  private space(): void {
    while (
      /[\t\n\r ]/.test(this.source[this.i] ?? '') &&
      this.i < this.source.length
    ) {
      this.i++;
    }
  }

  private eat(c: string): void {
    if (this.source[this.i] !== c) {
      this.fail();
    }
    this.i++;
  }

  private hex4(): number {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const c = this.source[this.i];
      if (c === undefined || !/[\dA-Fa-f]/.test(c)) {
        this.fail();
      }
      n = n * 16 + Number.parseInt(c, 16);
      this.i++;
    }
    return n;
  }

  private string(): string {
    this.eat('"');
    const parts: string[] = [];
    const escapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    while (this.i < this.source.length) {
      const start = this.i;
      const cp = this.source.codePointAt(this.i)!;
      const c = String.fromCodePoint(cp);
      if (c === '"') {
        this.i++;
        return normalizeNFC(parts.join(''));
      }
      if (cp < 32 || (cp >= 0xd8_00 && cp <= 0xdf_ff)) {
        this.fail();
      }
      this.i += c.length;
      if (c !== '\\') {
        parts.push(c);
        continue;
      }
      if (this.i === this.source.length) {
        this.fail();
      }
      const escape = this.source[this.i++]!;
      if (Object.hasOwn(escapes, escape)) {
        parts.push(escapes[escape]!);
        continue;
      }
      if (escape !== 'u') {
        this.fail(this.i - 1);
      }
      let u = this.hex4();
      if (u >= 0xdc_00 && u <= 0xdf_ff) {
        this.fail(start);
      }
      if (u >= 0xd8_00 && u <= 0xdb_ff) {
        const lowStart = this.i;
        if (this.source[this.i] !== '\\' || this.source[this.i + 1] !== 'u') {
          this.fail();
        }
        this.i += 2;
        const low = this.hex4();
        if (low < 0xdc_00 || low > 0xdf_ff) {
          this.fail(lowStart);
        }
        u = 0x1_00_00 + (u - 0xd8_00) * 1024 + low - 0xdc_00;
      }
      parts.push(String.fromCodePoint(u));
    }
    return this.fail();
  }

  private digits(): string {
    const start = this.i;
    while (this.i < this.source.length && /\d/.test(this.source[this.i]!)) {
      this.i++;
    }
    return this.source.slice(start, this.i);
  }

  private number(): Value {
    const start = this.i;
    let sign = '';
    if (this.source[this.i] === '-') {
      sign = '-';
      this.i++;
    }
    if (!/\d/.test(this.source[this.i] ?? '')) {
      this.fail();
    }
    let whole: string;
    if (this.source[this.i] === '0') {
      whole = '0';
      this.i++;
    } else {
      whole = this.digits();
    }
    let fraction = '';
    if (this.source[this.i] === '.') {
      this.i++;
      fraction = this.digits();
      if (!fraction) {
        this.fail();
      }
    }
    let exponent = '',
      negativeExponent = false;
    if (/[Ee]/.test(this.source[this.i] ?? '')) {
      this.i++;
      if (/[+-]/.test(this.source[this.i] ?? '')) {
        negativeExponent = this.source[this.i++] === '-';
      }
      exponent = this.digits();
      if (!exponent) {
        this.fail();
      }
    }
    const coefficient = whole + fraction;
    const significant = coefficient.replace(/^0+/, '');
    exponent = exponent.replace(/^0+/, '');
    if (exponent.length > 9) {
      if (!significant && !negativeExponent) {
        return num(0);
      }
      this.fail(start);
    }
    // Only the bounded exponent is a JS number; decimal digits never are.
    const q = (negativeExponent ? -1 : 1) * Number(exponent) - fraction.length;
    if (!significant && q >= 0) {
      return num(0);
    }
    if (significant.length > 34) {
      this.fail(start);
    }
    if (q >= 0) {
      if (significant.length + q > 34) {
        this.fail(start);
      }
      return dec(sign + significant + '0'.repeat(q));
    }
    if (-q > 6176) {
      this.fail(start);
    }
    const digits = coefficient.padStart(-q + 1, '0');
    return dec(sign + digits.slice(0, q) + '.' + digits.slice(q));
  }

  private atom(): Value {
    const c = this.source[this.i];
    if (c === '"') {
      return text(this.string());
    }
    if (c === '-' || /\d/.test(c ?? '')) {
      return this.number();
    }
    for (const [literal, value] of [
      ['true', bool(true)],
      ['false', bool(false)],
      ['null', nothing],
    ] as const) {
      if (c !== literal[0]) {
        continue;
      }
      for (const ch of literal) {
        this.eat(ch);
      }
      return value;
    }
    return this.fail();
  }

  read(): Value {
    const frames: Frame[] = [];
    let value: Value | undefined;
    const key = (frame: Extract<Frame, { kind: 'map' }>) => {
      this.space();
      const start = this.i;
      frame.key = this.string();
      if (frame.keys.has(frame.key)) {
        this.fail(start);
      }
      frame.keys.add(frame.key);
      this.space();
      this.eat(':');
    };
    for (;;) {
      if (!value) {
        this.space();
        const c = this.source[this.i];
        if (c === '[' || c === '{') {
          this.i++;
          this.space();
          const frame: Frame =
            c === '['
              ? { kind: 'list', values: [] }
              : { kind: 'map', pairs: [], keys: new Set(), key: '' };
          if (this.source[this.i] === (c === '[' ? ']' : '}')) {
            this.i++;
            value = c === '[' ? listValues([]) : map([]);
          } else {
            if (frame.kind === 'map') {
              key(frame);
            }
            frames.push(frame);
            continue;
          }
        } else {
          value = this.atom();
        }
      }
      const parent = frames.at(-1);
      this.space();
      if (!parent) {
        if (this.i !== this.source.length) {
          this.fail();
        }
        return value;
      }
      if (parent.kind === 'list') {
        parent.values.push(value);
      } else {
        parent.pairs.push([parent.key, value]);
      }
      if (this.source[this.i] === ',') {
        this.i++;
        if (parent.kind === 'map') {
          key(parent);
        }
        value = undefined;
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
}

/** Read exact decimal digits, NFC strings and insertion-ordered maps. */
export const decodeJson = (source: string): Value => {
  if (typeof source !== 'string') {
    invalidValue('JSON must be text');
  }
  return new JsonReader(source).read();
};

const quoteJson = (s: string): string => {
  const short: Record<string, string> = {
    '\b': 'b',
    '\t': 't',
    '\n': 'n',
    '\f': 'f',
    '\r': 'r',
  };
  return (
    '"' +
    s.replaceAll(/[\u0000-\u001f"\\]/g, c =>
      c === '"' || c === '\\'
        ? '\\' + c
        : Object.hasOwn(short, c)
          ? '\\' + short[c]
          : String.raw`\u00` + c.charCodeAt(0).toString(16).padStart(2, '0'),
    ) +
    '"'
  );
};

type Path = { key: string | number; parent: Path | undefined };
/** Compact JSON, with canonical numbers and chapter 7's string escapes. */
export const encodeJson = (value: Value): string => {
  requireValue(value);
  const pending: (string | { path: Path | undefined; value: Value })[] = [
    { value, path: undefined },
  ];
  const output: string[] = [];
  while (pending.length) {
    const next = pending.pop()!;
    if (typeof next === 'string') {
      output.push(next);
      continue;
    }
    const { value: v, path } = next;
    switch (v.kind) {
      case 'nothing':
        output.push('null');
        break;
      case 'boolean':
      case 'number':
        output.push(v.toString());
        break;
      case 'text':
        output.push(quoteJson(v.asText()!));
        break;
      case 'list':
        output.push('[');
        pending.push(']');
        for (let i = v.length; i >= 1; i--) {
          if (i < v.length) {
            pending.push(',');
          }
          pending.push({
            value: v.index(i),
            path: { key: i, parent: path },
          });
        }
        break;
      case 'map': {
        output.push('{');
        pending.push('}');
        const entries = v.entries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const [k, child] = entries[i]!;
          if (i < entries.length - 1) {
            pending.push(',');
          }
          pending.push(
            { value: child, path: { key: k, parent: path } },
            quoteJson(k) + ':',
          );
        }
        break;
      }
      default: {
        const keys: Value[] = [];
        for (let p = path; p; p = p.parent) {
          keys.push(typeof p.key === 'string' ? text(p.key) : num(p.key));
        }
        throw new ScriptError(
          'not encodable',
          errorMessages['not encodable'].replace(
            '{kind}',
            text(v.kind).toString(),
          ),
          map([
            ['kind', text(v.kind)],
            ['path', listValues(keys.reverse())],
          ]),
        );
      }
    }
  }
  return output.join('');
};
