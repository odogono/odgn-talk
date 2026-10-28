// The shared save format's primitives and frames (ADR 0144), checked against
// saves the Zig Core writes.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { HostError, type HostErrorCode } from '../src/errors';
import {
  type SaveSection,
  SaveReader,
  SaveWriter,
  readSave,
  saveSections,
  stateFingerprint,
  writeSave,
} from '../src/save-format';
import { sha256Bytes } from '../src/sha256';
// eslint-disable-next-line import-x/no-namespace -- the reactor's whole package.
import * as wasm from '../src/wasm/index';
import { artifact } from './reactor-artifact';

const hex = (s: string) => Uint8Array.from(Buffer.from(s.trim(), 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const rejects = (f: () => unknown, code: HostErrorCode = 'invalid save') => {
  let thrown: unknown;
  try {
    f();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(HostError);
  expect((thrown as HostError).code).toBe(code);
};

// `g.save()` from the Zig reactor, after loading
// `script variable n = [1, "two", 3.5]` with a `bump` handler; regenerate
// with the reactor's `Group.save` if the Zig writer's framing changes.
const zigSave = hex(
  readFileSync(new URL('fixtures/zig-save.hex', import.meta.url), 'utf8'),
);

describe('primitives', () => {
  const cases: [number | bigint, string][] = [
    [0, '00'],
    [1, '01'],
    [127, '7f'],
    [128, '8001'],
    [300, 'ac02'],
    [2 ** 49, '8080808080808001'],
    [Number.MAX_SAFE_INTEGER, 'ffffffffffffff0f'],
    [(1n << 64n) - 1n, 'ffffffffffffffffff01'],
  ];
  test('uint is LEB128 in its shortest form', () => {
    for (const [v, bytes] of cases) {
      expect(toHex(new SaveWriter().uint(v).finish()), String(v)).toBe(bytes);
      const r = new SaveReader(hex(bytes));
      expect(r.bigUint()).toBe(BigInt(v));
      r.end();
      if (typeof v === 'number') {
        expect(new SaveReader(hex(bytes)).uint()).toBe(v);
      }
    }
  });

  test('sint is signed LEB128 in its shortest form', () => {
    const signed: [number | bigint, string][] = [
      [0, '00'],
      [1, '01'],
      [-1, '7f'],
      [63, '3f'],
      [64, 'c000'],
      [-64, '40'],
      [-65, 'bf7f'],
      [-123_456, 'c0bb78'],
      [(1n << 63n) - 1n, 'ffffffffffffffffff00'],
      [-(1n << 63n), '8080808080808080807f'],
    ];
    for (const [v, bytes] of signed) {
      expect(toHex(new SaveWriter().sint(v).finish()), String(v)).toBe(bytes);
      const r = new SaveReader(hex(bytes));
      expect(r.bigSint()).toBe(BigInt(v));
      r.end();
    }
  });

  test('a longer LEB128 form than needed is invalid save', () => {
    for (const bytes of ['8000', '8100', '818000']) {
      rejects(() => new SaveReader(hex(bytes)).uint());
      rejects(() => new SaveReader(hex(bytes)).bigUint());
    }
    // 1 padded with a sign byte, -1 and -64 padded with one.
    for (const bytes of ['8100', 'ff7f', 'c07f']) {
      rejects(() => new SaveReader(hex(bytes)).sint());
    }
    // Past 64 bits, and past a safe integer for `uint`.
    rejects(() => new SaveReader(hex('ffffffffffffffffff02')).bigUint());
    rejects(() => new SaveReader(hex('8080808080808010')).uint());
    rejects(() => new SaveReader(hex('ffffffffffffffffff01')).bigSint());
  });

  test('bool, text, bytes, digest, ref, index, lists and optionals round-trip', () => {
    const d = sha256Bytes(new Uint8Array());
    const bytes = new SaveWriter()
      .bool(true)
      .bool(false)
      .text('é😀')
      .bytes(Uint8Array.of(1, 2))
      .digest(d)
      .ref(undefined)
      .ref(4)
      .index(2)
      .list([3, 400], (w, x) => w.uint(x))
      .optional(undefined, (w, x: string) => w.text(x))
      .optional('x', (w, x) => w.text(x))
      .finish();
    const r = new SaveReader(bytes);
    expect(r.bool()).toBe(true);
    expect(r.bool()).toBe(false);
    expect(r.text()).toBe('é😀');
    expect(r.bytes()).toEqual(Uint8Array.of(1, 2));
    expect(r.digest()).toEqual(d);
    expect(r.ref(5)).toBeUndefined();
    expect(r.ref(5)).toBe(4);
    expect(r.index(3)).toBe(2);
    expect(r.list(r => r.uint())).toEqual([3, 400]);
    expect(r.optional(r => r.text())).toBeUndefined();
    expect(r.optional(r => r.text())).toBe('x');
    r.end();
  });

  test('short, extra or impossible bytes are invalid save', () => {
    rejects(() => new SaveReader(hex('02')).bool());
    rejects(() => new SaveReader(hex('')).byte());
    rejects(() => new SaveReader(hex('80')).uint());
    rejects(() => new SaveReader(hex('0361')).text());
    rejects(() => new SaveReader(hex('01ff')).text());
    rejects(() => new SaveReader(hex('00'.repeat(31))).digest());
    rejects(() => new SaveReader(hex('05')).ref(4));
    rejects(() => new SaveReader(hex('04')).index(4));
    rejects(() => new SaveReader(hex('0500')).list(r => r.byte()));
    rejects(() => new SaveReader(hex('0000')).end());
  });
});

describe('frames', () => {
  test('a Zig save re-frames to the same bytes', () => {
    const read = readSave(zigSave);
    expect(read.language).toBe('1.0-rc.3');
    expect(read.sections.map(s => s.tag)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(read.body(saveSections.sources)).toBeDefined();
    expect(toHex(writeSave(read, read.sections))).toBe(toHex(zigSave));
    expect(stateFingerprint(zigSave)).toEqual(read.stateFingerprint);
  });

  test.skipIf(!existsSync(artifact))(
    'a fresh reactor save re-frames identically and agrees on its State Fingerprint',
    async () => {
      const core = await wasm.createCore({
        wasm: await WebAssembly.compile(readFileSync(artifact)),
        diagnostics: () => {},
      });
      const g = core.newGroup({ name: 'golden' });
      g.load({
        name: 's',
        source: 'script variable n = 0\non bump\n  add 1 to n\nend bump',
      });
      const bytes = g.save();
      const read = readSave(bytes);
      expect(toHex(writeSave(read, read.sections))).toBe(toHex(bytes));
      expect(stateFingerprint(bytes)).toEqual(core.stateFingerprint(bytes));
      expect(stateFingerprint(bytes)).toEqual(g.stateFingerprint());
    },
  );

  const header = {
    language: 'test',
    costModel: 3,
    groupFingerprint: new Uint8Array(32).fill(7),
    saveIdCounter: 2,
  };
  const required = (): SaveSection[] =>
    Array.from({ length: saveSections.accounting }, (_, i) => ({
      tag: i + 1,
      optional: false,
      body: Uint8Array.of(i),
    }));

  test('the State Fingerprint covers required sections only, the body digest every frame', () => {
    const plain = writeSave(header, required());
    const withExtra = writeSave(header, [
      ...required(),
      { tag: 200, optional: true, body: Uint8Array.of(9) },
    ]);
    expect(stateFingerprint(withExtra)).toEqual(stateFingerprint(plain));
    expect(readSave(withExtra).bodyDigest).not.toEqual(
      readSave(plain).bodyDigest,
    );
    // The save id counter is in the body digest but not the State Fingerprint.
    const later = writeSave({ ...header, saveIdCounter: 3 }, required());
    expect(stateFingerprint(later)).toEqual(stateFingerprint(plain));
  });

  test('an unknown optional section is skipped once its digest checks', () => {
    const bytes = writeSave(header, [
      ...required(),
      { tag: 200, optional: true, body: Uint8Array.of(9, 9) },
    ]);
    const read = readSave(bytes);
    expect(read.body(200)).toBeUndefined();
    expect(read.sections.at(-1)?.tag).toBe(200);
    // Corrupt its body: even a header-only read checks an unknown section.
    const bad = bytes.slice();
    bad[bad.length - 1] = 8;
    rejects(() => stateFingerprint(bad));
  });

  test('an unknown required section, a missing one, disorder or a mislabelled flag is invalid save', () => {
    rejects(() =>
      readSave(
        writeSave(header, [
          ...required(),
          { tag: 200, optional: false, body: new Uint8Array() },
        ]),
      ),
    );
    rejects(() => readSave(writeSave(header, required().slice(1))));
    const flagged = required();
    flagged[0]!.optional = true;
    rejects(() => readSave(writeSave(header, flagged)));
    expect(() => writeSave(header, required().reverse())).toThrow(RangeError);
  });

  test('a changed byte, short bytes, extra bytes or a bad digest is invalid save', () => {
    const bytes = writeSave(header, required());
    rejects(() => readSave(bytes.subarray(0, bytes.length - 1)));
    rejects(() => readSave(Uint8Array.of(...bytes, 0)));
    for (const at of [0, 6, 10, bytes.length - 1]) {
      const bad = bytes.slice();
      bad[at]! ^= 1;
      rejects(() => readSave(bad));
    }
    // A known section's body is checked by a full read, not a header-only one.
    const body = bytes.slice();
    const last = body.length - 1;
    body[last]! ^= 1;
    rejects(() => readSave(body));
    expect(stateFingerprint(body)).toEqual(stateFingerprint(bytes));
  });

  test('another format version is save mismatch', () => {
    const bytes = writeSave(header, required());
    const other = bytes.slice();
    other[4] = 2;
    rejects(() => readSave(other), 'save mismatch');
  });
});
