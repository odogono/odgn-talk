// Node and Bun: every published subpath, including the server-only ./sqlite.
import * as sqlite from '@northtalk/ts/sqlite';
import { smoke } from './smoke.js';

if (Object.keys(sqlite).length === 0) {
  throw new Error('sqlite exports nothing');
}
console.log(await smoke());
