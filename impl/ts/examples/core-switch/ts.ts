// The core-switch Host on the TS Core.
// eslint-disable-next-line import-x/no-namespace -- the Host takes the whole package.
import * as northtalk from '../../src/index';
import { runShop } from './host';

export const run = () => runShop(northtalk);
