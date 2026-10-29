// The save format both Cores share (ADR 0144, chapter 10 "The save format",
// spec/data/save-format.toml): its primitives, header and section frames,
// and the digests over them. It knows sections only by tag; what a section
// holds is its caller's.
import { HostError } from './errors';
import { Sha256, sha256Bytes } from './sha256';

export const saveMagic = 'NTSV';
/** The save format this Core reads and writes; it reads no other. */
export const saveFormat = 1;

/** The sections, by tag. Every one but `sources` is required. */
export const saveSections = {
  texts: 1,
  group: 2,
  libraries: 3,
  objects: 4,
  functions: 5,
  calls: 6,
  scripts: 7,
  runs: 8,
  work: 9,
  waits: 10,
  inputs: 11,
  decisions: 12,
  accounting: 13,
  sources: 14,
} as const;
const lastRequired = saveSections.accounting;
const isKnown = (tag: number) => tag >= 1 && tag <= saveSections.sources;
const isOptionalKnown = (tag: number) => tag === saveSections.sources;

const invalid = (): never => {
  throw new HostError('invalid save');
};

const magicBytes = new TextEncoder().encode(saveMagic);
const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const u64Max = (1n << 64n) - 1n;
const i64Min = -(1n << 63n);
const i64Max = (1n << 63n) - 1n;

// ---------------------------------------------------------------- primitives

/**
 * The `texts` table being written: each distinct text once, numbered in
 * the order the writer first meets it.
 */
export class TextTable {
  readonly texts: string[] = [];
  private seen = new Map<string, number>();

  /** `start` are texts already numbered, in order. */
  constructor(start: readonly string[] = []) {
    for (const s of start) {
      this.add(s);
    }
  }

  add(s: string): number {
    let i = this.seen.get(s);
    if (i === undefined) {
      i = this.texts.length;
      this.seen.set(s, i);
      this.texts.push(s);
    }
    return i;
  }
}

/** Bytes being written, in the format's primitives. */
export class SaveWriter {
  private buffer = new Uint8Array(256);
  private length = 0;

  /** `names` is the save's `texts` table, which `name` adds to. */
  constructor(readonly names?: TextTable) {}

  /** A text, as its position in the `texts` table. */
  name(s: string): this {
    return this.uint(this.names!.add(s));
  }

