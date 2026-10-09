// Runs the sqlite test kit on node:sqlite in whichever runtime runs this
// file, bundled, so the implementation is held to the kit under Node and
// Deno as well as Bun. Reads the sequences as JSON from the path given, and
// prints each failure as a JSON line.
//   node sqlite-kit-runtime.js sequences.json
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openSqliteDatabase,
  sqliteDatabases,
  STORE_TABLE,
} from '../src/sqlite/index';
import { sessionQuotas } from '../src/store/index';
import { runSqliteKitSequence, type SqliteKitSequence } from './sqlite-kit';

const sequences = JSON.parse(
  readFileSync(process.argv[2]!, 'utf8'),
) as SqliteKitSequence[];
const directory = mkdtempSync(join(tmpdir(), 'northtalk-sqlite-kit-'));
let failed = 0;
try {
  for (const [i, sequence] of sequences.entries()) {
    const db = openSqliteDatabase(join(directory, `${i}.sqlite`), {
      stores: sessionQuotas,
    });
    const failure = runSqliteKitSequence(
      () => ({
        sqlite: sqliteDatabases({ app: db }),
        store: db.stores!,
        storeTable: STORE_TABLE,
        exec: sql => db.exec(sql),
        close: () => db.close(),
      }),
      sequence,
    );
    if (failure) {
      failed++;
      console.log(JSON.stringify({ sequence: sequence.name, ...failure }));
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log(
  `${sequences.length - failed} of ${sequences.length} sequences passed`,
);
process.exitCode = failed ? 1 : 0;
