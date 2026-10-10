import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { sha256 } from '../src/sha256';

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
