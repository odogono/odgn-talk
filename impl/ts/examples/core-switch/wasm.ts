// The core-switch Host on the Zig reactor. Only the import differs from ts.ts.
// eslint-disable-next-line import-x/no-namespace -- the Host takes the whole package.
import * as northtalk from '../../src/wasm/index';
import { runShop } from './host';

export const run = (wasm?: unknown) => runShop(northtalk, { wasm });
