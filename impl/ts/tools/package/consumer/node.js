// Node and Bun: every published subpath, including the server-only ./sqlite
// and ./http.
import * as http from '@northtalk/ts/http';
import * as sqlite from '@northtalk/ts/sqlite';
import { smoke } from './smoke.js';

if (Object.keys(sqlite).length === 0) {
  throw new Error('sqlite exports nothing');
}
if (typeof http.createHttpHost !== 'function') {
  throw new Error('http exports no createHttpHost');
}
console.log(await smoke());
