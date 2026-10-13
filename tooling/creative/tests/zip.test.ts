import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crc32, readZip, writeZip } from '../src/zip';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

test('CRC-32 matches the standard check value', () => {
  expect(crc32(bytes('123456789'))).toBe(0xcb_f4_39_26);
  expect(crc32(new Uint8Array())).toBe(0);
});

test('stored and deflated entries round-trip', async () => {
  const big = 'NorthTalk '.repeat(2000);
  const zip = await writeZip([
    { name: 'mimetype', data: bytes('example/type') },
    { name: 'big.txt', data: bytes(big), method: 8 },
    { name: 'assets/ünïcode.png', data: new Uint8Array([0, 1, 2, 255]) },
  ]);
  const entries = await readZip(zip);
  expect(text(entries.get('mimetype')!)).toBe('example/type');
  expect(text(entries.get('big.txt')!)).toBe(big);
  expect([...entries.get('assets/ünïcode.png')!]).toEqual([0, 1, 2, 255]);
});

test('a flipped byte in stored data fails the CRC-32 check', async () => {
  const zip = await writeZip([{ name: 'a.txt', data: bytes('hello world') }]);
  // The data follows the 30-byte local header and the 5-byte name.
  zip[35] = zip[35]! ^ 0xff;
  await expect(readZip(zip)).rejects.toThrow('CRC-32');
});

test('a truncated archive is refused', async () => {
  const zip = await writeZip([{ name: 'a.txt', data: bytes('hello') }]);
  await expect(readZip(zip.subarray(0, 20))).rejects.toThrow(
    'not a complete zip',
  );
  await expect(readZip(bytes('not a zip at all'))).rejects.toThrow(
    'not a complete zip',
  );
});

test('entries whose sizes follow their data (flag bit 3) read correctly', async () => {
  // Written by Python's zipfile to an unseekable stream, so every entry
  // carries a data descriptor and zeros in its local header's sizes.
  const zip = readFileSync(
    resolve(import.meta.dir, 'fixtures/data-descriptors.zip'),
  );
  const entries = await readZip(zip);
  expect(text(entries.get('stored.txt')!)).toBe('sizes follow the data');
  expect(text(entries.get('deflated.txt')!)).toBe('NorthTalk '.repeat(50));
});

test('two entries with one name are refused', async () => {
  const zip = await writeZip([
    { name: 'a.txt', data: bytes('one') },
    { name: 'a.txt', data: bytes('two') },
  ]);
  await expect(readZip(zip)).rejects.toThrow('two entries named "a.txt"');
});
