import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { readDisplay } from '../../src/index';
import { sessionQuotas } from '../../src/store/index';
import { runStoreKitSequence, storeKitSequences } from '../../tools/store-kit';
import { openSqliteStores } from './store';

const directories: string[] = [];
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), 'northtalk-store-'));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('the SQLite Store follows the store test kit', () => {
  for (const sequence of storeKitSequences()) {
    test(`${sequence.file}: ${sequence.name}`, () => {
      const opened: (() => void)[] = [];
      const directory = scratch();
      try {
        expect(
          runStoreKitSequence(quotas => {
            const { stores, close } = openSqliteStores(
              join(directory, 'kit.sqlite'),
              quotas,
            );
            opened.push(close);
            return stores;
          }, sequence),
        ).toBeUndefined();
      } finally {
        for (const close of opened) {
          close();
        }
      }
    });
  }
});

test('a Store outlives its database connection', () => {
  const path = join(scratch(), 'store.sqlite');
  const first = openSqliteStores(path, sessionQuotas);
  first.stores.replace('s', [
    ['b', readDisplay('2.50 GBP')],
    ['a', readDisplay('{x: [1, "two"], when: 2026-10-07}')],
  ]);
  first.close();
  const second = openSqliteStores(path, sessionQuotas);
  try {
    expect(second.stores.entries('s').map(([k, v]) => `${k}=${v}`)).toEqual([
      'a={x: [1, "two"], when: 2026-10-07}',
      'b=2.50 GBP',
    ]);
  } finally {
    second.close();
  }
});

test('only one connection holds the database', () => {
  const path = join(scratch(), 'store.sqlite');
  const first = openSqliteStores(path, sessionQuotas);
  try {
    expect(() => openSqliteStores(path, sessionQuotas)).toThrow();
  } finally {
    first.close();
  }
  openSqliteStores(path, sessionQuotas).close();
});

test('the example counts its runs', async () => {
  const path = join(scratch(), 'counter.sqlite');
  const main = join(import.meta.dir, 'main.ts');
  const first = await $`bun ${main} ${path}`.text();
  const second = await $`bun ${main} ${path}`.text();
  expect(first).toBe('Run 1, since the first run\n');
  expect(second).toBe('Run 2, since the first run\n');
});
