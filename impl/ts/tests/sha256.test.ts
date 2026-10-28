import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Sha256, sha256, sha256Bytes } from '../src/sha256';

test('sha256 matches node:crypto across padding and the 32 MiB length word', () => {
  // From 2^25 bytes the bit length no longer fits in the low length word.
  for (const length of [0, 1, 55, 56, 63, 64, 65, 2 ** 25 - 1, 2 ** 25]) {
    const input = 'x'.repeat(length);
    expect(sha256(input), `${length} bytes`).toBe(
      createHash('sha256').update(input).digest('hex'),
    );
  }
  const mixed = 'é😀\u0000'.repeat(100);
  expect(sha256(mixed)).toBe(createHash('sha256').update(mixed).digest('hex'));
});

test('Sha256 meets the FIPS 180-4 vectors, in any split of its input', () => {
  const vectors: [string, string][] = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
  ];
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  for (const [input, digest] of vectors) {
    const bytes = new TextEncoder().encode(input);
    expect(hex(sha256Bytes(bytes))).toBe(digest);
    for (let split = 0; split <= bytes.length; split += 7) {
      const h = new Sha256()
        .update(bytes.subarray(0, split))
        .update(bytes.subarray(split));
      expect(hex(h.final()), `${input} at ${split}`).toBe(digest);
    }
  }
  // A million 'a's, fed a byte-unaligned chunk at a time.
  const a = new Uint8Array(1_000_000).fill(0x61);
  const h = new Sha256();
  for (let at = 0; at < a.length; at += 4099) {
    h.update(a.subarray(at, at + 4099));
  }
  expect(hex(h.final())).toBe(
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  );
});

test('Sha256 refuses input after final', () => {
  const h = new Sha256();
  h.final();
  expect(() => h.update(new Uint8Array(1))).toThrow();
  expect(() => h.final()).toThrow();
});
