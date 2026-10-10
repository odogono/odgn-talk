// Bytes built and matched by Binary Patterns (chapter 4, Binary Patterns;
// chapter 8, the `bytes-…` and `bin-…` instructions). Fields are read and
// written left to right, never searching or backtracking.
import { integerOf, isInteger } from './decimal';
import {
  byteOf,
  decodeUtf8,
  integerValue,
  outOfRange,
  wrongKind,
} from './operations';
import { bytesOf, decimalParts, text, type Value } from './values';

const utf8 = new TextEncoder();

/** A reader: Bytes and the position of the next byte to read. */
export type Reader = { at: number; bytes: Uint8Array; k: 'reader' };

/** An integer field's type, such as `uint16 little`. */
type IntField = {
  little: boolean;
  signed: boolean;
  size: number;
  type: string;
};
const intField = (field: string): IntField | undefined => {
  const m = /^(u?)int(8|16|32|64)(?: (big|little))?$/.exec(field);
  return m
    ? {
        type: field.split(' ')[0]!,
        signed: m[1] === '',
        size: Number(m[2]) / 8,
        little: m[3] === 'little',
      }
    : undefined;
};

const join = (a: Uint8Array, b: Uint8Array): Value => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return bytesOf(out);
};

// An integer that fits in `bits` bits, signed or not, or the field's raise.
const integerIn = (v: Value, field: string, bits: number, signed: boolean) => {
  if (v.kind !== 'number') {
    throw wrongKind('number', v);
  }
  const d = decimalParts(v.asDecimal()!);
  if (!isInteger(d)) {
    throw wrongKind('integer', v);
  }
  const n = integerOf(d);
  const span = 1n << BigInt(bits);
  const [lo, hi] = signed ? [-(span / 2n), span / 2n - 1n] : [0n, span - 1n];
  if (n < lo || n > hi) {
    throw outOfRange(field, v);
  }
  return n < 0n ? n + span : n;
};

/**
 * One field of a build (`bytes-field`): a number is one byte, text its UTF-8
 * and Bytes themselves, or `v as uint16` and the other integer types.
 */
export const buildField = (sofar: Value, v: Value, field: string): Value => {
  const head = sofar.bytesView()!;
  const int = intField(field);
  if (int) {
    let n = integerIn(v, int.type, int.size * 8, int.signed);
    const out = new Uint8Array(int.size);
    for (let i = int.size - 1; i >= 0; i--) {
      out[int.little ? int.size - 1 - i : i] = Number(n & 255n);
      n >>= 8n;
    }
    return join(head, out);
  }
  if (v.kind === 'text') {
    return join(head, utf8.encode(v.asText()!));
  }
  if (v.kind === 'bytes') {
    return join(head, v.bytesView()!);
  }
  if (v.kind !== 'number') {
    throw wrongKind('bytes', v);
  }
  return join(head, Uint8Array.of(byteOf(v, 'byte')));
};

/**
 * `v as n bytes` (`bytes-sized`): Bytes of exactly `n` bytes, or with `as
 * text`, text whose UTF-8 is exactly `n` bytes.
 */
export const buildSized = (
  sofar: Value,
  v: Value,
  size: Value,
  field: string,
): Value => {
  if (size.kind !== 'number') {
    throw wrongKind('number', size);
  }
  if (!isInteger(decimalParts(size.asDecimal()!))) {
    throw wrongKind('integer', size);
  }
  const asText = field === 'bytes as text';
  if (asText ? v.kind !== 'text' : v.kind !== 'bytes') {
    throw wrongKind(asText ? 'text' : 'bytes', v);
  }
  const body = asText ? utf8.encode(v.asText()!) : v.bytesView()!;
  if (BigInt(body.length) !== integerOf(decimalParts(size.asDecimal()!))) {
    throw outOfRange(field, v);
  }
  return join(sofar.bytesView()!, body);
};

