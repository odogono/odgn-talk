// Counts its own runs in a SQLite Store, which outlives the process.
//   bun impl/ts/examples/store-sqlite/main.ts [database]
import { readFileSync } from 'node:fs';
import {
  consoleCapability,
  newGroup,
  parseInstant,
  storeCapability,
} from '../../src/index';
import { sessionQuotas } from '../../src/store/index';
import { openSqliteStores } from './store';

const path = process.argv[2] ?? 'store.sqlite';
const { stores, close } = openSqliteStores(path, sessionQuotas);
try {
  const costs = Object.fromEntries(
    ['get', 'set', 'delete', 'keys', 'increment', 'swap'].map(op => [
      op,
      { fuel: 4 },
    ]),
  );
  const group = newGroup({ name: 'counter' });
  const script = group.load({
    name: 'counter',
    source: readFileSync(new URL('count.talk', import.meta.url), 'utf8'),
    grants: {
      visits: storeCapability(stores, costs).grant('all', 'visits'),
      console: consoleCapability(
        {
          write: (_call, value) => console.log(value.asText()),
          read: () => {},
        },
        { write: { fuel: 0 }, read: { fuel: 0 } },
      ).grant(['write'], undefined),
    },
  });
  script.deliver({ name: 'start' });
  group.pump(parseInstant(new Date().toISOString()));
} finally {
  close();
}