  private reserve(n: number): void {
    if (this.length + n <= this.buffer.length) {
      return;
    }
    let size = this.buffer.length * 2;
    while (size < this.length + n) {
      size *= 2;
    }
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  byte(b: number): this {
    this.reserve(1);
    this.buffer[this.length++] = b & 0xff;
    return this;
  }

  /** An unsigned LEB128 integer, in its shortest form. */
  uint(v: number | bigint): this {
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) || v < 0) {
        throw new RangeError(`uint out of range: ${v}`);
      }
      while (v >= 0x80) {
        this.byte((v % 0x80) | 0x80);
        v = Math.floor(v / 0x80);
      }
      return this.byte(v);
    }
    if (v < 0n || v > u64Max) {
      throw new RangeError(`uint out of range: ${v}`);
    }
    while (v >= 0x80n) {
      this.byte(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    return this.byte(Number(v));
  }

  /** A signed LEB128 integer, in its shortest form. */
  sint(v: number | bigint): this {
    if (typeof v === 'number' && !Number.isSafeInteger(v)) {
      throw new RangeError(`sint out of range: ${v}`);
    }
    let x = BigInt(v);
    if (x < i64Min || x > i64Max) {
      throw new RangeError(`sint out of range: ${v}`);
    }
    for (;;) {
      const low = Number(x & 0x7fn);
      x >>= 7n;
      if (
        (x === 0n && (low & 0x40) === 0) ||
        (x === -1n && (low & 0x40) !== 0)
      ) {
        return this.byte(low);
      }
      this.byte(low | 0x80);
    }
  }

  /** An unsigned LEB128 integer of any size, such as a Number's coefficient. */
  wideUint(v: bigint): this {
    if (v < 0n) {
      throw new RangeError(`uint out of range: ${v}`);
    }
    while (v >= 0x80n) {
      this.byte(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    return this.byte(Number(v));
  }

  /** A signed LEB128 integer of any size, such as a far deadline. */
  wideSint(v: bigint): this {
    for (;;) {
      const low = Number(v & 0x7fn);
      v >>= 7n;
      if (
        (v === 0n && (low & 0x40) === 0) ||
        (v === -1n && (low & 0x40) !== 0)
      ) {
        return this.byte(low);
      }
      this.byte(low | 0x80);
    }
  }

  bool(b: boolean): this {
    return this.byte(b ? 1 : 0);
  }

  /** Bytes whose length an earlier field gives. */
  raw(bytes: Uint8Array): this {
    this.reserve(bytes.length);
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
    return this;
  }

  bytes(bytes: Uint8Array): this {
    return this.uint(bytes.length).raw(bytes);
  }

  text(s: string): this {
    return this.bytes(utf8.encode(s));
  }

  digest(d: Uint8Array): this {
    if (d.length !== 32) {
      throw new RangeError(`a digest is 32 bytes, not ${d.length}`);
    }
    return this.raw(d);
  }

  /** A position in a list this save already holds. */
  index(i: number): this {
    return this.uint(i);
  }

  /** 0 for none, or a position plus 1. */
  ref(i: number | undefined): this {
    return this.uint(i === undefined ? 0 : i + 1);
  }

  list<T>(items: readonly T[], each: (w: this, item: T) => void): this {
    this.uint(items.length);
    for (const item of items) {
      each(this, item);
    }
    return this;
  }

  optional<T>(item: T | undefined, each: (w: this, item: T) => void): this {
    this.bool(item !== undefined);
    if (item !== undefined) {
      each(this, item);
    }
    return this;
  }

  /** The bytes written so far, as a copy. */
  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/**
 * A save, or a section's body, being read. Every read is checked, so bytes
 * that run short or say something impossible are `invalid save`.
 */
export class SaveReader {
  pos = 0;

  /** `names` is the save's `texts` table, which `name` reads from. */
  constructor(
    readonly input: Uint8Array,
    readonly names: readonly string[] = [],
  ) {}

  /** A text, by its position in the `texts` table. */
  name(): string {
    return this.names[this.index(this.names.length)]!;
  }

  /** A byte enum's value below `n`. */
  enumByte(n: number): number {
    const b = this.byte();
    return b < n ? b : invalid();
  }

  get remaining(): number {
    return this.input.length - this.pos;
  }

  byte(): number {
    if (this.pos >= this.input.length) {
      invalid();
    }
    return this.input[this.pos++]!;
  }

  /** `n` bytes, borrowed from the input. */
  raw(n: number): Uint8Array {
    if (n > this.remaining) {
      invalid();
    }
    this.pos += n;
    return this.input.subarray(this.pos - n, this.pos);
  }

  /** An unsigned LEB128 integer of at most 64 bits, in its shortest form. */
  bigUint(): bigint {
    let out = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.byte();
      out |= BigInt(b & 0x7f) << shift;
      if (out > u64Max) {
        invalid();
      }
      if ((b & 0x80) === 0) {
        // A last byte of 0 after others is a longer form than needed.
        if (b === 0 && shift > 0n) {
          invalid();
        }
        return out;
      }
      shift += 7n;
    }
  }

  /** An unsigned LEB128 integer below 2^`bits`, in its shortest form. */
  wideUint(bits: number): bigint {
    let out = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.byte();
      out |= BigInt(b & 0x7f) << shift;
      if (out >> BigInt(bits) !== 0n) {
        invalid();
      }
      if ((b & 0x80) === 0) {
        if (b === 0 && shift > 0n) {
          invalid();
        }
        return out;
      }
      shift += 7n;
    }
  }

  /** A signed LEB128 integer within ±2^`bits`, in its shortest form. */
  wideSint(bits: number): bigint {
    let out = 0n;
    let shift = 0n;
    let b = 0;
    let prev = 0;
    do {
      if (shift > BigInt(bits) + 7n) {
        invalid();
      }
      prev = b;
      b = this.byte();
      out |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while ((b & 0x80) !== 0);
    if ((b & 0x40) !== 0) {
      out -= 1n << shift;
    }
    if (
      shift > 7n &&
      ((b === 0 && (prev & 0x40) === 0) || (b === 0x7f && (prev & 0x40) !== 0))
    ) {
      invalid();
    }
    const limit = 1n << BigInt(bits);
    return out < -limit || out >= limit ? invalid() : out;
  }

  /** An unsigned LEB128 integer that fits a safe JS integer. */
  uint(): number {
    // The common case, up to 2^49, without a bigint.
    let out = 0;
    let scale = 1;
    for (let i = 0; i < 7; i++) {
      const b = this.byte();
      out += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) {
        if (b === 0 && i > 0) {
          invalid();
        }
        return out;
      }
      scale *= 0x80;
    }
    this.pos -= 7;
    const v = this.bigUint();
    return v > BigInt(Number.MAX_SAFE_INTEGER) ? invalid() : Number(v);
  }

  /** A signed LEB128 integer of at most 64 bits, in its shortest form. */
  bigSint(): bigint {
    let out = 0n;
    let shift = 0n;
    let b = 0;
    let prev = 0;
    do {
      if (shift >= 70n) {
        invalid();
      }
      prev = b;
      b = this.byte();
      out |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while ((b & 0x80) !== 0);
    if ((b & 0x40) !== 0) {
      out -= 1n << shift;
    }
    // A last byte that only repeats the previous byte's sign is a longer
    // form than needed.
    if (
      shift > 7n &&
      ((b === 0 && (prev & 0x40) === 0) || (b === 0x7f && (prev & 0x40) !== 0))
    ) {
      invalid();
    }
    return out < i64Min || out > i64Max ? invalid() : out;
  }

  /** A signed LEB128 integer that fits a safe JS integer. */
  sint(): number {
    const v = this.bigSint();
    return v < BigInt(Number.MIN_SAFE_INTEGER) ||
      v > BigInt(Number.MAX_SAFE_INTEGER)
      ? invalid()
      : Number(v);
  }

  bool(): boolean {
    const b = this.byte();
    return b === 0 ? false : b === 1 ? true : invalid();
  }

  /** A count of things each at least one byte long, so it can't promise more than the input holds. */
  count(): number {
    const n = this.uint();
    return n > this.remaining ? invalid() : n;
  }

  bytes(): Uint8Array {
    return this.raw(this.count());
  }

  text(): string {
    try {
      return strictUtf8.decode(this.bytes());
    } catch (error) {
      if (error instanceof HostError) {
        throw error;
      }
      return invalid();
    }
  }

  digest(): Uint8Array {
    return this.raw(32);
  }

  /** A position below `n`. */
  index(n: number): number {
    const v = this.uint();
    return v >= n ? invalid() : v;
  }

  /** None, or a position below `n`. */
  ref(n: number): number | undefined {
    const v = this.uint();
    return v === 0 ? undefined : v - 1 >= n ? invalid() : v - 1;
  }

  list<T>(each: (r: this) => T): T[] {
    const n = this.count();
    const out: T[] = [];
    for (let i = 0; i < n; i++) {
      out.push(each(this));
    }
    return out;
  }

  optional<T>(each: (r: this) => T): T | undefined {
    return this.bool() ? each(this) : undefined;
  }

  /** The end of the input, which its fields must account for. */
  end(): void {
    if (this.pos !== this.input.length) {
      invalid();
    }
  }
}

// ---------------------------------------------------------------- frames

/** The header fields a writer chooses. */
export type SaveHeader = {
  costModel: number;
  groupFingerprint: Uint8Array;
  language: string;
  saveIdCounter: number;
};

export type SaveSection = { body: Uint8Array; optional: boolean; tag: number };

/** A section as read: its frame, and its body borrowed from the save. */
export type FramedSection = SaveSection & { digest: Uint8Array };

export type ReadSave = SaveHeader & {
  /** A known section's body, by tag. */
  body(tag: number): Uint8Array | undefined;
  bodyDigest: Uint8Array;
  /** Every section in tag order, unknown optional ones included. */
  sections: FramedSection[];
  stateFingerprint: Uint8Array;
};

const headerFields = (w: SaveWriter, h: SaveHeader) =>
  w
    .raw(magicBytes)
    .uint(saveFormat)
    .text(h.language)
    .uint(h.costModel)
    .digest(h.groupFingerprint)
    .uint(h.saveIdCounter);

/** The State Fingerprint: each required section's tag byte and digest, in tag order. */
const stateOf = (sections: readonly FramedSection[]) => {
  const state = new Sha256();
  for (const s of sections) {
    if (!s.optional) {
      state.update(Uint8Array.of(s.tag)).update(s.digest);
    }
  }
  return state.final();
};

/** The body digest: the header bytes before it, then each section's tag, flags and digest. */
const bodyDigestOf = (
  header: Uint8Array,
  sections: readonly FramedSection[],
) => {
  const body = new Sha256().update(header);
  for (const s of sections) {
    body.update(Uint8Array.of(s.tag, s.optional ? 1 : 0)).update(s.digest);
  }
  return body.final();
};

/**
 * A save's bytes: the header, then each section framed, in ascending tag
 * order. Each body is hashed once, and the State Fingerprint and body digest
 * come from those digests.
 */
export const writeSave = (
  header: SaveHeader,
  sections: readonly SaveSection[],
): Uint8Array => {
  const framed: FramedSection[] = [];
  let last = 0;
  for (const s of sections) {
    if (!Number.isInteger(s.tag) || s.tag <= last || s.tag > 255) {
      throw new RangeError(
        `sections must come in ascending tag order: ${s.tag}`,
      );
    }
    last = s.tag;
    framed.push({ ...s, digest: sha256Bytes(s.body) });
  }
  const w = headerFields(new SaveWriter(), header).digest(stateOf(framed));
  w.digest(bodyDigestOf(w.finish(), framed));
  return w
    .list(framed, (w, s) =>
      w
        .byte(s.tag)
        .bool(s.optional)
        .uint(s.body.length)
        .digest(s.digest)
        .raw(s.body),
    )
    .finish();
};

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Reads a save's header and section frames, checking the body digest and
 * that the State Fingerprint matches the section digests. A known section's
 * body is hashed only when `bodies` is set; an unknown optional one always
 * is, and then skipped. Another magic is `invalid save`; this magic at
 * another format version is `save mismatch`.
 */
const readFrames = (bytes: Uint8Array, bodies: boolean): ReadSave => {
  const r = new SaveReader(bytes);
  if (!sameBytes(r.raw(magicBytes.length), magicBytes)) {
    invalid();
  }
  if (r.uint() !== saveFormat) {
    throw new HostError('save mismatch');
  }
  const language = r.text();
  const costModel = r.uint();
  const groupFingerprint = r.digest();
  const saveIdCounter = r.uint();
  const stateFingerprint = r.digest();
  const headerEnd = r.pos;
  const bodyDigest = r.digest();
  const sections: FramedSection[] = [];
  const known = new Map<number, Uint8Array>();
  let last = 0;
  const n = r.count();
  for (let i = 0; i < n; i++) {
    const tag = r.byte();
    const flags = r.byte();
    const length = r.count();
    const digest = r.digest();
    if (tag <= last || flags > 1) {
      invalid();
    }
    last = tag;
    const optional = flags === 1;
    // A known section's flag must say what it is; an unknown required one
    // can't be read.
    if (isKnown(tag) ? optional !== isOptionalKnown(tag) : !optional) {
      invalid();
    }
    const body = r.raw(length);
    if ((bodies || !isKnown(tag)) && !sameBytes(sha256Bytes(body), digest)) {
      invalid();
    }
    if (isKnown(tag)) {
      known.set(tag, body);
    }
    sections.push({ tag, optional, body, digest });
  }
  r.end();
  for (let tag = 1; tag <= lastRequired; tag++) {
    if (!known.has(tag)) {
      invalid();
    }
  }
  if (
    !sameBytes(
      bodyDigestOf(bytes.subarray(0, headerEnd), sections),
      bodyDigest,
    ) ||
    !sameBytes(stateOf(sections), stateFingerprint)
  ) {
    invalid();
  }
  return {
    language,
    costModel,
    groupFingerprint,
    saveIdCounter,
    stateFingerprint,
    bodyDigest,
    sections,
    body: tag => known.get(tag),
  };
};

/** A save's header and every section, each body's digest checked. */
export const readSave = (bytes: Uint8Array): ReadSave =>
  readFrames(bytes, true);

/**
 * A save's State Fingerprint (ADR 0142), read from its header and frames
 * without hashing its known sections' bodies, once the body digest checks.
 */
export const stateFingerprint = (bytes: Uint8Array): Uint8Array =>
  readFrames(bytes, false).stateFingerprint;