/** A run of bit fields (`bytes-bits`), most significant bit first, in whole bytes. */
export const buildBits = (
  sofar: Value,
  values: readonly Value[],
  widths: readonly number[],
): Value => {
  let acc = 0n;
  let bits = 0;
  values.forEach((v, i) => {
    const w = widths[i]!;
    acc = (acc << BigInt(w)) | integerIn(v, `${w} bits`, w, false);
    bits += w;
  });
  const out = new Uint8Array(bits / 8);
  for (let i = out.length - 1; i >= 0; i--) {
    out[i] = Number(acc & 255n);
    acc >>= 8n;
  }
  return join(sofar.bytesView()!, out);
};

/** The bytes of a literal field: a number's one byte, or text's UTF-8. */
const literalBytes = (v: Value): Uint8Array | undefined => {
  if (v.kind === 'text') {
    return utf8.encode(v.asText()!);
  }
  const n = decimalParts(v.asDecimal()!);
  const i = isInteger(n) ? integerOf(n) : -1n;
  return i >= 0n && i <= 255n ? Uint8Array.of(Number(i)) : undefined;
};

/** `bin-literal`: whether the literal's bytes come next, reading past them. */
export const readLiteral = (r: Reader, v: Value): boolean => {
  const want = literalBytes(v);
  if (!want || r.at + want.length > r.bytes.length) {
    return false;
  }
  for (let i = 0; i < want.length; i++) {
    if (r.bytes[r.at + i] !== want[i]) {
      return false;
    }
  }
  r.at += want.length;
  return true;
};

/** `bin-int`: an integer field's value, or undefined when too few bytes are left. */
export const readInt = (r: Reader, field: string): Value | undefined => {
  const int = intField(field)!;
  if (r.at + int.size > r.bytes.length) {
    return undefined;
  }
  let n = 0n;
  for (let i = 0; i < int.size; i++) {
    const at = int.little ? r.at + int.size - 1 - i : r.at + i;
    n = (n << 8n) | BigInt(r.bytes[at]!);
  }
  r.at += int.size;
  const span = 1n << BigInt(int.size * 8);
  return integerValue(int.signed && n >= span / 2n ? n - span : n);
};

/** `bin-bits`: a run of bit fields' values, or undefined when too few bytes are left. */
export const readBits = (
  r: Reader,
  widths: readonly number[],
): Value[] | undefined => {
  const total = widths.reduce((a, b) => a + b, 0);
  const size = total / 8;
  if (r.at + size > r.bytes.length) {
    return undefined;
  }
  let acc = 0n;
  for (let i = 0; i < size; i++) {
    acc = (acc << 8n) | BigInt(r.bytes[r.at + i]!);
  }
  r.at += size;
  let left = total;
  return widths.map(w => {
    left -= w;
    return integerValue((acc >> BigInt(left)) & ((1n << BigInt(w)) - 1n));
  });
};

// Bytes as a field binds them: as Bytes, or decoded as `as text` decodes.
const asField = (b: Uint8Array, field: string): Value | undefined => {
  if (field !== 'bytes as text') {
    return bytesOf(b.slice());
  }
  const decoded = decodeUtf8(b);
  return decoded === undefined ? undefined : text(decoded);
};

/** `bin-bytes`: `size` bytes, or undefined when the size isn't an integer 0 or more, or too few are left. */
export const readBytes = (
  r: Reader,
  size: Value,
  field: string,
): Value | undefined => {
  if (size.kind !== 'number') {
    return undefined;
  }
  const d = decimalParts(size.asDecimal()!);
  if (!isInteger(d) || d.negative) {
    return undefined;
  }
  const n = integerOf(d);
  if (n > BigInt(r.bytes.length - r.at)) {
    return undefined;
  }
  const v = asField(r.bytes.subarray(r.at, r.at + Number(n)), field);
  if (v) {
    r.at += Number(n);
  }
  return v;
};

/** `bin-rest`: the bytes left, or undefined when they don't decode. */
export const readRest = (r: Reader, field: string): Value | undefined =>
  asField(r.bytes.subarray(r.at), field);
