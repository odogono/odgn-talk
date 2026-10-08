import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { Database } from 'bun:sqlite';
import {
  newGroup,
  num,
  parseInstant,
  readDisplay,
  storeCapability,
} from '../../src/index';
import { sessionQuotas, Stores } from '../../src/store/index';
import { runStoreKitSequence, storeKitSequences } from '../../tools/store-kit';
import { openSqliteStores, sqliteBackend } from './store';

const costs = Object.fromEntries(
  ['get', 'set', 'delete', 'keys', 'increment', 'swap'].map(op => [
    op,
    { fuel: 4 },
  ]),
);

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

test('a Segment writing two Stores commits them in one transaction', () => {
  const db = new Database(join(scratch(), 'two.sqlite'), { strict: true });
  try {
    const stores = new Stores(sqliteBackend(db), sessionQuotas);
    const store = storeCapability(stores, costs);
    const group = newGroup({ name: 'g' });
    const script = group.load({
      name: 's',
      source:
        'on finishLevel points, level\n  ask scores to increment "total", points\n  ask progress to set "level", level\nend finishLevel',
      grants: {
        scores: store.grant('all', 'scores'),
        progress: store.grant('all', 'progress'),
      },
    });
    const finish = (points: number, level: number) => {
      script.deliver({ name: 'finishLevel', args: [num(points), num(level)] });
      return group
        .pump(parseInstant('2026-10-07T12:00:00Z'))
        .reports.find(r => r.kind === 'run end');
    };
    const rows = () =>
      db
        .query<{ key: string; name: string; value: string }, []>(
          'SELECT name, key, value FROM store ORDER BY name, key',
        )
        .all()
        .map(({ name, key, value }) => `${name}.${key}=${value}`);
    expect(finish(10, 1)).toMatchObject({ outcome: 'completed' });
    expect(rows()).toEqual(['progress.level=1', 'scores.total=10']);
    // SQLite refuses the second Store's row, so neither Store changes.
    db.run(
      "CREATE TRIGGER refuse BEFORE UPDATE ON store WHEN NEW.name = 'progress' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    expect(finish(5, 2)).toMatchObject({ outcome: 'effect failed' });
    expect(rows()).toEqual(['progress.level=1', 'scores.total=10']);
    expect(stores.entries('scores').map(([k, v]) => `${k}=${v}`)).toEqual([
      'total=10',
    ]);
  } finally {
    db.close();
  }
});
